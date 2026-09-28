const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const express = require('express');
const { createAssignmentRouter } = require('./assignmentRoutes');
const { createAssignmentService } = require('../services/assignmentService');

test('HTTP API recovers idempotent requests, scopes status and cancels in-flight work', async (t) => {
  let dispatches = 0;
  let release;
  let entered;
  let nextDispatch = new Promise((resolve) => { entered = resolve; });
  const service = createAssignmentService({ request: async (_key, body, { beforeAttempt, signal }) => {
    beforeAttempt();
    dispatches += 1;
    const task = JSON.parse(body.messages[1].content).snapshot;
    const candidate = {
      runtime: task.runtime,
      edits: [{ targetId: 'source', baseSourceHash: task.targets[0].sourceHash, content: 'print(1)' }],
      explanation: '', assumptions: [],
    };
    return new Promise((resolve, reject) => {
      release = () => resolve(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(candidate) } }] })));
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered();
    });
  } });
  const app = express();
  app.use(express.json());
  app.use('/api/assignments', createAssignmentRouter(service));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/assignments`;
  async function post(path, body) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const source = 'pass';
  const body = {
    jobId: 'http-job', requestId: 'initial', apiKey: 'test-key', targetIds: ['source'],
    snapshot: {
      kind: 'code', problemId: 'problem', documentId: 'document', statement: 'Print 1.',
      runtime: { language: 'python', label: 'Python 3' },
      targets: [{ targetId: 'source', source, sourceHash: createHash('sha256').update(source).digest('hex'), editable: true }],
    },
  };
  const initial = post('/generate', body);
  await nextDispatch;
  assert.equal((await post('/jobs/http-job/status', { apiKey: 'wrong-key' })).status, 404);
  const queued = await post('/jobs/http-job/status', { apiKey: 'test-key', requestId: 'initial' });
  assert.equal(queued.data.requests[0].status, 'generating');
  const duplicate = post('/generate', body);
  release();
  const [first, replay] = await Promise.all([initial, duplicate]);
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.idempotent, true);
  assert.equal(dispatches, 1);
  const recovered = await post('/jobs/http-job/status', { apiKey: 'test-key', requestId: 'initial' });
  assert.equal(recovered.data.result.requestId, 'initial');
  assert.equal((await post('/generate', { ...body, maxTokens: 1000 })).status, 409);

  nextDispatch = new Promise((resolve) => { entered = resolve; });
  const repair = post('/generate', { ...body, requestId: 'repair', feedback: 'Visible test output was wrong' });
  await nextDispatch;
  assert.equal((await post('/jobs/http-job/cancel', { apiKey: 'wrong-key' })).status, 404);
  const cancelled = await post('/jobs/http-job/cancel', { apiKey: 'test-key' });
  assert.equal(cancelled.data.status, 'cancelled');
  const stopped = await repair;
  assert.equal(stopped.status, 409);
  assert.equal(stopped.data.code, 'JOB_CANCELLED');
  assert.equal(stopped.data.job.providerAttempts, 2);
});
