const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const clientPath = path.join(__dirname, 'groqClient.js');
const servicePath = require.resolve('./llmService');
const question = {
  q: 'Which number is even?',
  o: { A: '1', B: '2', C: '3', D: '5' },
  apiKey: 'test-api-key',
  model: 'test-model',
  turbo: true,
};
const numericQuestion = {
  q: 'How many registers are available? Give a numerical answer.',
  answerType: 'numeric',
  apiKey: 'test-api-key',
  model: 'test-model',
  turbo: true,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, message, extra = {}) {
  return jsonResponse({ error: { message, ...extra } }, status);
}

async function withGroqResponses(responses, run) {
  const previousClient = require.cache[clientPath];
  const previousService = require.cache[servicePath];
  const previousFetch = globalThis.fetch;
  const calls = [];

  // Tests stop at the Groq client boundary; retries and timing are tested there.
  require.cache[clientPath] = {
    id: clientPath,
    filename: clientPath,
    loaded: true,
    exports: {
      requestGroq: async (apiKey, body) => {
        calls.push({ apiKey, body });
        const response = typeof responses === 'function'
          ? await responses({ apiKey, body }, calls)
          : responses[calls.length - 1];
        assert.ok(response, 'Unexpected additional Groq request');
        return response;
      },
    },
  };
  delete require.cache[servicePath];
  globalThis.fetch = async () => {
    throw new Error('Unexpected fetch: this test must use the mocked Groq client');
  };

  try {
    const { solveMcq } = require('./llmService');
    await run({ solveMcq, calls });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousClient) require.cache[clientPath] = previousClient;
    else delete require.cache[clientPath];
    if (previousService) require.cache[servicePath] = previousService;
    else delete require.cache[servicePath];
  }
}

test('exhausted primary 429 propagates without a plain-text fallback', async () => {
  const message = 'Rate limit reached: requests per minute limit is 30';
  await withGroqResponses([errorResponse(429, message)], async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq(question), (error) => {
      assert.equal(error.status, 429);
      assert.ok(error.message.includes(message));
      return true;
    });
    assert.equal(calls.length, 1);
  });
});

for (const status of [401, 403]) {
  test(`primary ${status} propagates without retry or fallback`, async () => {
    const message = `Provider authentication failure ${status}`;
    await withGroqResponses([errorResponse(status, message)], async ({ solveMcq, calls }) => {
      await assert.rejects(solveMcq(question), (error) => {
        assert.equal(error.status, status);
        assert.ok(error.message.includes(message));
        return true;
      });
      assert.equal(calls.length, 1);
    });
  });
}

for (const status of [429, 401]) {
  test(`fallback ${status} preserves its own status and message after a JSON error`, async () => {
    const message = `Fallback provider failure ${status}`;
    const responses = [
      errorResponse(400, 'Failed to generate JSON', { code: 'json_validate_failed' }),
      errorResponse(status, message),
    ];

    await withGroqResponses(responses, async ({ solveMcq, calls }) => {
      await assert.rejects(solveMcq(question), (error) => {
        assert.equal(error.status, status);
        assert.ok(error.message.includes(message));
        return true;
      });
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
      assert.equal(calls[1].body.response_format, undefined);
    });
  });
}

test('successful primary response still returns the selected answer', async () => {
  const response = jsonResponse({ choices: [{ message: { content: '{"a":"B"}' } }] });
  await withGroqResponses([response], async ({ solveMcq, calls }) => {
    const result = await solveMcq(question);
    assert.equal(result.success, true);
    assert.equal(result.answer, 'B');
    assert.equal(result.modelUsed, question.model);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].apiKey, question.apiKey);
  });
});

test('JSON validation failures can still recover through a successful fallback', async () => {
  const responses = [
    errorResponse(400, 'Failed to generate JSON', { code: 'json_validate_failed' }),
    jsonResponse({ choices: [{ message: { content: 'B' } }] }),
  ];
  await withGroqResponses(responses, async ({ solveMcq, calls }) => {
    const result = await solveMcq(question);
    assert.equal(result.success, true);
    assert.equal(result.answer, 'B');
    assert.equal(calls.length, 2);
  });
});

