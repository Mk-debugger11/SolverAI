import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssignmentRunner, ASSIGNMENT_STORAGE_KEY } from './assignmentRunner.js';

const copy = (value) => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture(options = {}) {
  let sequence = 0;
  let live = {
    kind: 'notebook', problemId: 'p1', documentId: 'd1', url: 'https://my.newtonschool.co/playground/newton-box/p1',
    runtime: { language: 'python', label: 'Python 3' }, statement: 'Implement f', title: 'Task', contextHash: 'context',
    targets: [{ targetId: 'cell1', source: 'pass', sourceHash: 'h1', editable: true, cellType: 'code' }],
    capabilities: { generate: true, apply: true, run: true, save: true, restore: true }, warnings: [],
  };
  const memory = {};
  const events = [];
  const api = {
    generate: async (body) => {
      events.push('generate');
      return { edits: [{ targetId: 'cell1', baseSourceHash: body.snapshot.targets[0].sourceHash, content: 'def f(): return 1' }],
        job: { logicalCalls: 1, providerAttempts: 1, knownUsage: { total_tokens: 100 } } };
    },
    cancel: async () => { events.push('cancel'); },
    status: async () => ({ requests: [] }),
    ...options.api,
  };
  const adapter = {
    readSnapshot: async () => copy(live),
    applyEdits: async (_context, _snapshot, edits) => {
      assert.equal(memory[ASSIGNMENT_STORAGE_KEY].phase, 'applying');
      assert.equal(memory[ASSIGNMENT_STORAGE_KEY].originalSnapshot.targets[0].source, 'pass');
      assert.deepEqual(memory[ASSIGNMENT_STORAGE_KEY].edits, edits);
      events.push('apply');
      live.targets[0].source = edits[0].content;
      live.targets[0].sourceHash = 'h2';
      live.contextHash = 'new-context';
      return { success: true, changedTargetIds: ['cell1'], snapshot: copy(live) };
    },
    runChecks: async () => {
      assert.equal(memory[ASSIGNMENT_STORAGE_KEY].phase, 'running');
      events.push('run');
      return { success: true, status: 'completed', results: [{ targetId: 'cell1', status: 'completed' }] };
    },
    save: async () => { events.push('save'); return { success: true, status: 'saved' }; },
    restoreEdits: async () => { events.push('restore'); return { success: true, changedTargetIds: ['cell1'] }; },
    ...options.adapter,
  };
  const dependencies = {
    storage: { get: async () => copy(memory), set: async (value) => { Object.assign(memory, copy(value)); }, remove: async (key) => { delete memory[key]; } },
    adapters: { notebook: adapter, code: adapter },
    detect: async (tabId) => ({ kind: live.kind, tabId, documentId: 'd1' }),
    api, makeId: () => `id${++sequence}`, isOtherBusy: options.isOtherBusy,
  };
  return { runner: createAssignmentRunner(dependencies), dependencies, memory, events, api, adapter,
    live: () => live, setLive: (value) => { live = value; } };
}

const inspect = (app) => app.runner.action('inspect', { tabId: 7 });
const generate = (app) => app.runner.action('generate', { targetIds: ['cell1'] });

test('automatic repairs reuse completed setup and rerun changed definitions and downstream checks', async () => {
  const app = fixture();
  app.live().targets[0].index = 1;
  app.live().targets.unshift({ targetId: 'setup', source: 'setup()', sourceHash: 'hs', index: 0, editable: true, cellType: 'code' });
  app.live().targets.push({ targetId: 'check', source: 'assert f() == 2', sourceHash: 'hc', index: 2, editable: false, cellType: 'code' });
  const runs = [];
  let generations = 0;
  app.api.generate = async (body) => ({
    edits: [{ targetId: 'cell1', baseSourceHash: body.snapshot.targets[1].sourceHash, content: `def f(): return ${++generations}` }],
    job: { logicalCalls: generations, providerAttempts: generations },
  });
  app.adapter.applyEdits = async (_context, _snapshot, edits) => {
    app.live().targets[1].source = edits[0].content;
    app.live().targets[1].sourceHash = `h${generations + 1}`;
    app.live().contextHash = `context${generations}`;
    return { success: true, changedTargetIds: ['cell1'], snapshot: copy(app.live()) };
  };
  app.adapter.runChecks = async (_context, _snapshot, { targetIds }) => {
    runs.push(targetIds);
    return { success: runs.length > 1, status: runs.length === 1 ? 'failed' : 'completed',
      results: targetIds.map((id) => ({ targetId: id, status: runs.length === 1 && id === 'check' ? 'failed' : 'completed',
        error: runs.length === 1 && id === 'check' ? 'AssertionError' : '' })) };
  };
  await inspect(app);
  await app.runner.action('automate', { targetIds: ['cell1'], executeIds: ['setup', 'cell1', 'check'] });
  assert.deepEqual(runs, [['setup', 'cell1', 'check'], ['cell1', 'check']]);
  assert.equal(generations, 2);
  assert.equal((await app.runner.getState()).job.phase, 'saved');
});

