const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createAssignmentService, LIMITS } = require('./assignmentService');
const { createGroqClient } = require('./groqClient');

const digest = (source) => createHash('sha256').update(source).digest('hex');
const target = (targetId, source, extra = {}) => ({ targetId, source, sourceHash: digest(source), editable: true, ...extra });
const snapshot = (extra = {}) => ({
  kind: 'code', problemId: 'problem1', documentId: 'document1', title: 'Even or odd',
  statement: 'Read an integer and print even or odd.', runtime: { language: 'mips', label: 'MIPS (Mars 4.5)' },
  targets: [target('source', '.text\nmain:\n# Your code here')], ...extra,
});
const input = (extra = {}) => ({ jobId: 'job1', requestId: 'initial', snapshot: snapshot(), targetIds: ['source'], apiKey: 'test-key', ...extra });
function candidate(payload, changes = {}) {
  const task = JSON.parse(payload.messages[1].content);
  return {
    runtime: task.snapshot.runtime,
    edits: task.snapshot.targetIds.map((id) => ({
      targetId: id,
      baseSourceHash: task.snapshot.targets.find((entry) => entry.targetId === id).sourceHash,
      content: 'complete solution source',
    })),
    explanation: 'Implements the stated input and output.', assumptions: [], ...changes,
  };
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
function completion(payload, changes = {}) {
  return response({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(candidate(payload)) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }, ...changes,
  });
}
function fixture(t, { responder = (_key, body) => completion(body), ...settings } = {}) {
  const calls = [];
  const service = createAssignmentService({
    getApiKey: () => undefined,
    request: async (key, body, options) => {
      options.beforeAttempt();
      calls.push({ key, body, options });
      return responder(key, body, options);
    },
    ...settings,
  });
  t.after(() => service.close());
  return { service, calls };
}

test('code generation returns guarded edits, runtime and real usage without quiz turbo settings', async (t) => {
  const { service, calls } = fixture(t);
  const result = await service.generate(input({ maxTokens: 99999 }));
  assert.equal(result.success, true);
  assert.equal(result.status, 'ready');
  assert.equal(result.edits[0].baseSourceHash, digest(input().snapshot.targets[0].source));
  assert.equal(result.maxTokens, 2048);
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
  assert.equal(result.job.providerAttempts, 1);
  assert.equal(result.job.logicalCalls, 1);
  assert.equal(result.job.unknownUsageAttempts, 0);
  assert.equal(result.job.usageComplete, true);
  assert.equal(calls[0].body.reasoning_effort, undefined);
  assert.equal(calls[0].body.max_tokens, 2048);
});

test('notebook context preserves dependency cells and only selected code cells are returned', async (t) => {
  const { service, calls } = fixture(t);
  const targets = [
    target('setup', 'import torch', { cellType: 'code', editable: false }),
    target('notes', 'Explain the model', { cellType: 'markdown', editable: false }),
    target('model', 'class Model:\n    pass', { cellType: 'code' }),
  ];
  const result = await service.generate(input({ snapshot: snapshot({ kind: 'notebook', targets }), targetIds: ['model'] }));
  assert.deepEqual(result.edits.map((edit) => edit.targetId), ['model']);
  const sent = JSON.parse(calls[0].body.messages[1].content).snapshot;
  assert.deepEqual(sent.targets.map((entry) => entry.source), targets.map((entry) => entry.source));
  assert.equal(calls[0].body.max_tokens, 4096);
});

test('exact source guards include whitespace and Unicode', async (t) => {
  const { service, calls } = fixture(t);
  const source = 'print("π")\r\n';
  await service.generate(input({ snapshot: snapshot({ targets: [target('source', source)] }) }));
  assert.equal(JSON.parse(calls[0].body.messages[1].content).snapshot.targets[0].source, source);
});