function answerResponse(answer = 'B', extra = {}) {
  return jsonResponse({ choices: [{ message: { content: JSON.stringify({ a: answer }) } }], ...extra });
}

for (const content of [
  '{"a":"Z"}',
  '{"a":"Option B"}',
  '{"thought":"After reviewing, insufficient information"}',
  'The answer is B.',
  '{"a":"A","answer":"B"}',
  '{"a":["A","B"]}',
  '{"a":null}',
]) {
  test(`rejects an unsupported or ambiguous answer: ${content}`, async () => {
    const response = jsonResponse({ choices: [{ message: { content } }] });
    await withGroqResponses([response], async ({ solveMcq, calls }) => {
      await assert.rejects(solveMcq(question), { status: 502 });
      assert.equal(calls.length, 1);
    });
  });
}

test('validates against the actual option map, including keys outside A-D', async () => {
  await withGroqResponses([answerResponse('e')], async ({ solveMcq }) => {
    const result = await solveMcq({ ...question, o: { E: '2', F: '3' } });
    assert.equal(result.answer, 'E');
    assert.equal(result.confidence, null);
  });
});

test('complete fenced JSON with a provided key remains supported', async () => {
  const response = jsonResponse({ choices: [{ message: { content: '```json\n{"a":"B"}\n```' } }] });
  await withGroqResponses([response], async ({ solveMcq }) => {
    assert.equal((await solveMcq(question)).answer, 'B');
  });
});

test('failed-generation prose is not mistaken for an option letter', async () => {
  const responses = [
    errorResponse(400, 'Failed to generate JSON', {
      code: 'json_validate_failed',
      failed_generation: 'Derivation incomplete',
    }),
    answerResponse('B'),
  ];
  await withGroqResponses(responses, async ({ solveMcq, calls }) => {
    assert.equal((await solveMcq(question)).answer, 'B');
    assert.equal(calls.length, 2);
  });
});

test('valid failed-generation JSON can be reused without a fallback call', async () => {
  const response = errorResponse(400, 'Failed to generate JSON', {
    code: 'json_validate_failed',
    failed_generation: '{"a":"B"}',
  });
  await withGroqResponses([response], async ({ solveMcq, calls }) => {
    const result = await solveMcq(question);
    assert.equal(result.answer, 'B');
    assert.equal(result.recovered, true);
    assert.equal(result.usage, null);
    assert.equal(calls.length, 1);
  });
});

test('terminal rate-limit errors cannot be turned into a recovered answer', async () => {
  const response = errorResponse(429, 'Rate limited', { failed_generation: '{"a":"B"}' });
  await withGroqResponses([response], async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq(question), { status: 429 });
    assert.equal(calls.length, 1);
  });
});

test('reports provider usage and timing, then reuses a separate cached response', async () => {
  const response = jsonResponse({
    choices: [{ message: { content: '{"a":"B","confidence":0,"reason":"Two is even."}' } }],
    usage: {
      prompt_tokens: 40,
      completion_tokens: 4,
      total_tokens: 44,
      prompt_time: 0.01,
      completion_time: 0.02,
      queue_time: 0.03,
      total_time: 0.06,
    },
  });
  await withGroqResponses([response], async ({ solveMcq, calls }) => {
    const first = await solveMcq({ ...question, tBackendReceivedAt: 10 });
    assert.deepEqual(first.usage, { prompt_tokens: 40, completion_tokens: 4, total_tokens: 44 });
    assert.deepEqual(first.providerTimings, { promptMs: 10, completionMs: 20, queueMs: 30, totalMs: 60 });
    assert.equal(first.timings.t4_llm_inference_ms, 30);
    assert.equal(first.timings.t3_backend_to_llm_ms, null);
    assert.equal(first.confidence, 0);
    assert.equal(first.cacheHit, false);
    first.answer = 'C';
    first.sourceUsage.total_tokens = 999;

    const second = await solveMcq({ ...question, tBackendReceivedAt: 20 });
    assert.equal(second.answer, 'B');
    assert.equal(second.cacheHit, true);
    assert.equal(second.usage, null);
    assert.equal(second.sourceUsage.total_tokens, 44);
    assert.equal(second.providerTimings, null);
    assert.equal(second.timings.t3_t4_total_ms, 0);
    assert.equal(second.serverReceivedAt, 20);
    assert.equal(calls.length, 1);
  });
});

