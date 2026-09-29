import test from 'node:test';
import assert from 'node:assert/strict';
import { createBatchAssignmentRunner, ASSIGNMENT_BATCH_STORAGE_KEY } from './batchAssignmentRunner.js';

const copy = (value) => structuredClone(value);
const card = (key, kind = 'code', status = 'unfinished') => ({ key, title: key, kind, status, descriptor: { title: key } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(items = [card('one'), card('two', 'notebook')]) {
  const memory = {};
  const events = [];
  let singleState = {};
  let sequence = 10;
  const dependencies = {
    storage: { get: async () => copy(memory), set: async (value) => { Object.assign(memory, copy(value)); }, remove: async (key) => { delete memory[key]; } },
    makeId: () => 'batch-1',
    catalog: {
      scan: async () => ({ isCatalog: true, complete: true, currentUrl: 'https://my.newtonschool.co/course/course-1/all_assignments', items: copy(items) }),
      open: async (_tabId, item, options) => {
        assert.equal(memory[ASSIGNMENT_BATCH_STORAGE_KEY].pendingEffect, 'open');
        events.push(`open:${item.key}`);
        const tabId = ++sequence;
        await options.onOwnedTab({ tabId, ownershipId: options.ownershipId, role: 'workspace', url: `https://my.newtonschool.co/playground/code/${item.key}` });
        return { success: true, workspaceTabId: tabId };
      },
      closeOwnedTab: async (owned, ownershipId) => {
        assert.equal(memory[ASSIGNMENT_BATCH_STORAGE_KEY].pendingEffect, 'close_tab');
        assert.equal(owned.ownershipId, ownershipId);
        events.push(`close:${owned.tabId}`);
        return { success: true };
      },
    },
    singleRunner: {
      action: async (name, payload) => {
        assert.equal(name, 'solve');
        const saved = memory[ASSIGNMENT_BATCH_STORAGE_KEY];
        assert.equal(saved.phase, 'solving');
        assert.equal(saved.pendingEffect, 'solve');
        assert.equal(saved.workspaceTabId, payload.tabId);
        assert.equal(saved.ownedTabs.length, 1);
        events.push(`solve:${saved.activeItemKey}`);
        items.find((item) => item.key === saved.activeItemKey).status = 'completed';
        singleState = { job: { id: `job-${saved.activeItemKey}`, context: { tabId: payload.tabId }, phase: 'accepted', submission: { status: 'accepted', success: true } } };
        return copy(singleState);
      },
      getState: async () => copy(singleState),
      stop: async () => { events.push('stop-single'); },
    },
  };
  return { runner: createBatchAssignmentRunner(dependencies), dependencies, memory, events, items,
    setSingleState: (value) => { singleState = value; } };
}

test('batch checkpoints each effect and solves supported assignments sequentially', async () => {
  const f = fixture([card('done', 'code', 'completed'), card('one'), card('other', 'unsupported'), card('two', 'notebook')]);
  const result = await f.runner.start({ tabId: 1, apiKey: 'never-store-this', model: 'model', maxTokens: 3000 });
  assert.deepEqual(f.events, ['open:one', 'solve:one', 'close:11', 'open:two', 'solve:two', 'close:12']);
  assert.equal(result.batch.phase, 'completed');
  assert.deepEqual(result.batch.completedKeys, ['one', 'two']);
  assert.equal(result.batch.skipped[0].key, 'other');
  assert.equal(JSON.stringify(f.memory).includes('never-store-this'), false);
});

test('ambiguous cards pause before opening any workspace', async () => {
  const f = fixture([card('one'), card('unclear', 'code', 'ambiguous')]);
  await assert.rejects(f.runner.start({ tabId: 1 }), /ambiguous/);
  assert.deepEqual(f.events, []);
});

test('acknowledged submissions pending grades continue and are not replayed on another start', async () => {
  const f = fixture();
  f.dependencies.singleRunner.action = async (_name, payload) => {
    f.events.push(`submitted:${payload.tabId}`);
    return { job: { submission: { status: 'submitted', success: true } } };
  };
  const result = await f.runner.start({ tabId: 1 });
  assert.deepEqual(result.batch.results.map((item) => item.status), ['submitted', 'submitted']);
  const dispatchCount = f.events.length;
  await f.runner.start({ tabId: 1 });
  assert.equal(f.events.length, dispatchCount);
});

test('unknown submit pauses, worker reload never dispatches, and recovery requires acknowledgement', async () => {
  const f = fixture();
  f.dependencies.singleRunner.action = async () => ({ job: { recovery: { required: true }, submission: { status: 'unknown' } } });
  await assert.rejects(f.runner.start({ tabId: 1 }), /acknowledged/);
  assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].results[0].status, 'unknown');
  assert.equal(f.events.filter((event) => event.startsWith('open:')).length, 1);
  const reloaded = createBatchAssignmentRunner(f.dependencies);
  assert.equal((await reloaded.getState()).batch.phase, 'needs_reconciliation');
  const count = f.events.length;
  await assert.rejects(reloaded.recover(), /no verified completion/);
  assert.equal(f.events.length, count);
  const owned = f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].workspaceTabId;
  f.setSingleState({ job: { id: 'recovered', context: { tabId: owned }, submission: { success: true, status: 'submitted' }, recovery: { required: false } } });
  const reconciled = await reloaded.recover();
  assert.equal(reconciled.batch.recovery.required, false);
  assert.equal(reconciled.batch.results[0].status, 'submitted');
  assert.equal(reconciled.batch.results.length, 1);
  assert.equal(reconciled.batch.error, null);
});