const invalidInputs = [
  ['unknown kind', (data) => { data.snapshot.kind = 'simulator'; }],
  ['missing runtime', (data) => { delete data.snapshot.runtime; }],
  ['stale source hash', (data) => { data.snapshot.targets[0].source += '\n'; }],
  ['unknown target', (data) => { data.targetIds = ['output']; }],
  ['duplicate selected target', (data) => { data.targetIds.push('source'); }],
  ['read-only target', (data) => { data.snapshot.targets[0].editable = false; }],
  ['duplicate context target', (data) => { data.snapshot.targets.push(data.snapshot.targets[0]); }],
  ['markdown edit', (data) => { data.snapshot.kind = 'notebook'; data.snapshot.targets[0].cellType = 'markdown'; }],
  ['invalid editable range', (data) => { data.snapshot.targets[0].editableRange = { start: 1, end: -1 }; }],
  ['oversized statement', (data) => { data.snapshot.statement = 'a'.repeat(LIMITS.statementBytes + 1); }],
  ['oversized feedback', (data) => { data.feedback = 'a'.repeat(LIMITS.feedbackBytes + 1); }],
  ['invalid output tokens', (data) => { data.maxTokens = 0; }],
];
for (const [name, change] of invalidInputs) test(`rejects ${name} before contacting provider`, async (t) => {
  const { service, calls } = fixture(t);
  const data = input();
  change(data);
  await assert.rejects(service.generate(data));
  assert.equal(calls.length, 0);
});

test('over-budget context is rejected intact instead of being truncated', async (t) => {
  const { service, calls } = fixture(t, { contextTokens: 2050 });
  await assert.rejects(service.generate(input()), (error) => error.code === 'CONTEXT_BUDGET');
  assert.equal(calls.length, 0);
});

const invalidCandidates = [
  ['wrong runtime', (value) => { value.runtime = { language: 'python', label: 'Python 3' }; }],
  ['unknown target', (value) => { value.edits[0].targetId = 'output'; }],
  ['wrong source hash', (value) => { value.edits[0].baseSourceHash = '0'.repeat(64); }],
  ['missing target', (value) => { value.edits = []; }],
  ['duplicate target', (value) => { value.edits.push(value.edits[0]); }],
  ['arbitrary path', (value) => { value.edits[0].path = '/tmp/program.py'; }],
  ['execution command', (value) => { value.command = 'python program.py'; }],
  ['blank content', (value) => { value.edits[0].content = ' '; }],
  ['oversized content', (value) => { value.edits[0].content = 'x'.repeat(LIMITS.sourceBytes + 1); }],
];
for (const [name, change] of invalidCandidates) test(`rejects provider ${name} and retains no candidate`, async (t) => {
  const { service } = fixture(t, { responder: (_key, body) => {
    const value = candidate(body); change(value);
    return completion(body, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
  } });
  await assert.rejects(service.generate(input()), (error) => error.code === 'INVALID_RESPONSE');
  const status = service.status('job1', { apiKey: 'test-key', requestId: 'initial' });
  assert.equal(status.result, undefined);
  assert.equal(status.status, 'failed');
  assert.equal(status.job.knownUsage.total_tokens, 150);
});

test('a length-truncated response is rejected even if its JSON happens to parse', async (t) => {
  const { service } = fixture(t, { responder: (_key, body) => completion(body, {
    choices: [{ finish_reason: 'length', message: { content: JSON.stringify(candidate(body)) } }],
  }) });
  await assert.rejects(service.generate(input()), (error) => error.code === 'INCOMPLETE_RESPONSE');
});

test('invalid JSON is not salvaged from prose or code fences', async (t) => {
  const { service } = fixture(t, { responder: (_key, body) => completion(body, {
    choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(candidate(body)) + '\n```' } }],
  }) });
  await assert.rejects(service.generate(input()), (error) => error.code === 'INVALID_RESPONSE');
});

