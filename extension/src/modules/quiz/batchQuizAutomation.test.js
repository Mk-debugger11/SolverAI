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
      console,
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
        query: async () => (++queries === 1 ? [{ id: 1 }] : [{ id: 1 }, { id: 2 }]),
        update: async () => {},
        get: async () => ({ status: 'complete' }),
        remove: async () => { closed += 1; },
      } },
    });
    vm.runInContext(source, context);
    await context.runBatchQuizAutomation({
      tabId: 1, isBatchRunningRef: runningRef,
      onComplete: (result) => { completed = result; },
    });
    assert.equal(opened, 1);
    assert.equal(closed, errorStatus === null ? 1 : 0);
    assert.equal(completed.success, false);
    assert.equal(completed.error, errorStatus === null ? null : 'Provider unavailable');
    assert.equal(completed.failedQuizzes.length, errorStatus === null ? 0 : 1);
  });
}