test('recovery reads a completed owned execution without dispatching another cell', async () => {
  const app = fixture();
  await inspect(app);
  app.memory[ASSIGNMENT_STORAGE_KEY].phase = 'running';
  app.memory[ASSIGNMENT_STORAGE_KEY].execution = { runId: 'r1', requestId: 'm1', targetId: 'cell1', status: 'running', results: [] };
  app.live().targets[0].metadata = { execution: { 'iopub.status.idle': '2026-09-27T00:00:00Z' } };
  app.adapter.pollExecution = async (_context, execution) => {
    assert.equal(execution.requestId, 'm1');
    return { success: true, status: 'completed', outputs: [{ text: 'ok' }], errors: [] };
  };
  const restarted = createAssignmentRunner(app.dependencies);
  await restarted.action('recover');
  const { job } = await restarted.getState();
  assert.equal(job.phase, 'completed');
  assert.equal(job.execution.results[0].output, 'ok');
  assert.equal(job.recovery.required, false);
  assert.deepEqual(app.events, []);
});

test('recovery checks the retained save acknowledgement without saving again', async () => {
  const app = fixture();
  app.live().dirty = false;
  await inspect(app);
  app.memory[ASSIGNMENT_STORAGE_KEY].phase = 'saving';
  app.memory[ASSIGNMENT_STORAGE_KEY].pendingSaveId = 's1';
  app.adapter.pollSave = async (_context, saveId) => {
    assert.equal(saveId, 's1');
    return { success: true, status: 'saved' };
  };
  const restarted = createAssignmentRunner(app.dependencies);
  await restarted.action('recover');
  const { job } = await restarted.getState();
  assert.equal(job.phase, 'saved');
  assert.equal(job.pendingSaveId, null);
  assert.deepEqual(app.events, []);
});

test('automate persists drafts and originals before effects, and saves without claiming submission', async () => {
  const app = fixture();
  await inspect(app);
  await app.runner.action('automate', { targetIds: ['cell1'], executeIds: ['cell1'] });
  assert.deepEqual(app.events, ['generate', 'apply', 'run', 'save']);
  const { job } = await app.runner.getState();
  assert.equal(job.phase, 'saved');
  assert.match(job.reason, /not been submitted/);
  assert.equal(job.canRestore, true);
  assert.equal(job.usage.providerAttempts, 1);
});

test('manual edits during generation prevent applying the candidate', async () => {
  const waiting = deferred();
  const app = fixture({ api: { generate: async () => waiting.promise } });
  await inspect(app);
  const pending = generate(app);
  await new Promise(setImmediate);
  app.live().targets[0].source = 'manual';
  waiting.resolve({ edits: [{ targetId: 'cell1', baseSourceHash: 'h1', content: 'generated' }] });
  await assert.rejects(pending, /source changed/);
  await assert.rejects(app.runner.action('apply'), /source changed/);
  assert.deepEqual(app.events, []);
});

test('duplicate/unknown edit targets never reach the adapter', async () => {
  const app = fixture({ api: { generate: async () => ({ edits: [{ targetId: 'other', baseSourceHash: 'h1', content: 'bad' }] }) } });
  await inspect(app);
  await assert.rejects(generate(app), /invalid/);
  assert.deepEqual(app.events, []);
});

test('coding preview capabilities prevent Apply and Automate', async () => {
  const app = fixture();
  app.live().kind = 'code';
  app.live().capabilities.apply = false;
  app.live().reasons = ['Paste warning is not verified.'];
  await inspect(app);
  await generate(app);
  await assert.rejects(app.runner.action('apply'), /Paste warning/);
  await assert.rejects(app.runner.action('automate', { targetIds: ['cell1'] }), /Paste warning/);
  assert.deepEqual(app.events, ['generate']);
});