test('unrelated recovered single job cannot clear unknown submission', async () => {
  const f = fixture();
  f.dependencies.singleRunner.action = async () => ({ job: {} });
  await assert.rejects(f.runner.start({ tabId: 1 }));
  f.setSingleState({ job: { context: { tabId: 999 }, submission: { success: true, status: 'accepted' } } });
  await assert.rejects(f.runner.recover(), /no verified completion/);
});

test('stop during owned tab checkpoint prevents solver dispatch and does not close a tab', async () => {
  const f = fixture();
  f.dependencies.catalog.open = async (_tabId, _item, { onOwnedTab, ownershipId }) => {
    await onOwnedTab({ tabId: 99, ownershipId, url: 'owned' });
    await f.runner.stop();
    return { success: true, workspaceTabId: 99 };
  };
  await assert.rejects(f.runner.start({ tabId: 1 }), /stopped/);
  assert.deepEqual(f.events, []);
  assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].ownedTabs[0].tabId, 99);
});

test('stop targets only the owned single solve and prevents subsequent assignments', async () => {
  const f = fixture();
  const started = deferred();
  const finish = deferred();
  f.dependencies.singleRunner.action = async () => { started.resolve(); await finish.promise; return { job: { submission: { status: 'submitted', success: true } } }; };
  const running = f.runner.start({ tabId: 1 });
  await started.promise;
  await f.runner.stop();
  finish.resolve();
  await assert.rejects(running, /stopped/);
  assert.equal(f.events.includes('stop-single'), true);
  assert.equal(f.events.filter((event) => event.startsWith('open:')).length, 1);
  assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].results[0].status, 'submitted');
});

test('unsupported no-href workspaces are recorded and skipped without a solver request', async () => {
  const f = fixture([card('unsupported-popup', 'unresolved'), card('one')]);
  const original = f.dependencies.catalog.open;
  f.dependencies.catalog.open = async (tabId, item, options) => item.key === 'unsupported-popup'
    ? { success: false, status: 'unsupported', reason: 'Unsupported workspace.' } : original(tabId, item, options);
  const result = await f.runner.start({ tabId: 1 });
  assert.equal(result.batch.results[0].status, 'skipped');
  assert.equal(f.events.includes('solve:unsupported-popup'), false);
  assert.equal(f.events.includes('solve:one'), true);
});