test('missing provider usage and timing remain unknown', async () => {
  await withGroqResponses([answerResponse()], async ({ solveMcq }) => {
    const result = await solveMcq(question);
    assert.equal(result.confidence, null);
    assert.equal(result.usage, null);
    assert.equal(result.timings.t4_llm_inference_ms, null);
    assert.deepEqual(result.providerTimings, { promptMs: null, completionMs: null, totalMs: null, queueMs: null });
  });
});

test('identical concurrent requests share one provider call', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await withGroqResponses(() => pending, async ({ solveMcq, calls }) => {
    const first = solveMcq(question);
    const second = solveMcq({ ...question });
    release(answerResponse('B', { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
    const [one, two] = await Promise.all([first, second]);
    assert.equal(calls.length, 1);
    assert.equal(one.deduplicated, false);
    assert.equal(two.deduplicated, true);
    assert.equal(two.answer, 'B');
    assert.equal(two.usage, null);
    assert.equal(two.sourceUsage.total_tokens, 14);
    assert.equal((await solveMcq(question)).cacheHit, true);
  });
});

test('cache identity includes credentials, model, full input, mode and effective token budget', async () => {
  const base = { ...question, maxTokens: 256 };
  const variants = [
    { ...base, apiKey: 'different-test-key' },
    { ...base, model: 'different-model' },
    { ...base, q: base.q + ' ' },
    { ...base, o: { ...base.o, B: '4' } },
    { ...base, turbo: false },
    { ...base, maxTokens: 128 },
  ];
  await withGroqResponses(() => answerResponse(), async ({ solveMcq, calls }) => {
    await solveMcq(base);
    for (const variant of variants) assert.equal((await solveMcq(variant)).cacheHit, false);
    const reordered = { D: '5', C: '3', B: '2', A: '1' };
    assert.equal((await solveMcq({ ...base, o: reordered })).cacheHit, true);
    assert.equal(calls.length, variants.length + 1);
  });
});

test('failed in-flight work is shared and cleared so the next request can retry', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await withGroqResponses((_, calls) => calls.length === 1 ? pending : answerResponse(), async ({ solveMcq, calls }) => {
    const results = Promise.allSettled([solveMcq(question), solveMcq(question)]);
    release(errorResponse(429, 'Rate limited'));
    for (const result of await results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.status, 429);
    }
    assert.equal(calls.length, 1);
    assert.equal((await solveMcq(question)).cacheHit, false);
    assert.equal((await solveMcq(question)).cacheHit, true);
    assert.equal(calls.length, 2);
  });
});

test('invalid answers are not cached', async () => {
  await withGroqResponses([answerResponse('Z'), answerResponse()], async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq(question), { status: 502 });
    assert.equal((await solveMcq(question)).answer, 'B');
    assert.equal(calls.length, 2);
  });
});

test('token budgets are capped by mode while lower requested limits are retained', async () => {
  await withGroqResponses(() => answerResponse(), async ({ solveMcq, calls }) => {
    await solveMcq({ ...question, maxTokens: 2048 });
    await solveMcq({ ...question, turbo: false, maxTokens: 8192 });
    await solveMcq({ ...question, maxTokens: 128 });
    assert.deepEqual(calls.map((call) => call.body.max_tokens), [512, 2048, 128]);
    assert.equal((await solveMcq({ ...question, maxTokens: 512 })).cacheHit, true);
  });
});