test('Stop during generation blocks all later apply/run/save effects', async () => {
  const waiting = deferred();
  const app = fixture({ api: { generate: async () => waiting.promise } });
  await inspect(app);
  const pending = app.runner.action('automate', { targetIds: ['cell1'], executeIds: ['cell1'], apiKey: 'test-only-key' });
  await new Promise(setImmediate);
  await app.runner.stop();
  waiting.resolve({ edits: [{ targetId: 'cell1', baseSourceHash: 'h1', content: 'generated' }] });
  await assert.rejects(pending, /stopped/);
  assert.deepEqual(app.events, ['cancel']);
  assert.equal(JSON.stringify(app.memory).includes('test-only-key'), false);
});

test('worker restart reconciles an already applied edit without applying it again', async () => {
  const app = fixture();
  await inspect(app);
  await generate(app);
  const saved = app.memory[ASSIGNMENT_STORAGE_KEY];
  saved.phase = 'applying';
  saved.originalSnapshot = copy(saved.snapshot);
  app.live().targets[0].source = saved.edits[0].content;
  app.live().targets[0].sourceHash = 'h2';
  app.live().contextHash = 'new-context';
  const restarted = createAssignmentRunner(app.dependencies);
  assert.equal((await restarted.getState()).job.recovery.required, true);
  await restarted.action('recover');
  assert.equal((await restarted.getState()).job.phase, 'applied');
  assert.equal(app.events.includes('apply'), false);
});

test('worker restart does not replay an interrupted execution', async () => {
  const app = fixture();
  await inspect(app);
  app.memory[ASSIGNMENT_STORAGE_KEY].phase = 'running';
  app.memory[ASSIGNMENT_STORAGE_KEY].execution = { status: 'running' };
  const restarted = createAssignmentRunner(app.dependencies);
  await assert.rejects(restarted.action('recover'), /will not be replayed/);
  await assert.rejects(restarted.action('run', { targetIds: ['cell1'] }), /Reconcile/);
  assert.equal(app.events.includes('run'), false);
});

test('a missing backend request after a lost generation response cannot be silently reissued', async () => {
  const app = fixture({ api: { generate: async () => { throw new Error('Network interrupted'); } } });
  await inspect(app);
  await assert.rejects(generate(app), /Network/);
  await assert.rejects(app.runner.action('recover'), /no longer retained/);
  await assert.rejects(generate(app), /Reconcile/);
});

test('changed instructions invalidate recovery even if generated source matches', async () => {
  const app = fixture();
  await inspect(app);
  await generate(app);
  app.memory[ASSIGNMENT_STORAGE_KEY].phase = 'applying';
  app.live().targets[0].source = 'def f(): return 1';
  app.live().targets[0].sourceHash = 'h2';
  app.live().statement = 'Different task';
  const restarted = createAssignmentRunner(app.dependencies);
  await assert.rejects(restarted.action('recover'), /differs/);
});

test('background quiz lock and concurrent assignment action are enforced synchronously', async () => {
  const app = fixture({ isOtherBusy: () => true });
  await assert.rejects(inspect(app), /still active/);
  const waiting = deferred();
  const another = fixture({ api: { generate: async () => waiting.promise } });
  await inspect(another);
  const pending = generate(another);
  await assert.rejects(inspect(another), /still active/);
  waiting.resolve({ edits: [{ targetId: 'cell1', baseSourceHash: 'h1', content: 'ok' }] });
  await pending;
});

test('failure to persist the pre-effect checkpoint prevents live writes', async () => {
  const app = fixture();
  await inspect(app);
  await generate(app);
  app.dependencies.storage.set = async () => { throw new Error('Storage full'); };
  await assert.rejects(app.runner.action('apply'), /Storage full/);
  assert.equal(app.events.includes('apply'), false);
});