test('known exhausted check failure is retained for review and the next assignment runs', async () => {
  const f = fixture();
  const original = f.dependencies.singleRunner.action;
  f.dependencies.singleRunner.action = async (name, payload) => {
    if (payload.tabId !== 11) return original(name, payload);
    f.setSingleState({ job: { id: 'failed-job', context: { tabId: payload.tabId }, failure: { known: true, kind: 'checks', message: 'Repair limit reached.' }, recovery: { required: false } } });
    throw new Error('Repair limit reached.');
  };
  const result = await f.runner.start({ tabId: 1 });
  assert.deepEqual(result.batch.results.map((item) => item.status), ['failed', 'accepted']);
  assert.equal(result.batch.retainedTabs[0].tabId, 11);
  assert.equal(f.events.includes('close:11'), false);
  assert.equal(f.events.includes('solve:two'), true);
});

test('quota/auth or uncertain failures pause without opening the next assignment', async () => {
  for (const [kind, status] of [['quota', 429], ['auth', 401], ['unknown', null]]) {
    const f = fixture();
    f.dependencies.singleRunner.action = async (_name, payload) => {
      f.setSingleState({ job: { context: { tabId: payload.tabId }, failure: { known: kind !== 'unknown', kind } } });
      throw Object.assign(new Error(kind), { status });
    };
    await assert.rejects(f.runner.start({ tabId: 1 }), new RegExp(kind));
    assert.equal(f.events.filter((event) => event.startsWith('open:')).length, 1);
    assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].recovery.required, true);
  }
});

test('storage failure prevents a workspace open', async () => {
  const f = fixture();
  f.dependencies.storage.set = async () => { throw new Error('storage full'); };
  const runner = createBatchAssignmentRunner(f.dependencies);
  await assert.rejects(runner.start({ tabId: 1 }), /storage full/);
  assert.deepEqual(f.events, []);
});

test('interrupted open reconciles without requiring submission and clears its provisional result', async () => {
  const f = fixture();
  f.dependencies.catalog.open = async (_tabId, _item, { onOwnedTab, ownershipId }) => {
    await onOwnedTab({ tabId: 77, ownershipId, url: 'owned' });
    throw new Error('Card did not load');
  };
  await assert.rejects(f.runner.start({ tabId: 1 }), /did not load/);
  assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].results[0].status, 'unknown');
  const reconciled = await f.runner.recover();
  assert.equal(reconciled.batch.recovery.required, false);
  assert.equal(reconciled.batch.results.length, 0);
  assert.equal(reconciled.batch.ownedTabs.length, 0);
  assert.equal(f.events.includes('solve:one'), false);
});

test('a closed catalog tab can be replaced by the same course during recovery', async () => {
  const f = fixture([card('one')]);
  f.dependencies.getTab = async () => { throw new Error('No tab with id: 1'); };
  f.dependencies.catalog.scan = async (tabId) => ({ isCatalog: true, complete: tabId === 2,
    currentUrl: 'https://my.newtonschool.co/course/course-1/all_assignments',
    items: tabId === 2 ? [card('one')] : [], reason: tabId === 2 ? null : 'Cards are still loading.' });
  const runner = createBatchAssignmentRunner(f.dependencies);
  await assert.rejects(runner.start({ tabId: 1 }), /Cards are still loading/);
  const recovered = await runner.recover({ tabId: 2 });
  assert.equal(recovered.batch.catalogTabId, 2);
  assert.equal(recovered.batch.phase, 'stopped');
  assert.equal(recovered.batch.recovery.required, false);
  assert.deepEqual(f.events, []);
});

test('a replacement catalog must belong to the saved course', async () => {
  const f = fixture([card('one')]);
  f.dependencies.getTab = async () => { throw new Error('No tab with id: 1'); };
  f.dependencies.catalog.scan = async (tabId) => ({ isCatalog: true, complete: tabId === 2,
    currentUrl: `https://my.newtonschool.co/course/${tabId === 2 ? 'other' : 'course-1'}/all_assignments`,
    items: tabId === 2 ? [card('one')] : [], reason: tabId === 2 ? null : 'Cards are still loading.' });
  const runner = createBatchAssignmentRunner(f.dependencies);
  await assert.rejects(runner.start({ tabId: 1 }), /Cards are still loading/);
  await assert.rejects(runner.recover({ tabId: 2 }), /same course/);
  assert.equal((await runner.getState()).batch.catalogTabId, 1);
});