test('Qwen turbo disables reasoning on primary and fallback without affecting other modes or models', async () => {
  await withGroqResponses((_, calls) => calls.length === 1
    ? errorResponse(400, 'Failed to generate JSON', { code: 'json_validate_failed' })
    : answerResponse(), async ({ solveMcq, calls }) => {
    await solveMcq({ ...question, model: 'qwen/qwen3.8-27b' });
    await solveMcq({ ...question, model: 'qwen/qwen3.8-27b', turbo: false });
    await solveMcq(question);
    assert.deepEqual(calls.map((call) => call.body.reasoning_effort), ['none', 'none', undefined, undefined]);
  });
});

test('image questions preserve the selected model and image context in primary and fallback calls', async () => {
  const images = ['https://images.example/diagram.png', 'data:image/png;base64,aGVsbG8='];
  await withGroqResponses([
    errorResponse(400, 'Failed to generate JSON', { code: 'json_validate_failed' }),
    answerResponse(),
  ], async ({ solveMcq, calls }) => {
    const result = await solveMcq({ ...question, images });
    assert.equal(result.answer, 'B');
    assert.equal(result.modelUsed, question.model);
    assert.equal(calls.length, 2);
    for (const { body } of calls) {
      assert.equal(body.model, question.model);
      assert.deepEqual(body.messages[1].content, [
        { type: 'text', text: JSON.stringify({ q: question.q, o: question.o }) },
        ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]);
      assert.equal(body.max_tokens, 512);
    }
  });
});

test('image identity and order are included in cached question identity', async () => {
  const images = ['https://images.example/one.png', 'https://images.example/two.png'];
  await withGroqResponses(() => answerResponse(), async ({ solveMcq, calls }) => {
    await solveMcq(question);
    const first = await solveMcq({ ...question, images });
    const repeated = await solveMcq({ ...question, images: [...images] });
    const changed = await solveMcq({ ...question, images: [images[0]] });
    const reordered = await solveMcq({ ...question, images: [...images].reverse() });
    assert.equal(first.cacheHit, false);
    assert.equal(repeated.cacheHit, true);
    assert.equal(changed.cacheHit, false);
    assert.equal(reordered.cacheHit, false);
    assert.equal(calls.length, 4);
  });
});

test('image rejection is visible without retrying as a text-only question', async () => {
  await withGroqResponses([errorResponse(400, 'Invalid image data in image_url')], async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq({ ...question, images: ['https://images.example/diagram.png'] }), {
      status: 400, message: 'Invalid image data in image_url',
    });
    assert.equal(calls.length, 1);
  });
});

test('invalid or excessive image context is rejected instead of silently discarded', async () => {
  const inputs = [
    'https://images.example/diagram.png',
    [null],
    ['https://images.example/diagram.SVG?size=2'],
    ['blob:https://images.example/image'],
    ['data:image/svg+xml;base64,aGVsbG8='],
    ['data:image/png;garbage'],
    ['https://username:password@images.example/diagram.png'],
    Array(4).fill('https://images.example/diagram.png'),
  ];
  await withGroqResponses([], async ({ solveMcq, calls }) => {
    for (const images of inputs) await assert.rejects(solveMcq({ ...question, images }), { status: 400 });
    assert.equal(calls.length, 0);
  });
});

test('numerical questions can include images without an options map', async () => {
  const images = ['https://images.example/registers.webp'];
  await withGroqResponses([answerResponse('6.0')], async ({ solveMcq, calls }) => {
    const result = await solveMcq({ ...numericQuestion, images });
    assert.equal(result.answer, '6.0');
    assert.equal(result.answerType, 'numeric');
    assert.deepEqual(calls[0].body.messages[1].content, [
      { type: 'text', text: JSON.stringify({ q: numericQuestion.q }) },
      { type: 'image_url', image_url: { url: images[0] } },
    ]);
  });
});