test('A to B to C repairs retain the original hash and restore A', async () => {
  let generations = 0;
  const app = fixture({
    api: {
      generate: async (body) => {
        generations++;
        return {
          edits: [{ targetId: 'cell1', baseSourceHash: body.snapshot.targets[0].sourceHash, content: `def f(): return ${generations}` }],
          job: { logicalCalls: generations, providerAttempts: generations },
        };
      },
    },
    adapter: {
      applyEdits: async (_context, snapshot, edits) => {
        assert.equal(app.memory[ASSIGNMENT_STORAGE_KEY].phase, 'applying');
        assert.equal(snapshot.targets[0].source, app.live().targets[0].source);
        app.live().targets[0].source = edits[0].content;
        app.live().targets[0].sourceHash = `hash-${generations}`;
        app.live().contextHash = `context-${generations}`;
        return { success: true, status: 'applied', changedTargetIds: ['cell1'], appliedEdits: copy(edits) };
      },
      restoreEdits: async (_context, original, edits) => {
        assert.equal(app.memory[ASSIGNMENT_STORAGE_KEY].phase, 'restoring');
        assert.equal(original.targets[0].source, 'pass');
        assert.equal(edits[0].baseSourceHash, original.targets[0].sourceHash);
        assert.equal(edits[0].baseSourceHash, 'h1');
        assert.equal(edits[0].content, 'def f(): return 2');
        assert.equal(app.live().targets[0].source, edits[0].content);
        app.setLive(copy(original));
        return { success: true, status: 'restored', changedTargetIds: ['cell1'], snapshot: copy(original) };
      },
    },
  });
  await inspect(app);
  await generate(app);
  await app.runner.action('apply');
  await app.runner.action('generate', { targetIds: ['cell1'], feedback: 'The public check expected 2 and received 1.' });
  await app.runner.action('apply');
  const beforeRestore = (await app.runner.getState()).job;
  assert.equal(beforeRestore.draftSnapshot.targets[0].sourceHash, 'hash-1');
  assert.equal(beforeRestore.appliedEdits[0].baseSourceHash, 'h1');
  assert.equal(beforeRestore.originalSnapshot.targets[0].source, 'pass');
  await app.runner.action('restore');
  const { job } = await app.runner.getState();
  assert.equal(job.phase, 'restored');
  assert.equal(job.canRestore, false);
  assert.deepEqual(job.appliedTargetIds, []);
  assert.equal(app.live().targets[0].source, 'pass');
});

test('a partial apply records observed source and remains eligible for guarded restore', async () => {
  const app = fixture({
    api: {
      generate: async (body) => ({
        edits: body.snapshot.targets.map((target) => ({
          targetId: target.targetId, baseSourceHash: target.sourceHash, content: `def ${target.targetId}(): return 1`,
        })),
        job: { logicalCalls: 1, providerAttempts: 1 },
      }),
    },
    adapter: {
      applyEdits: async () => {
        app.live().targets[0].source = 'def cell1(';
        app.live().targets[0].sourceHash = 'partial-hash';
        app.live().contextHash = 'partial-context';
        // A native editor can fail after changing only part of a source. The
        // runner must keep this actual value, not the intended replacement.
        return {
          success: false, status: 'partial', reason: 'The editor rejected the remaining edit.',
          changedTargetIds: ['cell1'],
          appliedEdits: [{ targetId: 'cell1', baseSourceHash: 'h1', content: 'def cell1(' }],
        };
      },
      restoreEdits: async (_context, original, edits) => {
        assert.equal(edits.length, 1);
        assert.equal(edits[0].targetId, 'cell1');
        assert.equal(edits[0].baseSourceHash, original.targets[0].sourceHash);
        assert.equal(edits[0].content, app.live().targets[0].source);
        assert.equal(app.live().targets[1].source, original.targets[1].source);
        app.setLive(copy(original));
        return { success: true, status: 'restored', changedTargetIds: ['cell1'], snapshot: copy(original) };
      },
    },
  });
  app.live().targets.push({ targetId: 'cell2', source: 'second_original', sourceHash: 'h-second', editable: true, cellType: 'code' });
  await inspect(app);
  await app.runner.action('generate', { targetIds: ['cell1', 'cell2'] });
  await assert.rejects(app.runner.action('apply'), /editor rejected/);
  const interrupted = (await app.runner.getState()).job;
  assert.equal(interrupted.phase, 'needs_attention');
  assert.equal(interrupted.recovery.required, false);
  assert.equal(interrupted.canRestore, true);
  assert.equal(interrupted.snapshot.targets[0].source, 'def cell1(');
  assert.equal(interrupted.appliedEdits[0].content, 'def cell1(');
  assert.deepEqual(interrupted.appliedTargetIds, ['cell1']);
  await app.runner.action('restore');
  const { job } = await app.runner.getState();
  assert.equal(job.phase, 'restored');
  assert.equal(job.canRestore, false);
  assert.equal(app.live().targets[0].source, 'pass');
  assert.equal(app.live().targets[1].source, 'second_original');
});

