import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./background.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '');

function worker() {
  let listener;
  const runs = [];
  const messages = [];
  let id = 0;
  const assignments = {
    busy: false, getState: async () => ({ job: null, busy: false }),
    action: async () => ({ job: null, busy: false }),
  };
  const assignmentBatches = {
    busy: false, getState: async () => ({ batch: null, busy: false }),
    start: async () => ({ batch: null, busy: false }), stop: async () => ({ batch: null, busy: false }),
    recover: async () => ({ batch: null, busy: false }),
  };
  const context = vm.createContext({
    console: { log() {}, error() {} },
    setInterval: () => 1,
    clearInterval() {},
    crypto: { randomUUID: () => `test-${++id}` },
    createAssignmentRunner: () => assignments,
    createBatchAssignmentRunner: () => assignmentBatches,
    portalSubmission: {},
    detectAssignment() {},
    codeAdapter: {}, notebookAdapter: {}, assignmentApi: {},
    runFullQuizAutomation: start,
    runBatchQuizAutomation: start,
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage(msg) { messages.push(msg); return Promise.resolve(); },
      },
      action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    },
  });
  function start(options) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    runs.push({ options, finish(result) { options.onComplete(result); resolve(); } });
    return promise;
  }
  vm.runInContext(source, context);
  return {
    runs, messages, assignments, assignmentBatches,
    send(type, extra = {}) {
      let response;
      listener({ type, tabId: 7, ...extra }, {}, (value) => { response = value; });
      return response;
    },
    request(type, extra = {}) {
      return new Promise((resolve) => listener({ type, tabId: 7, ...extra }, {}, resolve));
    },
  };
}

test('single and batch runs cannot overlap, including while a stopped request settles', () => {
  const app = worker();
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, true);
  assert.equal(app.send('START_BATCH_AUTO_SOLVE').started, false);
  app.send('STOP_SINGLE_AUTO_SOLVE');
  assert.equal(app.runs[0].options.isRunningRef.current, false);
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  assert.equal(app.send('START_BATCH_AUTO_SOLVE').started, false);
  app.runs[0].finish({ success: false, cancelled: true });
  assert.equal(app.send('START_BATCH_AUTO_SOLVE').started, true);
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  app.send('STOP_BATCH_AUTO_SOLVE');
  assert.equal(app.send('START_BATCH_AUTO_SOLVE').started, false);
  app.runs[1].finish({ success: false, cancelled: true });
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, true);
  app.runs[2].finish({ success: true });
});

test('batch completion preserves failure details for the popup', () => {
  const app = worker();
  app.send('START_BATCH_AUTO_SOLVE');
  const result = { success: false, error: 'Rate limited', failedQuizzes: [{}] };
  app.runs[0].finish(result);
  assert.equal(app.messages.find((message) => message.type === 'BATCH_COMPLETE').result, result);
});

test('assignment work excludes background quiz and manual popup writes', () => {
  const app = worker();
  app.assignments.busy = true;
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  assert.equal(app.send('START_BATCH_AUTO_SOLVE').started, false);
  assert.equal(app.send('ACQUIRE_POPUP_QUIZ_ACTION').success, false);
  app.assignments.busy = false;
  assert.equal(app.send('ACQUIRE_POPUP_QUIZ_ACTION').success, true);
});

test('popup lease blocks quiz runs and can only be released by its owner', () => {
  const app = worker();
  const { token } = app.send('ACQUIRE_POPUP_QUIZ_ACTION');
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  assert.equal(app.send('RELEASE_POPUP_QUIZ_ACTION', { token: 'other' }).success, false);
  assert.equal(app.send('ACQUIRE_POPUP_QUIZ_ACTION').success, false);
  assert.equal(app.send('CHECK_POPUP_QUIZ_ACTION', { token }).success, true);
  assert.equal(app.send('RELEASE_POPUP_QUIZ_ACTION', { token }).success, true);
  assert.equal(app.send('CHECK_POPUP_QUIZ_ACTION', { token }).success, false);
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, true);
  app.runs[0].finish({ success: true });
});

test('assignment batch excludes quiz and standalone assignment work between items', () => {
  const app = worker();
  app.assignmentBatches.busy = true;
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  assert.equal(app.send('START_BATCH_AUTO_SOLVE').started, false);
  assert.equal(app.send('ACQUIRE_POPUP_QUIZ_ACTION').success, false);
  assert.equal(app.send('ASSIGNMENT_ACTION', { action: 'solve' }).success, false);
});

