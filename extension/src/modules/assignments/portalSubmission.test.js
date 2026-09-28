import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionPageOperation, submitAssignment } from './portalSubmission.js';

function fixture(t, { oldResult, dialog } = {}) {
  const saved = Object.fromEntries(['window', 'document', 'location', 'MutationObserver'].map((key) => [key, globalThis[key]]));
  let callback;
  let resultNodes = [];
  let shown = [];
  let clicks = 0;
  let confirmations = 0;
  function node(value, type = 'result') {
    return { innerText: value, textContent: value, type, disabled: false,
      getClientRects: () => [1], getAttribute: () => null, querySelector: () => null,
      querySelectorAll: () => [], closest: () => null,
      click() { clicks++; } };
  }
  const submit = node('Submit Solution', 'button');
  if (oldResult) resultNodes = [node(oldResult)];
  const confirm = node('Submit');
  confirm.click = () => { confirmations++; shown = []; };
  const modal = node('Are you sure you want to submit this assignment?');
  modal.querySelectorAll = () => [confirm];
  submit.click = () => { clicks++; if (dialog) shown = [modal]; };
  globalThis.window = {};
  globalThis.location = { hostname: 'my.newtonschool.co', href: 'https://my.newtonschool.co/playground/newton-box/p1' };
  globalThis.document = { body: {}, querySelectorAll(selector) {
    if (selector === 'button, [role="button"]') return [submit];
    if (selector.startsWith('[role="dialog"]')) return shown;
    return resultNodes;
  } };
  globalThis.MutationObserver = class { constructor(cb) { callback = cb; } observe() {} disconnect() {} };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const payload = { url: location.href, kind: 'notebook', submissionId: 's1', sourceHash: 'hash' };
  return { payload, clicks: () => clicks, confirmations: () => confirmations,
    busy(value) { submit.disabled = value; callback?.(); },
    showResult(value) { resultNodes = value ? [node(value)] : []; callback?.(); },
    clearDialog() { shown = []; },
    showWarning() { modal.innerText = 'Warning: clipboard paste detected'; shown = [modal]; },
  };
}

test('stale Accepted does not acknowledge a new submission and duplicate start does not click twice', (t) => {
  const app = fixture(t, { oldResult: 'Accepted' });
  assert.equal(submissionPageOperation('start', app.payload).status, 'submitting');
  assert.equal(submissionPageOperation('start', app.payload).status, 'submitting');
  assert.equal(app.clicks(), 1);
  app.showResult('Accepted');
  assert.equal(submissionPageOperation('poll', app.payload).status, 'submitting');
  app.busy(true);
  app.showResult(null);
  app.showResult('Accepted');
  app.busy(false);
  const completed = submissionPageOperation('poll', app.payload);
  assert.equal(completed.status, 'accepted');
  assert.equal(completed.accepted, true);
});

test('a fresh acknowledged submission is distinct from accepted grading', (t) => {
  const app = fixture(t);
  submissionPageOperation('start', app.payload);
  app.showResult('Submitted successfully');
  const result = submissionPageOperation('poll', app.payload);
  assert.equal(result.success, true);
  assert.equal(result.status, 'submitted');
  assert.equal(result.accepted, false);
});

test('a fresh rejection is known failure feedback', (t) => {
  const app = fixture(t);
  submissionPageOperation('start', app.payload);
  app.showResult('Wrong Answer');
  const result = submissionPageOperation('poll', app.payload);
  assert.equal(result.status, 'rejected');
  assert.equal(result.success, false);
  assert.match(result.feedback, /Wrong Answer/);
});

test('reconciliation never confirms a pending submission dialog', (t) => {
  const app = fixture(t, { dialog: true });
  assert.equal(submissionPageOperation('start', app.payload).status, 'unknown');
  assert.equal(submissionPageOperation('poll', app.payload).status, 'unknown');
  assert.equal(app.confirmations(), 0);
  assert.equal(submissionPageOperation('poll', { ...app.payload, allowConfirm: true }).status, 'submitting');
  assert.equal(app.confirmations(), 1);
});

test('paste warnings stop automation without dismissal or a second click', (t) => {
  const app = fixture(t);
  submissionPageOperation('start', app.payload);
  app.showWarning();
  const result = submissionPageOperation('poll', { ...app.payload, allowConfirm: true });
  assert.equal(result.status, 'unknown');
  assert.equal(app.confirmations(), 0);
  assert.equal(app.clicks(), 1);
});

test('a changed assignment document cannot receive a replay', (t) => {
  const app = fixture(t);
  submissionPageOperation('start', app.payload);
  location.href = 'https://my.newtonschool.co/playground/newton-box/p2';
  assert.equal(submissionPageOperation('start', app.payload).status, 'unknown');
  assert.equal(app.clicks(), 1);
});

test('source is rechecked after the submission checkpoint before any Submit effect', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  let dispatched = 0;
  let source = 'original';
  globalThis.chrome = { scripting: { executeScript: async ({ func }) => {
    if (func === submissionPageOperation) { dispatched++; throw new Error('must not dispatch'); }
    return [{ result: { title: 'Task', statement: 'Implement f' } }];
  } } };
  await assert.rejects(submitAssignment({ tabId: 7, kind: 'notebook', url: 'https://my.newtonschool.co/playground/newton-box/p1' },
    { kind: 'notebook', targets: [], contextHash: 'h' }, {
      submissionId: 's1', onSubmission: async () => { source = 'manual edit'; },
      beforeDispatch: async () => { if (source !== 'original') throw new Error('Source changed'); },
    }), /Source changed/);
  assert.equal(dispatched, 0);
});

test('Stop during the last outer validation prevents the submission click', async (t) => {
  const previous = globalThis.chrome;
  t.after(() => { if (previous === undefined) delete globalThis.chrome; else globalThis.chrome = previous; });
  const controller = new AbortController();
  let reads = 0;
  let dispatched = 0;
  globalThis.chrome = { scripting: { executeScript: async ({ func }) => {
    if (func === submissionPageOperation) { dispatched++; throw new Error('must not dispatch'); }
    if (++reads === 2) controller.abort();
    return [{ result: { title: 'Task', statement: 'Implement f' } }];
  } } };
  const result = await submitAssignment({ tabId: 7, kind: 'notebook', url: 'https://my.newtonschool.co/playground/newton-box/p1' },
    { kind: 'notebook', targets: [], contextHash: 'h' }, { submissionId: 's1', signal: controller.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(dispatched, 0);
});