test('partial restore retains the original backup and updates its source guard for a safe retry', async () => {
  let restores = 0;
  const app = fixture({ adapter: {
    restoreEdits: async (_context, original, edits) => {
      restores += 1;
      assert.equal(edits.length, 1);
      assert.equal(original.targets[0].source, 'pass');
      assert.equal(edits[0].baseSourceHash, 'h1');
      assert.equal(edits[0].content, app.live().targets[0].source);
      if (restores === 1) {
        // A write can fail after replacing only part of the cell source.
        app.live().targets[0].source = 'pa';
        app.live().targets[0].sourceHash = 'partial-restore-hash';
        app.live().contextHash = 'partial-restore-context';
        return {
          success: false, status: 'partial', reason: 'Restoring the cell stopped partway through.',
          changedTargetIds: ['cell1'],
          appliedEdits: [{ targetId: 'cell1', baseSourceHash: 'h1', content: 'pa' }],
        };
      }
      assert.equal(edits[0].content, 'pa');
      app.setLive(copy(original));
      return { success: true, status: 'restored', changedTargetIds: ['cell1'], snapshot: copy(original) };
    },
  } });
  await inspect(app);
  await generate(app);
  await app.runner.action('apply');
  await assert.rejects(app.runner.action('restore'), /stopped partway/);
  const interrupted = (await app.runner.getState()).job;
  assert.equal(interrupted.phase, 'needs_attention');
  assert.equal(interrupted.recovery.required, false);
  assert.equal(interrupted.canRestore, true);
  assert.equal(interrupted.originalSnapshot.targets[0].source, 'pass');
  assert.equal(interrupted.snapshot.targets[0].source, 'pa');
  assert.equal(interrupted.appliedEdits[0].content, 'pa');
  assert.deepEqual(interrupted.appliedTargetIds, ['cell1']);
  await app.runner.action('restore');
  const final = (await app.runner.getState()).job;
  assert.equal(restores, 2);
  assert.equal(final.phase, 'restored');
  assert.equal(final.canRestore, false);
  assert.deepEqual(final.appliedEdits, []);
  assert.equal(app.live().targets[0].source, 'pass');
});

test('Solve chooses notebook cells, preserves protected tests, runs, saves and submits end to end', async () => {
  const app = fixture();
  app.live().targets.push({ targetId: 'tests', source: 'assert f() == 1', sourceHash: 'test-hash', editable: false, cellType: 'code' });
  app.dependencies.submission = {
    inspect: async () => ({ available: true }),
    submit: async (_context, _snapshot, options) => {
      assert.equal(app.memory[ASSIGNMENT_STORAGE_KEY].phase, 'submitting');
      assert.ok(app.memory[ASSIGNMENT_STORAGE_KEY].pendingSubmissionId);
      assert.equal(app.memory[ASSIGNMENT_STORAGE_KEY].savedSnapshot.targets[0].source, 'def f(): return 1');
      await options.onSubmission({ submissionId: options.submissionId, status: 'submitting', dispatched: true });
      app.events.push('submit');
      return { success: true, status: 'accepted', accepted: true };
    },
  };
  app.adapter.runChecks = async (_context, _snapshot, options) => {
    assert.deepEqual(options.targetIds, ['cell1', 'tests']);
    app.events.push('run');
    return { success: true, status: 'completed', results: options.targetIds.map((targetId) => ({ targetId, status: 'completed' })) };
  };
  const runner = createAssignmentRunner(app.dependencies);
  await runner.action('solve', { tabId: 7 });
  const { job } = await runner.getState();
  assert.deepEqual(job.selectedTargetIds, ['cell1']);
  assert.equal(job.phase, 'accepted');
  assert.equal(job.pendingSubmissionId, null);
  assert.deepEqual(app.events, ['generate', 'apply', 'run', 'save', 'submit']);
});

test('unknown submission blocks Solve and recovery polls without submitting again', async () => {
  const app = fixture();
  let submits = 0;
  app.dependencies.submission = {
    inspect: async () => ({ available: true }),
    submit: async (_context, _snapshot, options) => {
      submits++;
      return { success: false, status: 'unknown', reason: 'Network response lost',
        submission: { submissionId: options.submissionId, dispatched: true } };
    },
    poll: async (_context, record) => {
      assert.ok(record.submissionId);
      return { success: true, status: 'submitted', reason: 'Submitted successfully' };
    },
  };
  const runner = createAssignmentRunner(app.dependencies);
  await assert.rejects(runner.action('solve', { tabId: 7 }), /Network response/);
  await assert.rejects(runner.action('solve', { tabId: 7 }), /Reconcile/);
  const restarted = createAssignmentRunner(app.dependencies);
  await restarted.action('recover');
  assert.equal((await restarted.getState()).job.phase, 'submitted');
  assert.equal(submits, 1);
});