test('replacing a closed catalog never replays an uncertain submission', async () => {
  const f = fixture([card('one')]);
  f.dependencies.getTab = async () => { throw new Error('No tab with id: 1'); };
  let requests = 0;
  f.dependencies.singleRunner.action = async () => { requests++; return { job: { recovery: { required: true }, submission: { status: 'unknown' } } }; };
  const runner = createBatchAssignmentRunner(f.dependencies);
  await assert.rejects(runner.start({ tabId: 1 }), /acknowledged/);
  assert.equal(requests, 1);
  await assert.rejects(runner.recover({ tabId: 2 }), /no verified completion/);
  assert.equal(requests, 1);
  assert.equal((await runner.getState()).batch.recovery.required, true);
});

test('expiration does not erase an uncertain submission checkpoint', async () => {
  const f = fixture();
  f.dependencies.singleRunner.action = async () => ({ job: {} });
  await assert.rejects(f.runner.start({ tabId: 1 }));
  f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].expiresAt = 1;
  const reloaded = createBatchAssignmentRunner(f.dependencies);
  assert.equal((await reloaded.getState()).batch.recovery.required, true);
  await assert.rejects(reloaded.start({ tabId: 1 }), /no verified completion/);
});

test('busy guard rejects overlapping batch or single actions', async () => {
  const f = fixture();
  f.dependencies.isOtherBusy = () => true;
  await assert.rejects(createBatchAssignmentRunner(f.dependencies).start({ tabId: 1 }), /active/);
  f.dependencies.isOtherBusy = () => false;
  f.dependencies.singleRunner.busy = true;
  await assert.rejects(createBatchAssignmentRunner(f.dependencies).start({ tabId: 1 }), /active/);
});

test('unique Next pages advance sequentially with durable intent and preserve handled keys', async () => {
  const f = fixture([card('one'), card('two')]);
  let page = 0;
  const read = () => ({ isCatalog: true, complete: true,
    currentUrl: `https://my.newtonschool.co/course/course-1/all_assignments?page=${page + 1}`,
    items: copy([f.items[page]]), hasNextPage: page === 0, pageFingerprint: `page-${page}` });
  f.dependencies.catalog.scan = async () => read();
  f.dependencies.catalog.nextPage = async () => {
    assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].pendingEffect, 'next_page');
    assert.equal(f.memory[ASSIGNMENT_BATCH_STORAGE_KEY].paginationFrom.fingerprint, 'page-0');
    page++;
    return { success: true, catalog: read() };
  };
  const result = await f.runner.start({ tabId: 1 });
  assert.deepEqual(result.batch.completedKeys, ['one', 'two']);
  assert.equal(result.batch.items.length, 2);
  assert.deepEqual(f.events.filter((event) => event.startsWith('solve:')), ['solve:one', 'solve:two']);
});

test('pagination without new card identities stops without solving the old page again', async () => {
  const f = fixture([card('one')]);
  const scan = f.dependencies.catalog.scan;
  f.dependencies.catalog.scan = async () => ({ ...await scan(), hasNextPage: true, pageFingerprint: 'same' });
  f.dependencies.catalog.nextPage = async () => ({ success: true, catalog: await f.dependencies.catalog.scan() });
  await assert.rejects(f.runner.start({ tabId: 1 }), /new assignment page/);
  assert.equal(f.events.filter((event) => event.startsWith('solve:')).length, 1);
});

test('an explicitly selected next-page query can resume a completed batch without replay', async () => {
  const f = fixture([card('one')]);
  await f.runner.start({ tabId: 1 });
  const count = f.events.length;
  const scan = f.dependencies.catalog.scan;
  f.dependencies.catalog.scan = async () => ({ ...await scan(), currentUrl: 'https://my.newtonschool.co/course/course-1/all_assignments?page=2' });
  await f.runner.start({ tabId: 1 });
  assert.equal(f.events.length, count);
});