test('protected starter prefix and suffix must be preserved exactly', async (t) => {
  let content = 'header\nprint(1)\nfooter';
  const { service } = fixture(t, { responder: (_key, body) => {
    const value = candidate(body); value.edits[0].content = content;
    return completion(body, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
  } });
  const source = 'header\npass\nfooter';
  const data = input({ snapshot: snapshot({ targets: [target('source', source, { editableRange: { start: 7, end: 11 } })] }) });
  assert.equal((await service.generate(data)).edits[0].content, content);
  content = 'changed header\nprint(1)\nfooter';
  await assert.rejects(service.generate({ ...data, jobId: 'job2', model: 'different-model' }), (error) => error.code === 'INVALID_RESPONSE');
});

test('request IDs deduplicate concurrent and settled retries and reject changed payload', async (t) => {
  let release;
  const { service, calls } = fixture(t, { responder: (_key, body) => new Promise((resolve) => { release = () => resolve(completion(body)); }) });
  const first = service.generate(input());
  const second = service.generate(input());
  assert.equal(calls.length, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a.edits, b.edits);
  assert.equal(b.idempotent, true);
  const replay = await service.generate(input());
  assert.equal(replay.idempotent, true);
  assert.equal(calls.length, 1);
  await assert.rejects(service.generate(input({ maxTokens: 1000 })), (error) => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('a failed request ID is replayed without another charge, but another job can try again', async (t) => {
  let failing = true;
  const { service, calls } = fixture(t, { responder: (_key, body) => failing
    ? response({ error: { message: 'Invalid credentials' } }, 401) : completion(body) });
  await assert.rejects(service.generate(input()), (error) => error.status === 401);
  failing = false;
  await assert.rejects(service.generate(input()), (error) => error.status === 401);
  await service.generate(input({ jobId: 'job2' }));
  assert.equal(calls.length, 2);
});

test('only one generation is active, while retries of that request remain idempotent', async (t) => {
  let release;
  const { service } = fixture(t, { responder: (_key, body) => new Promise((resolve) => { release = () => resolve(completion(body)); }) });
  const pending = service.generate(input());
  await assert.rejects(service.generate(input({ jobId: 'job2' })), (error) => error.code === 'JOB_BUSY');
  release(); await pending;
});

test('only two repairs with current visible feedback are allowed', async (t) => {
  const { service, calls } = fixture(t);
  await service.generate(input());
  await assert.rejects(service.generate(input({ requestId: 'repair1' })), /feedback/);
  const first = await service.generate(input({ requestId: 'repair1', feedback: { stderr: 'Assembler error at line 4' } }));
  const second = await service.generate(input({ requestId: 'repair2', feedback: { stdout: 'Wrong output' } }));
  assert.equal(first.job.logicalCalls, 2);
  assert.equal(second.job.logicalCalls, 3);
  await assert.rejects(service.generate(input({ requestId: 'repair3', feedback: 'still wrong' })), (error) => error.code === 'LOGICAL_BUDGET');
  assert.equal(calls.length, 3);
});

test('repairs may change current source but not runtime, problem or selected target scope', async (t) => {
  const { service } = fixture(t);
  await service.generate(input());
  await service.generate(input({ requestId: 'repair1', feedback: 'Runtime error', snapshot: snapshot({ targets: [target('source', 'first candidate')] }) }));
  await assert.rejects(service.generate(input({ requestId: 'repair2', feedback: 'failure', snapshot: snapshot({ problemId: 'other' }) })), (error) => error.code === 'JOB_CONTEXT_CHANGED');
});

test('status and cancellation require matching credentials and status selects the requested result', async (t) => {
  const { service } = fixture(t);
  await service.generate(input());
  await service.generate(input({ requestId: 'repair1', feedback: 'visible feedback' }));
  assert.throws(() => service.status('job1', { apiKey: 'other-key' }), (error) => error.status === 404);
  assert.throws(() => service.cancel('job1', { apiKey: 'other-key' }), (error) => error.status === 404);
  const status = service.status('job1', { apiKey: 'test-key', requestId: 'initial' });
  assert.equal(status.result.requestId, 'initial');
  assert.equal(status.requests.length, 2);
  assert.equal(service.status('job1', { apiKey: 'test-key', requestId: 'unknown' }).result, undefined);
  assert.ok(!JSON.stringify(status).includes('test-key'));
});

test('cancellation aborts pending generation and prevents follow-up generations', async (t) => {
  const { service } = fixture(t, { responder: (_key, _body, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = service.generate(input());
  const rejection = assert.rejects(pending, (error) => error.code === 'JOB_CANCELLED');
  const cancelled = service.cancel('job1', { apiKey: 'test-key' });
  assert.equal(cancelled.status, 'cancelled');
  await rejection;
  await assert.rejects(service.generate(input({ requestId: 'repair1', feedback: 'retry' })), (error) => error.code === 'JOB_CANCELLED');
  assert.equal(service.status('job1', { apiKey: 'test-key' }).job.unknownUsageAttempts, 1);
});

test('cancelling an assignment queued behind a quiz consumes no provider attempts', async (t) => {
  let release;
  let dispatches = 0;
  let time = 0;
  const request = createGroqClient({
    now: () => time, sleep: async (ms) => { time += ms; },
    fetchImpl: async () => {
      dispatches += 1;
      return new Promise((resolve) => { release = () => resolve(response({})); });
    },
  });
  const quiz = request('quiz-key', { model: 'shared-model' });
  await Promise.resolve();
  const { service } = fixture(t, { request });
  const queued = service.generate(input({ model: 'shared-model' }));
  const rejection = assert.rejects(queued, (error) => error.code === 'JOB_CANCELLED');
  service.cancel('job1', { apiKey: 'test-key' });
  await rejection;
  assert.equal(service.status('job1', { apiKey: 'test-key' }).job.providerAttempts, 0);
  release(); await quiz;
  await Promise.resolve();
  assert.equal(dispatches, 1);
});

test('provider retries share the six-attempt job ceiling across logical calls', async (t) => {
  let time = 1000;
  let dispatches = 0;
  const request = createGroqClient({
    now: () => time, sleep: async (ms) => { time += ms; },
    fetchImpl: async () => { dispatches += 1; return response({ error: { message: 'Rate limited' } }, 429); },
  });
  const { service } = fixture(t, { request });
  await assert.rejects(service.generate(input()), (error) => error.status === 429);
  assert.equal(dispatches, 4);
  await assert.rejects(service.generate(input({ requestId: 'repair1', feedback: 'Rate limit after cooldown' })), (error) => error.code === 'PROVIDER_BUDGET');
  assert.equal(dispatches, 6);
  await assert.rejects(service.generate(input({ requestId: 'repair2', feedback: 'Retry later' })), (error) => error.code === 'PROVIDER_BUDGET');
  const status = service.status('job1', { apiKey: 'test-key' });
  assert.equal(status.job.providerAttempts, 6);
  assert.equal(status.job.unknownUsageAttempts, 6);
  assert.equal(status.job.usageComplete, false);
});

test('token reservation is checked before actual dispatch', async (t) => {
  const { service, calls } = fixture(t, { maxJobTokens: 1 });
  await assert.rejects(service.generate(input()), (error) => error.code === 'TOKEN_BUDGET');
  assert.equal(calls.length, 0);
  assert.equal(service.status('job1', { apiKey: 'test-key' }).job.providerAttempts, 0);
});

test('missing usage remains explicitly unknown', async (t) => {
  const { service } = fixture(t, { responder: (_key, body) => completion(body, { usage: undefined }) });
  const result = await service.generate(input());
  assert.equal(result.usage, null);
  assert.equal(result.job.unknownUsageAttempts, 1);
  assert.equal(result.job.usageComplete, false);
});

test('identical cross-job results use a bounded cache without reporting old tokens as new usage', async (t) => {
  const { service, calls } = fixture(t);
  const first = await service.generate(input());
  first.edits[0].content = 'external mutation';
  const second = await service.generate(input({ jobId: 'job2' }));
  assert.equal(second.cacheHit, true);
  assert.equal(second.usage, null);
  assert.equal(second.sourceUsage.total_tokens, 150);
  assert.equal(second.job.providerAttempts, 0);
  assert.equal(calls.length, 1);
  assert.equal(second.edits[0].content, 'complete solution source');
});

test('cache identity includes credential, model, runtime, source, target and feedback', async (t) => {
  const { service, calls } = fixture(t);
  const variants = [
    {}, { apiKey: 'another-key' }, { model: 'another-model' },
    { snapshot: snapshot({ runtime: { language: 'python', label: 'Python 3' } }) },
    { snapshot: snapshot({ targets: [target('source', 'different source')] }) },
    { snapshot: snapshot({ targets: [target('other', 'different source')] }), targetIds: ['other'] },
    { feedback: 'compile error' }, { maxTokens: 1000 },
  ];
  for (const [index, change] of variants.entries()) await service.generate(input({ jobId: `job${index}`, ...change }));
  assert.equal(calls.length, variants.length);
});

test('cache and retained jobs expire at fixed TTLs', async (t) => {
  let time = 0;
  const { service, calls } = fixture(t, { now: () => time, jobTtlMs: 20, cacheTtlMs: 10 });
  await service.generate(input());
  time = 9;
  assert.equal((await service.generate(input({ jobId: 'job2' }))).cacheHit, true);
  time = 10;
  assert.equal((await service.generate(input({ jobId: 'job3' }))).cacheHit, false);
  time = 20;
  assert.throws(() => service.status('job1', { apiKey: 'test-key' }), (error) => error.code === 'JOB_NOT_FOUND');
  assert.equal(calls.length, 2);
});

test('cache entry and byte capacity and retained-job count remain bounded', async (t) => {
  const { service, calls } = fixture(t, { maxCacheEntries: 1, maxJobs: 2 });
  await service.generate(input());
  await service.generate(input({ jobId: 'job2', maxTokens: 1000 }));
  await service.generate(input({ jobId: 'job3' }));
  assert.equal(calls.length, 3);
  assert.throws(() => service.status('job1', { apiKey: 'test-key' }), (error) => error.status === 404);
  const tiny = fixture(t, { maxCacheBytes: 1 });
  await tiny.service.generate(input());
  await tiny.service.generate(input({ jobId: 'job2' }));
  assert.equal(tiny.calls.length, 2);
});

test('expired active jobs abort their provider operation', async (t) => {
  let time = 0;
  const { service } = fixture(t, { now: () => time, jobTtlMs: 1, responder: (_key, _body, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const pending = service.generate(input());
  const rejected = assert.rejects(pending, (error) => error.code === 'JOB_EXPIRED');
  time = 1;
  assert.throws(() => service.status('job1', { apiKey: 'test-key' }), (error) => error.status === 404);
  await rejected;
});

test('provider response byte limit stops oversized responses', async (t) => {
  const { service } = fixture(t, { responder: () => new Response('x'.repeat(LIMITS.responseBytes + 1)) });
  await assert.rejects(service.generate(input()), (error) => error.code === 'RESPONSE_TOO_LARGE');
});

test('routing forwards generation, status and cancellation and preserves structured errors', async () => {
  const { createAssignmentRouter } = require('../routes/assignmentRoutes');
  const calls = [];
  const router = createAssignmentRouter({
    generate: async (body) => { calls.push(body); return { success: true }; },
    status: (id, body) => { calls.push({ id, ...body }); return { status: 'ready' }; },
    cancel: () => { throw Object.assign(new Error('not found'), { status: 404, code: 'JOB_NOT_FOUND' }); },
  });
  async function invoke(path, body) {
    const route = router.stack.find((entry) => entry.route.path === path).route;
    let status = 200; let data;
    await route.stack[0].handle({ body, params: { jobId: 'job1' } }, { status: (value) => { status = value; return { json: (value) => { data = value; } }; }, json: (value) => { data = value; } });
    return { status, data };
  }
  assert.equal((await invoke('/generate', input())).data.success, true);
  assert.equal((await invoke('/jobs/:jobId/status', { apiKey: 'test-key' })).data.status, 'ready');
  assert.equal(calls[1].id, 'job1');
  const rejected = await invoke('/jobs/:jobId/cancel', { apiKey: 'wrong-key' });
  assert.equal(rejected.status, 404);
  assert.equal(rejected.data.code, 'JOB_NOT_FOUND');
});

test('empty notebook spacer cells may remain empty in a complete automatic candidate', async (t) => {
  const targets = [target('source', 'pass', { cellType: 'code' }), target('spacer', '', { cellType: 'code' })];
  const { service } = fixture(t, { responder: (_key, body) => {
    const result = candidate(body);
    result.edits.find((edit) => edit.targetId === 'spacer').content = '';
    return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] });
  } });
  const result = await service.generate(input({ snapshot: snapshot({ kind: 'notebook', targets }), targetIds: ['source', 'spacer'] }));
  assert.equal(result.edits.find((edit) => edit.targetId === 'spacer').content, '');
});
