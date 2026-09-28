import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLlmPayload, normalizeNumericAnswer, solveMcq } from './llmService.js';

const payload = { q: 'Which choice?', o: { A: 'First', B: 'Second' } };

function mockResponse(t, data, status = 200) {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    request = { url, ...options };
    return { ok: status < 400, status, json: async () => data };
  });
  return () => request;
}

test('sends only question/options and config, preserving cache metadata and zero timings', async (t) => {
  const usage = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 };
  const getRequest = mockResponse(t, {
    success: true,
    answer: ' b ',
    cacheHit: true,
    deduplicated: false,
    usage,
    timings: { t3_backend_to_llm_ms: 0, t4_llm_inference_ms: 0, t3_t4_total_ms: 0 },
  });
  const formatted = formatLlmPayload({ llmPayload: { ...payload, fullHtml: '<html>large</html>' } });
  assert.deepEqual(formatted, payload);
  const solution = await solveMcq(formatted, { apiKey: ' key ', model: ' model ', maxTokens: 128 });
  assert.deepEqual(JSON.parse(getRequest().body), {
    ...payload, answerType: 'mcq', apiKey: 'key', model: 'model', maxTokens: 128, turbo: true,
  });
  assert.equal(solution.answer, 'B');
  assert.equal(solution.cacheHit, true);
  assert.equal(solution.deduplicated, false);
  assert.equal(solution.confidence, null);
  assert.deepEqual(solution.usage, usage);
  assert.equal(solution.timings.t3_backend_to_llm_ms, 0);
  assert.equal(solution.timings.t4_llm_inference_ms, 0);
});

test('keeps absent timings unknown and preserves legitimate zero confidence', async (t) => {
  mockResponse(t, { success: true, answer: 'A', confidence: 0, deduplicated: true });
  const solution = await solveMcq(payload);
  assert.equal(solution.confidence, 0);
  assert.equal(solution.deduplicated, true);
  assert.equal(solution.usage, null);
  assert.equal(solution.timings.t3_backend_to_llm_ms, null);
  assert.equal(solution.timings.t4_llm_inference_ms, null);
  assert.equal(solution.timings.t2_t5_network_ms, null);
});

test('HTTP status reaches callers when the backend exhausts retries', async (t) => {
  mockResponse(t, { success: false, error: 'Rate limit reached' }, 429);
  await assert.rejects(solveMcq(payload), { message: 'Rate limit reached', status: 429 });
});

test('non-JSON HTTP failures also retain their status', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: false, status: 503, json: async () => { throw new SyntaxError('Invalid JSON'); },
  }));
  await assert.rejects(solveMcq(payload), { status: 503 });
});

test('rejects an answer outside the submitted option keys', async (t) => {
  mockResponse(t, { success: true, answer: 'C' });
  await assert.rejects(solveMcq(payload), /does not match the available option keys/);
});

test('does not turn prose into an option letter', async (t) => {
  mockResponse(t, { success: true, answer: 'Option B' });
  await assert.rejects(solveMcq(payload), /does not match the available option keys/);
});

test('formats numeric questions without an options requirement or DOM metadata', () => {
  assert.deepEqual(formatLlmPayload({
    answerType: 'numeric', questionText: '  How many registers?  ', options: [],
    inputValue: '', targetDescriptor: { id: 'answer-input' },
  }), { q: 'How many registers?', answerType: 'numeric' });
  assert.deepEqual(formatLlmPayload({
    llmPayload: { q: 'How many registers?', answerType: 'numeric', fullHtml: 'large' },
  }), { q: 'How many registers?', answerType: 'numeric' });
});

test('numeric requests preserve decimal/scientific text and cache metadata', async (t) => {
  const getRequest = mockResponse(t, {
    success: true, answerType: 'numeric', answer: ' -1.25e-3 ', cacheHit: true,
    timings: { t3_t4_total_ms: 0 },
  });
  const solution = await solveMcq({ q: 'Calculate the value.', answerType: 'numeric' });
  assert.deepEqual(JSON.parse(getRequest().body), {
    q: 'Calculate the value.', answerType: 'numeric', turbo: true,
  });
  assert.equal(solution.answer, '-1.25e-3');
  assert.equal(solution.answerType, 'numeric');
  assert.equal(solution.cacheHit, true);
});

test('zero is retained in a numeric response', async (t) => {
  mockResponse(t, { success: true, answerType: 'numeric', answer: 0 });
  const solution = await solveMcq({ q: 'What is zero minus zero?', answerType: 'numeric' });
  assert.equal(solution.answer, '0');
});

test('numeric validation accepts finite decimal/scientific strings without rewriting them', () => {
  for (const value of ['0', '-0', '6.0', '-12', '+0.5', '.25', '-.75', '3.', '1e3', '-1.25E-3']) {
    assert.equal(normalizeNumericAnswer(value), value);
  }
});

test('numeric validation rejects missing, non-finite, fractional, unit and prose answers', () => {
  for (const value of [undefined, null, false, [], {}, '', ' ', 'NaN', 'Infinity', '-Infinity', '1e400', '1/2', '6 registers', 'Answer: 6', '0x10', '1,000']) {
    assert.throws(() => normalizeNumericAnswer(value), /numeric answer|finite decimal/);
  }
});

test('invalid numeric responses are rejected before callers can fill a field', async (t) => {
  mockResponse(t, { success: true, answerType: 'numeric', answer: '6 registers' });
  await assert.rejects(solveMcq({ q: 'How many?', answerType: 'numeric' }), /finite decimal/);
});

test('a mismatched response type cannot be applied', async (t) => {
  mockResponse(t, { success: true, answerType: 'mcq', answer: 'A' });
  await assert.rejects(solveMcq({ q: 'How many?', answerType: 'numeric' }), /different question type/);
});

for (const answerType of ['mcq', 'numeric']) {
  test(`${answerType} requests preserve ordered images and surface vision rejection without a text-only retry`, async (t) => {
    const images = ['https://example.test/first.png', 'data:image/png;base64,aGVsbG8='];
    const formatted = formatLlmPayload({ answerType, questionText: 'Read the diagrams',
      options: [{ text: 'First' }], images });
    assert.deepEqual(formatted.images, images);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      requests++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body.images, images);
      assert.equal(body.model, 'selected-model');
      assert.equal(body.maxTokens, 512);
      return { ok: false, status: 400, json: async () => ({ success: false, error: 'Model cannot process images' }) };
    });
    await assert.rejects(solveMcq(formatted, { model: 'selected-model', maxTokens: 512 }), /cannot process images/);
    assert.equal(requests, 1);
  });
}

test('unreadable or excessive diagrams cannot silently become a text-only payload', () => {
  assert.throws(() => formatLlmPayload({ imageExtractionError: 'Question diagram could not be read' }), /could not be read/);
  assert.throws(() => formatLlmPayload({ images: Array(4).fill('https://example.test/graph.png') }), /at most three/);
});
