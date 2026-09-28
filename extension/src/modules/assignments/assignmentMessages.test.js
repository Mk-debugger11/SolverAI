import test from 'node:test';
import assert from 'node:assert/strict';
import { getAssignmentWorkerState, sendAssignmentCommand } from './assignmentMessages.js';

const ready = (extra = {}) => ({ protocolVersion: 2, busy: false, job: null, batch: null,
  capabilities: { assignmentBatchActions: ['start', 'stop', 'recover'], assignmentActions: ['inspect', 'solve'] }, ...extra });

function worker(responses) {
  const messages = [];
  return { messages, runtime: { async sendMessage(message) {
    messages.push(message);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(message) : next;
  } } };
}

test('old or missing worker responses stop before a batch command with reload instructions', async () => {
  for (const response of [undefined, {}, { job: null, busy: false, batch: null }]) {
    const app = worker([response]);
    await assert.rejects(sendAssignmentCommand({ scope: 'batch', action: 'start', runtime: app.runtime }), /out of sync.*chrome:\/\/extensions/);
    assert.deepEqual(app.messages.map((message) => message.type), ['GET_ASSIGNMENT_STATE']);
  }
});

test('a compatible worker without batch support cannot receive an unsupported Start', async () => {
  const app = worker([ready({ capabilities: {} })]);
  await assert.rejects(sendAssignmentCommand({ scope: 'batch', action: 'start', runtime: app.runtime }), /does not support/);
  assert.equal(app.messages.length, 1);
});

test('a batch acknowledgement returns immediately and is distinct from completion', async () => {
  const app = worker([ready(), { protocolVersion: 2, success: true, accepted: true, operationId: 'batch-1' }]);
  const observed = [];
  const result = await sendAssignmentCommand({ scope: 'batch', action: 'start', payload: { tabId: 7 }, runtime: app.runtime, onState: (state) => observed.push(state) });
  assert.equal(result.accepted, true);
  assert.equal(result.operationId, 'batch-1');
  assert.equal(observed.length, 1);
  assert.equal(app.messages[1].payload.tabId, 7);
});

test('specific worker errors reach the popup unchanged', async () => {
  const app = worker([ready(), { protocolVersion: 2, success: false, error: 'Open the All Assignments catalog.' }]);
  await assert.rejects(sendAssignmentCommand({ scope: 'batch', action: 'start', runtime: app.runtime }), /^Error: Open the All Assignments catalog\.$/);
  assert.equal(app.messages.length, 2);
});

test('lost acknowledgement refreshes running state without retrying the batch', async () => {
  const app = worker([ready(), undefined, ready({ busy: true, batch: { phase: 'solving' } })]);
  const observed = [];
  await assert.rejects(sendAssignmentCommand({ scope: 'batch', action: 'start', runtime: app.runtime, onState: (state) => observed.push(state) }), /still running/);
  assert.deepEqual(app.messages.map((message) => message.type), ['GET_ASSIGNMENT_STATE', 'ASSIGNMENT_BATCH_ACTION', 'GET_ASSIGNMENT_STATE']);
  assert.equal(observed.at(-1).batch.phase, 'solving');
});

test('closed message channel gets a useful connection error without sending a command', async () => {
  const app = worker([new Error('Receiving end does not exist.')]);
  await assert.rejects(sendAssignmentCommand({ scope: 'batch', action: 'start', runtime: app.runtime }), /Cannot connect.*Receiving end.*chrome:\/\/extensions/);
  assert.equal(app.messages.length, 1);
});

test('a timed-out acknowledgement does not duplicate assignment side effects', async () => {
  const app = worker([ready(), () => new Promise(() => {}), ready()]);
  await assert.rejects(sendAssignmentCommand({ scope: 'action', action: 'solve', runtime: app.runtime, timeoutMs: 10 }), /not acknowledged|did not acknowledge/);
  assert.equal(app.messages.filter((message) => message.type === 'ASSIGNMENT_ACTION').length, 1);
});

test('state hydration propagates a worker storage error', async () => {
  const app = worker([ready({ error: 'Checkpoint storage unavailable.' })]);
  await assert.rejects(getAssignmentWorkerState({ runtime: app.runtime }), /Checkpoint storage unavailable/);
});