test('known rejected submissions can be repaired within the original generation budget', async () => {
  const app = fixture();
  let generations = 0;
  let submits = 0;
  app.api.generate = async (body) => {
    generations++;
    if (generations === 2) assert.match(body.feedback, /Wrong Answer/);
    return { edits: [{ targetId: 'cell1', baseSourceHash: body.snapshot.targets[0].sourceHash, content: `def f(): return ${generations}` }],
      job: { logicalCalls: generations, providerAttempts: generations } };
  };
  app.dependencies.submission = { inspect: async () => ({ available: true }), submit: async () => ++submits === 1
    ? { success: false, status: 'rejected', reason: 'Wrong Answer', feedback: 'Wrong Answer: expected 2' }
    : { success: true, status: 'accepted' } };
  const runner = createAssignmentRunner(app.dependencies);
  await runner.action('solve', { tabId: 7 });
  assert.equal(generations, 2);
  assert.equal(submits, 2);
  assert.equal((await runner.getState()).job.phase, 'accepted');
  assert.equal((await runner.getState()).job.originalSnapshot.targets[0].source, 'pass');
});

test('source edits after save prevent manual submission', async () => {
  const app = fixture();
  app.dependencies.submission = { inspect: async () => ({ available: true }), submit: async () => { throw new Error('must not submit'); } };
  const runner = createAssignmentRunner(app.dependencies);
  await runner.action('inspect', { tabId: 7 });
  await runner.action('automate', { targetIds: ['cell1'], executeIds: ['cell1'] });
  app.live().targets[0].source = 'changed by user';
  await assert.rejects(runner.action('submit'), /source changed/);
});

test('finished jobs remain usable after worker restart even when their old tab has closed', async () => {
  const app = fixture();
  await inspect(app);
  app.memory[ASSIGNMENT_STORAGE_KEY].phase = 'accepted';
  const restarted = createAssignmentRunner(app.dependencies);
  assert.equal((await restarted.getState()).job.phase, 'accepted');
  assert.equal((await restarted.getState()).job.recovery.required, false);
});

test('lost save prevents a fresh solve from discarding the pending acknowledgement', async () => {
  const app = fixture({ adapter: { save: async () => { throw new Error('Save connection lost'); } } });
  await inspect(app);
  await assert.rejects(app.runner.action('automate', { targetIds: ['cell1'], executeIds: ['cell1'] }), /Save connection lost/);
  const pending = (await app.runner.getState()).job.pendingSaveId;
  await assert.rejects(app.runner.action('solve', { tabId: 8 }), /Reconcile/);
  assert.equal((await app.runner.getState()).job.pendingSaveId, pending);
});

test('generation sends source context without duplicate candidates, outputs or recovery metadata', async () => {
  const app = fixture();
  app.live().candidates = [{ source: 'duplicate program' }];
  app.live().targets[0].outputs = [{ text: 'large irrelevant prior output' }];
  app.api.generate = async (body) => {
    assert.equal(body.snapshot.candidates, undefined);
    assert.equal(body.snapshot.capabilities, undefined);
    assert.equal(body.snapshot.targets[0].outputs, undefined);
    assert.equal(body.snapshot.targets[0].source, 'pass');
    return { edits: [{ targetId: 'cell1', baseSourceHash: 'h1', content: 'def f(): return 1' }] };
  };
  await inspect(app);
  await generate(app);
});

test('retention expiry does not erase an uncertain submission', async () => {
  const app = fixture();
  await inspect(app);
  app.memory[ASSIGNMENT_STORAGE_KEY].phase = 'submitting';
  app.memory[ASSIGNMENT_STORAGE_KEY].pendingSubmissionId = 'unknown-submit';
  app.memory[ASSIGNMENT_STORAGE_KEY].expiresAt = 1;
  const restarted = createAssignmentRunner(app.dependencies);
  const { job } = await restarted.getState();
  assert.equal(job.pendingSubmissionId, 'unknown-submit');
  assert.equal(job.recovery.required, true);
  await assert.rejects(restarted.action('solve', { tabId: 7 }), /Reconcile/);
});