test('incoming structured answer aliases remain strict and cannot override a conflicting answer', async () => {
  const aliases = ['option', 'choice', 'key', 'selected'];
  await withGroqResponses((_, calls) => jsonResponse({
    choices: [{ message: { content: JSON.stringify({ [aliases[calls.length - 1]]: 'B' }) } }],
  }), async ({ solveMcq }) => {
    for (const alias of aliases) assert.equal((await solveMcq({ ...question, q: question.q + alias })).answer, 'B');
  });
  await withGroqResponses([jsonResponse({ choices: [{ message: { content: '{"a":"B","choice":"C"}' } }] })], async ({ solveMcq }) => {
    await assert.rejects(solveMcq(question), { status: 502 });
  });
});

test('provider transport failure retains the incoming meaningful gateway error', async () => {
  await withGroqResponses(() => { throw new Error('connection closed'); }, async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq(question), {
      status: 502, message: 'Network failure calling Groq API: connection closed',
    });
    assert.equal(calls.length, 1);
  });
});

for (const value of ['0', 0, '-12', '-0.125', '6.0', '1.25e-3', '+2.5E+4', '.5']) {
  test(`numerical questions accept a finite numeric answer: ${JSON.stringify(value)}`, async () => {
    await withGroqResponses([answerResponse(value)], async ({ solveMcq, calls }) => {
      const result = await solveMcq(numericQuestion);
      assert.equal(result.answer, String(value));
      assert.equal(typeof result.answer, 'string');
      assert.equal(result.answerType, 'numeric');
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(calls[0].body.messages[1].content), { q: numericQuestion.q });
    });
  });
}

for (const value of [
  '6 cm', 'The answer is 6', '1,2', '1 2', '6\n7', '1/2', '2+4',
  'NaN', 'Infinity', '-Infinity', '1e309', '', ' ', '0x10', [1, 2], null, false,
]) {
  test(`numerical questions reject invalid answer: ${JSON.stringify(value)}`, async () => {
    await withGroqResponses([answerResponse(value)], async ({ solveMcq, calls }) => {
      await assert.rejects(solveMcq(numericQuestion), { status: 502 });
      assert.equal(calls.length, 1);
    });
  });
}

for (const content of ['{"a":1e309}', '{"a":"6","answer":"7"}', '{"reason":"6"}']) {
  test(`numerical JSON rejects nonfinite, conflicting or missing answers: ${content}`, async () => {
    const response = jsonResponse({ choices: [{ message: { content } }] });
    await withGroqResponses([response], async ({ solveMcq }) => {
      await assert.rejects(solveMcq(numericQuestion), { status: 502 });
    });
  });
}

test('plain numerical fallback preserves decimal precision and numeric prompt constraints', async () => {
  const responses = [
    errorResponse(400, 'Failed to generate JSON', { code: 'json_validate_failed' }),
    jsonResponse({ choices: [{ message: { content: '6.0' } }] }),
  ];
  await withGroqResponses(responses, async ({ solveMcq, calls }) => {
    const result = await solveMcq({ ...numericQuestion, model: 'qwen/qwen3.8-27b', maxTokens: 2048 });
    assert.equal(result.answer, '6.0');
    assert.equal(result.answerType, 'numeric');
    assert.equal(result.recovered, true);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.body.messages[0].content, /rounding and precision requirements/);
      assert.match(call.body.messages[0].content, /finite decimal or scientific-notation number/);
      assert.equal(call.body.reasoning_effort, 'none');
      assert.equal(call.body.max_tokens, 512);
    }
    assert.equal(calls[1].body.response_format, undefined);
  });
});