test('assignment batch acknowledges dispatch before its deferred work settles', async () => {
  const app = worker();
  let finish;
  app.assignmentBatches.start = () => new Promise((resolve) => { finish = resolve; });
  const response = app.send('ASSIGNMENT_BATCH_ACTION', { action: 'start', payload: { tabId: 7 } });
  assert.equal(response.success, true);
  assert.equal(response.accepted, true);
  assert.equal(response.protocolVersion, 2);
  assert.ok(response.operationId);
  assert.equal(app.messages.some((message) => message.type === 'ASSIGNMENT_ACTION_RESULT'), false);
  assert.equal(app.send('ASSIGNMENT_BATCH_ACTION', { action: 'start' }).success, false);
  assert.equal(app.send('ASSIGNMENT_ACTION', { action: 'solve' }).success, false);
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  finish();
  await new Promise(setImmediate);
  const result = app.messages.find((message) => message.type === 'ASSIGNMENT_ACTION_RESULT');
  assert.equal(result.operationId, response.operationId);
  assert.equal(result.scope, 'batch');
  assert.equal(result.action, 'start');
  assert.equal(result.success, true);
  assert.equal(result.busy, false);
});

test('startup failure before a batch exists is delivered by its correlated result', async () => {
  const app = worker();
  app.assignmentBatches.start = async () => { throw new Error('Catalog tab unavailable'); };
  const response = app.send('ASSIGNMENT_BATCH_ACTION', { action: 'start' });
  assert.equal(response.accepted, true);
  await new Promise(setImmediate);
  const result = app.messages.find((message) => message.type === 'ASSIGNMENT_ACTION_RESULT');
  assert.equal(result.operationId, response.operationId);
  assert.equal(result.success, false);
  assert.equal(result.error, 'Catalog tab unavailable');
  assert.equal(result.batch, null);
});

test('protocol handshake advertises recognized assignment capabilities', async () => {
  const app = worker();
  const state = await app.request('GET_ASSIGNMENT_STATE');
  assert.equal(state.protocolVersion, 2);
  assert.equal(state.capabilities.assignmentActions.includes('solve'), true);
  assert.equal(state.capabilities.assignmentBatchActions.includes('start'), true);
  assert.equal(app.send('ASSIGNMENT_BATCH_ACTION', { action: 'unknown' }).success, false);
  assert.equal(app.send('ASSIGNMENT_ACTION', { action: 'unknown' }).success, false);
});

test('Stop keeps its own operation identity while an accepted batch settles', async () => {
  const app = worker();
  let finish;
  app.assignmentBatches.start = () => {
    app.assignmentBatches.busy = true;
    return new Promise((resolve) => { finish = () => { app.assignmentBatches.busy = false; resolve(); }; });
  };
  let stopped = false;
  app.assignmentBatches.stop = async () => { stopped = true; };
  const start = app.send('ASSIGNMENT_BATCH_ACTION', { action: 'start' });
  const stop = app.send('ASSIGNMENT_ACTION', { action: 'stop' });
  assert.equal(stop.accepted, true);
  assert.notEqual(stop.operationId, start.operationId);
  await new Promise(setImmediate);
  assert.equal(stopped, true);
  assert.equal(app.messages.find((message) => message.operationId === stop.operationId).busy, true);
  assert.equal(app.send('ASSIGNMENT_BATCH_ACTION', { action: 'recover' }).success, false);
  finish();
  await new Promise(setImmediate);
  assert.equal(app.messages.find((message) => message.operationId === start.operationId).success, true);
});

test('Stop remains exclusive if cancellation acknowledgement outlasts the original operation', async () => {
  const app = worker();
  let finishRun;
  let finishStop;
  app.assignmentBatches.start = () => new Promise((resolve) => { finishRun = resolve; });
  app.assignmentBatches.stop = () => new Promise((resolve) => { finishStop = resolve; });
  app.send('ASSIGNMENT_BATCH_ACTION', { action: 'start' });
  app.send('ASSIGNMENT_BATCH_ACTION', { action: 'stop' });
  finishRun();
  await new Promise(setImmediate);
  assert.equal(app.send('ASSIGNMENT_BATCH_ACTION', { action: 'start' }).success, false);
  assert.equal(app.send('START_SINGLE_AUTO_SOLVE').started, false);
  finishStop();
  await new Promise(setImmediate);
  assert.equal(app.send('ASSIGNMENT_BATCH_ACTION', { action: 'recover' }).accepted, true);
});
