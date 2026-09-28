const test = require('node:test');
const assert = require('node:assert/strict');
const { createGroqClient } = require('./groqClient');

const payload = { model: 'test-model', messages: [{ role: 'user', content: 'test' }] };
const ok = () => new Response('{}', { status: 200 });
const limited = (headers = {}, message = 'Rate limit reached') => new Response(
  JSON.stringify({ error: { message } }), { status: 429, headers }
);

function fixture(responses, options = {}) {
  let time = Date.parse('2026-01-01T00:00:00Z');
  const starts = [];
  const requests = [];
  const client = createGroqClient({
    now: () => time,
    sleep: async (ms) => { time += ms; },
    fetchImpl: async (_url, request) => {
      starts.push(time);
      requests.push(JSON.parse(request.body));
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, 'Unexpected extra provider request');
      return response;
    },
    ...options,
  });
  return { client, starts, requests };
}

test('concurrent calls share model pacing, including different API keys', async () => {
  const { client, starts } = fixture([ok(), ok(), ok()]);
  await Promise.all([client('key-1', payload), client('key-2', payload), client('key-1', payload)]);
  assert.deepEqual(starts.map((time) => time - starts[0]), [0, 2100, 4200]);
});

test('429 retries the same payload after Retry-After and a buffer', async () => {
  const { client, starts, requests } = fixture([limited({ 'retry-after': '2.5' }), ok()]);
  assert.equal((await client('test-key', payload)).status, 200);
  assert.equal(starts[1] - starts[0], 2750);
  assert.deepEqual(requests, [payload, payload]);
});

test('Retry-After accepts an HTTP date', async () => {
  const { client, starts } = fixture([
    limited({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' }), ok(),
  ]);
  await client('test-key', payload);
  assert.equal(starts[1] - starts[0], 5250);
});

test('missing header uses the provider message duration', async () => {
  const { client, starts } = fixture([limited({}, 'Please try again in 2s.'), ok()]);
  await client('test-key', payload);
  assert.equal(starts[1] - starts[0], 2250);
});

test('invalid or missing delay uses bounded exponential backoff', async () => {
  const { client, starts } = fixture([
    limited({ 'retry-after': 'invalid' }), limited(), limited(), limited(),
  ]);
  assert.equal((await client('test-key', payload)).status, 429);
  assert.equal(starts.length, 4);
  assert.deepEqual(starts.slice(1).map((time, i) => time - starts[i]), [2250, 4250, 8250]);
});

test('a final 429 cooldown also applies to the next queued request', async () => {
  const { client, starts } = fixture([limited({ 'retry-after': '5' }), ok()], { maxRetries: 0 });
  const results = await Promise.all([client('test-key', payload), client('test-key', payload)]);
  assert.deepEqual(results.map((response) => response.status), [429, 200]);
  assert.equal(starts[1] - starts[0], 5250);
});

test('long cooldowns surface 429 without waiting or sending queued requests early', async () => {
  const { client, starts } = fixture([limited({ 'retry-after': '3600' })]);
  const first = await client('test-key', payload);
  const next = await client('test-key', payload);
  assert.equal(first.status, 429);
  assert.equal(next.status, 429);
  assert.deepEqual(await first.json(), await next.json());
  assert.equal(starts.length, 1);
});

test('authentication failures are not retried', async () => {
  const { client, starts } = fixture([new Response('{}', { status: 401 })]);
  assert.equal((await client('test-key', payload)).status, 401);
  assert.equal(starts.length, 1);
});

test('fetch errors do not break the queue for subsequent requests', async () => {
  const { client, starts } = fixture([new Error('offline'), ok()]);
  await assert.rejects(client('test-key', payload), /offline/);
  assert.equal((await client('test-key', payload)).status, 200);
  assert.equal(starts[1] - starts[0], 2100);
});

test('invalid interval and retry settings use safe defaults', async () => {
  const { client, starts } = fixture([ok(), ok()], { minIntervalMs: -10, maxRetries: Infinity });
  await client('test-key', payload);
  await client('test-key', payload);
  assert.equal(starts[1] - starts[0], 2100);
});

test('upstream timeout releases the queue without repeating an unknown-outcome request', async () => {
  const controller = new AbortController();
  let calls = 0;
  const client = createGroqClient({
    minIntervalMs: 1,
    timeoutSignal: (ms) => { assert.equal(ms, 30000); return controller.signal; },
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls > 1) return ok();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
  const first = client('test-key', payload);
  const rejection = assert.rejects(first, /timed out/);
  const next = client('test-key', payload);
  await Promise.resolve();
  controller.abort(new Error('upstream timed out'));
  await rejection;
  assert.equal((await next).status, 200);
  assert.equal(calls, 2);
});

test('beforeAttempt runs for every actual dispatch, including rate-limit retries', async () => {
  const { client, starts } = fixture([limited(), limited(), ok()]);
  let attempts = 0;
  await assert.rejects(client('test-key', payload, { beforeAttempt: () => {
    if (attempts === 2) throw new Error('job attempt budget exhausted');
    attempts += 1;
  } }), /budget exhausted/);
  assert.equal(attempts, 2);
  assert.equal(starts.length, 2);
});

test('cancelling a queued request returns promptly without dispatching it', async () => {
  let release;
  let calls = 0;
  let time = 0;
  const client = createGroqClient({
    now: () => time, sleep: async (ms) => { time += ms; },
    fetchImpl: async () => { calls += 1; return new Promise((resolve) => { release = () => resolve(ok()); }); },
  });
  const first = client('key', payload);
  const controller = new AbortController();
  const queued = client('key', payload, { signal: controller.signal });
  const rejected = assert.rejects(queued, /cancelled/);
  await Promise.resolve();
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(calls, 1);
  release(); await first;
  await Promise.resolve();
  assert.equal(calls, 1);
});

test('cancellation during cooldown prevents the next provider attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  let waiting;
  const enteredWait = new Promise((resolve) => { waiting = resolve; });
  const client = createGroqClient({
    now: () => 0,
    sleep: () => { waiting(); return new Promise(() => {}); },
    fetchImpl: async () => { calls += 1; return limited(); },
  });
  const pending = client('key', payload, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await enteredWait;
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal(calls, 1);
});

test('cancellation reaches an in-flight fetch and leaves the shared queue usable', async () => {
  let calls = 0;
  let time = 0;
  const client = createGroqClient({
    now: () => time, sleep: async (ms) => { time += ms; },
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      if (calls > 1) return ok();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  const controller = new AbortController();
  const pending = client('key', payload, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancelled/);
  await Promise.resolve();
  controller.abort(new Error('cancelled'));
  await rejected;
  assert.equal((await client('key', payload)).status, 200);
  assert.equal(calls, 2);
});

test('the deadline remains connected after headers while the response body is being read', async () => {
  const timeout = new AbortController();
  const job = new AbortController();
  let fetchSignal;
  const client = createGroqClient({
    timeoutSignal: () => timeout.signal,
    fetchImpl: async (_url, { signal }) => { fetchSignal = signal; return ok(); },
  });
  await client('key', payload, { signal: job.signal });
  assert.equal(fetchSignal.aborted, false);
  timeout.abort(new Error('body timed out'));
  assert.equal(fetchSignal.aborted, true);
  assert.match(fetchSignal.reason.message, /body timed out/);
});
