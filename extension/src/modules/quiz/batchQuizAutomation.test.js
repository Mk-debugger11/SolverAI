import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./batchQuizAutomation.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*? from ['"][^'"]+['"];\n/gm, '')
  .replace('export async function', 'async function');

for (const errorStatus of [429, 401, 403, null]) {
  test(errorStatus ? `batch stops after provider ${errorStatus} and leaves the current quiz open` : 'batch stop immediately cancels its child without a timer', async () => {
    let opened = 0;
    let queries = 0;
    let closed = 0;
    let completed;
    const runningRef = { current: true };
    const context = vm.createContext({
      console, URL,
      setTimeout: (fn) => { fn(); return 1; },
      setInterval: () => 1,
      clearInterval() {},
      detectAssessmentsCatalog: async () => ({
        isCatalog: true, currentUrl: 'https://my.newtonschool.co/course/demo/all_assessments',
        quizzes: ['first', 'second'].map((title) => ({ title, isUnsolved: true })),
      }),
      clickQuizCardOnCatalog: async () => { opened += 1; return { success: true }; },
      waitForQuizQuestionsToLoad: async () => ({ ready: true }),
      runFullQuizAutomation: async (options) => {
        if (errorStatus === null) {
          runningRef.current = false;
          assert.equal(options.isRunningRef.current, false);
        }
        options.onComplete({ success: false, errorStatus, error: 'Provider unavailable' });
      },
      chrome: { tabs: {
        query: async () => (++queries === 1 ? [{ id: 1 }] : [{ id: 1 }, { id: 2, openerTabId: 1 }]),
        update: async () => {},
        get: async (id) => ({ status: 'complete', windowId: 3, url: id === 1
          ? 'https://my.newtonschool.co/course/demo/all_assessments'
          : 'https://my.newtonschool.co/course/demo/assessment/quiz' }),
        remove: async () => { closed += 1; },
      } },
    });
    vm.runInContext(source, context);
    await context.runBatchQuizAutomation({
      tabId: 1, isBatchRunningRef: runningRef,
      onComplete: (result) => { completed = result; },
    });
    assert.equal(opened, 1);
    assert.equal(closed, 0);
    assert.equal(completed.success, false);
    assert.equal(completed.error, errorStatus === null ? null : 'Provider unavailable');
    assert.equal(completed.failedQuizzes.length, errorStatus === null ? 0 : 1);
  });
}

function batchFixture({ owned = [3], unrelated = [2], result = { success: true }, stopAtReady = false } = {}) {
  const catalogUrl = 'https://my.newtonschool.co/course/demo/all_assessments';
  let clicked = false;
  let listener;
  let completion;
  const running = { current: true };
  const calls = { solved: [], closed: [], activated: [], queries: [], ready: [], removedListener: 0 };
  const tab = (id) => ({ id, windowId: 9, status: 'complete',
    url: id === 1 ? catalogUrl : `https://my.newtonschool.co/course/demo/assessment/quiz-${id}`,
    ...(owned.includes(id) ? { openerTabId: 1 } : {}),
  });
  const context = vm.createContext({
    URL, console: { error() {}, warn() {} }, setTimeout: (fn) => fn(),
    detectAssessmentsCatalog: async () => ({ isCatalog: true, currentUrl: catalogUrl,
      quizzes: [{ title: 'Quiz', isUnsolved: true }] }),
    clickQuizCardOnCatalog: async () => {
      assert.equal(typeof listener, 'function', 'tab listener must be attached before clicking');
      clicked = true;
      for (const id of [...unrelated, ...owned]) listener(tab(id));
      return { success: true };
    },
    waitForQuizQuestionsToLoad: async (id, _timeout, isRunning) => {
      calls.ready.push(id);
      if (stopAtReady) running.current = false;
      assert.equal(isRunning(), running.current);
      return { ready: true };
    },
    runFullQuizAutomation: async (options) => { calls.solved.push(options.tabId); options.onComplete(result); },
    chrome: { tabs: {
      onCreated: { addListener(fn) { listener = fn; }, removeListener(fn) { assert.equal(fn, listener); calls.removedListener++; listener = null; } },
      query: async (options) => {
        calls.queries.push(options);
        return (clicked ? [1, ...unrelated, ...owned] : [1]).map(tab);
      },
      get: async (id) => tab(id),
      update: async (id) => { calls.activated.push(id); },
      remove: async (id) => { calls.closed.push(id); },
    } },
  });
  vm.runInContext(source, context);
  return { calls, get completion() { return completion; },
    run: () => context.runBatchQuizAutomation({ tabId: 1, isBatchRunningRef: running,
      onComplete(value) { completion = value; } }),
  };
}

test('only catalog-owned quiz tabs are solved and closed, even when an unrelated quiz tab opens first', async () => {
  const app = batchFixture();
  await app.run();
  assert.equal(app.completion.success, true);
  assert.deepEqual(app.calls.solved, [3]);
  assert.deepEqual(app.calls.closed, [3]);
  assert.ok(!app.calls.activated.includes(2));
  assert.ok(app.calls.queries.every((query) => query.windowId === 9 && !query.currentWindow));
  assert.equal(app.calls.removedListener, 1);
});

test('a new quiz tab without catalog provenance is never solved or closed', async () => {
  const app = batchFixture({ owned: [] });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.match(app.completion.error, /could not be identified/);
  assert.deepEqual(app.calls.solved, []);
  assert.deepEqual(app.calls.closed, []);
  assert.equal(app.calls.removedListener, 1);
});

test('ambiguous tabs are left open and the creation listener is removed', async () => {
  const app = batchFixture({ owned: [3, 4] });
  await app.run();
  assert.match(app.completion.error, /multiple tabs/);
  assert.deepEqual(app.calls.solved, []);
  assert.deepEqual(app.calls.closed, []);
  assert.equal(app.calls.removedListener, 1);
});

test('failed quizzes stay open for review', async () => {
  const app = batchFixture({ result: { success: false, error: 'Selection failed' } });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.failedQuizzes.length, 1);
  assert.deepEqual(app.calls.closed, []);
});

test('stopping during question readiness prevents solving and leaves the quiz open', async () => {
  const app = batchFixture({ stopAtReady: true });
  await app.run();
  assert.equal(app.completion.cancelled, true);
  assert.deepEqual(app.calls.solved, []);
  assert.deepEqual(app.calls.closed, []);
});