test('numerical failures do not poison the cache', async () => {
  await withGroqResponses([answerResponse('6 cm'), answerResponse('6.0')], async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq(numericQuestion), { status: 502 });
    const result = await solveMcq(numericQuestion);
    assert.equal(result.answer, '6.0');
    assert.equal(result.cacheHit, false);
    assert.equal((await solveMcq(numericQuestion)).cacheHit, true);
    assert.equal(calls.length, 2);
  });
});

test('MCQ and numerical cache entries remain distinct for the same question', async () => {
  await withGroqResponses([answerResponse('B'), answerResponse('6.0')], async ({ solveMcq, calls }) => {
    const mcq = { ...question, q: numericQuestion.q };
    const numeric = { ...mcq, answerType: 'numeric' };
    const first = await solveMcq(mcq);
    const second = await solveMcq(numeric);
    assert.equal(first.answer, 'B');
    assert.equal(first.answerType, 'mcq');
    assert.equal(second.answer, '6.0');
    assert.equal(second.answerType, 'numeric');
    assert.equal(second.cacheHit, false);
    assert.equal((await solveMcq({ ...mcq, answerType: 'mcq' })).cacheHit, true);
    assert.equal((await solveMcq(numericQuestion)).cacheHit, true);
    assert.equal(calls.length, 2);
  });
});

test('identical numerical requests share in-flight work without losing zero answers', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await withGroqResponses(() => pending, async ({ solveMcq, calls }) => {
    const results = Promise.all([solveMcq(numericQuestion), solveMcq(numericQuestion)]);
    release(answerResponse(0));
    const [first, second] = await results;
    assert.equal(first.answer, '0');
    assert.equal(second.answer, '0');
    assert.equal(second.deduplicated, true);
    assert.equal(calls.length, 1);
  });
});

test('detailed numerical answers preserve explanation, usage and the detailed token cap', async () => {
  const response = jsonResponse({
    choices: [{ message: { content: '{"a":"6.0","reason":"There are six registers."}' } }],
    usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
  });
  await withGroqResponses([response], async ({ solveMcq, calls }) => {
    const result = await solveMcq({ ...numericQuestion, turbo: false, maxTokens: 8192 });
    assert.equal(result.answer, '6.0');
    assert.equal(result.reason, 'There are six registers.');
    assert.equal(result.usage.total_tokens, 40);
    assert.equal(calls[0].body.max_tokens, 2048);
    assert.match(calls[0].body.messages[0].content, /brief explanation/);
  });
});

test('unsupported answer types and MCQ payloads without options fail before a provider call', async () => {
  await withGroqResponses([], async ({ solveMcq, calls }) => {
    await assert.rejects(solveMcq({ ...numericQuestion, answerType: 'text' }), { status: 400 });
    await assert.rejects(solveMcq({ ...numericQuestion, answerType: 'mcq' }), { status: 400 });
    await assert.rejects(solveMcq({ ...numericQuestion, q: ' ' }), { status: 400 });
    assert.equal(calls.length, 0);
  });
});

test('solve route forwards numeric answerType and images without requiring options', async () => {
  const routePath = require.resolve('../routes/solveRoutes');
  const previousRoute = require.cache[routePath];
  await withGroqResponses([answerResponse('6.0')], async ({ calls }) => {
    delete require.cache[routePath];
    try {
      const router = require('../routes/solveRoutes');
      const handler = router.stack.find((layer) => layer.route?.methods.post).route.stack[0].handle;
      let sent;
      const response = {
        status(code) { throw new Error(`Unexpected route status: ${code}`); },
        json(body) { sent = body; },
      };
      const images = ['https://images.example/registers.png'];
      await handler({ body: { ...numericQuestion, images } }, response);
      assert.equal(sent.answer, '6.0');
      assert.equal(sent.answerType, 'numeric');
      assert.equal(sent.success, true);
      assert.deepEqual(calls[0].body.messages[1].content[1], { type: 'image_url', image_url: { url: images[0] } });
    } finally {
      if (previousRoute) require.cache[routePath] = previousRoute;
      else delete require.cache[routePath];
    }
  });
});
