const { createHash } = require('node:crypto');
const { requestGroq } = require('./groqClient');
const { createSolutionCache } = require('./solutionCache');

const TURBO_TOKEN_LIMIT = 512;
const DETAILED_TOKEN_LIMIT = 2048;

function nonnegativeInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

const cacheTtlMs = nonnegativeInteger(process.env.GROQ_CACHE_TTL_MS, 15 * 60 * 1000);
const cacheMaxEntries = nonnegativeInteger(process.env.GROQ_CACHE_MAX_ENTRIES, 200);
const solutionCache = createSolutionCache({ ttlMs: cacheTtlMs, maxEntries: cacheMaxEntries });

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function effectiveTokenLimit(requested, turbo) {
  const limit = turbo ? TURBO_TOKEN_LIMIT : DETAILED_TOKEN_LIMIT;
  const tokens = Number(requested ?? process.env.GROQ_MAX_TOKENS);
  return Number.isSafeInteger(tokens) && tokens > 0 ? Math.min(tokens, limit) : limit;
}

function normalizeImages(images) {
  if (!Array.isArray(images) || images.length > 3) {
    throw requestError('Invalid images: provide an array containing at most three images.');
  }
  for (const image of images) {
    let valid = typeof image === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image);
    if (!valid && typeof image === 'string') {
      try {
        const url = new URL(image);
        valid = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
          !/\.svg$/i.test(url.pathname);
      } catch {}
    }
    if (!valid) throw requestError('Invalid image: use a JPEG, PNG or WEBP base64 data URL, or a non-SVG HTTP(S) image URL.');
  }
  return images.slice();
}

function optionKey(value, options) {
  if (typeof value !== 'string') return null;
  const answer = value.trim();
  if (Object.hasOwn(options, answer)) return answer;
  const matches = Object.keys(options).filter((key) => key.toUpperCase() === answer.toUpperCase());
  return matches.length === 1 ? matches[0] : null;
}

function numericAnswer(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const answer = String(value).trim();
  const decimal = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  return decimal.test(answer) && Number.isFinite(Number(answer)) ? answer : null;
}

function parseAnswer(content, options, answerType) {
  const invalidAnswer = () => {
    const message = answerType === 'numeric'
      ? 'LLM answer must be one finite decimal or scientific-notation number without units or other text.'
      : 'LLM answer did not match a single provided option key.';
    const error = requestError(message, 502);
    error.raw = content;
    return error;
  };
  if (typeof content !== 'string') throw invalidAnswer();

  let text = content.trim();
  const fenced = text.match(/^\x60{3}(?:json)?\s*([\s\S]*?)\s*\x60{3}$/i);
  if (fenced) text = fenced[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
    // Preserve the spelling of a plain numeric response, including decimal precision.
    if (answerType === 'numeric' && typeof parsed === 'number') parsed = text;
  } catch {
    parsed = text;
  }

  const isObject = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  const candidates = isObject
    ? ['a', 'answer', 'ans', 'option', 'choice', 'key', 'selected'].filter((key) => Object.hasOwn(parsed, key)).map((key) => parsed[key])
    : [parsed];
  const answers = candidates.map((candidate) => answerType === 'numeric'
    ? numericAnswer(candidate) : optionKey(candidate, options));
  if (!answers.length || answers.some((answer) => !answer || answer !== answers[0])) {
    throw invalidAnswer();
  }

  const reason = isObject
    ? [parsed.reason, parsed.explanation, parsed.r].find((value) => typeof value === 'string') || ''
    : '';
  const confidence = isObject && Number.isFinite(parsed.confidence)
    && parsed.confidence >= 0 && parsed.confidence <= 100 ? parsed.confidence : null;
  return { answer: answers[0], reason, confidence };
}

function providerMetadata(usage) {
  const reportedNumber = (key) => Number.isFinite(usage?.[key]) && usage[key] >= 0 ? usage[key] : null;
  const milliseconds = (key) => {
    const value = reportedNumber(key);
    return value === null ? null : Math.round(value * 1000);
  };
  const tokens = {
    prompt_tokens: reportedNumber('prompt_tokens'),
    completion_tokens: reportedNumber('completion_tokens'),
    total_tokens: reportedNumber('total_tokens'),
  };
  return {
    usage: Object.values(tokens).some((value) => value !== null) ? tokens : null,
    providerTimings: {
      promptMs: milliseconds('prompt_time'),
      completionMs: milliseconds('completion_time'),
      totalMs: milliseconds('total_time'),
      queueMs: milliseconds('queue_time'),
    },
  };
}

async function providerError(response) {
  const text = await response.text();
  let details;
  try {
    details = JSON.parse(text).error;
  } catch {}
  return {
    error: requestError(details?.message || text || 'Groq API responded with status ' + response.status, response.status),
    failedGeneration: typeof details?.failed_generation === 'string' ? details.failed_generation : '',
    code: details?.code,
  };
}

async function requestProvider(apiKey, body) {
  try {
    return await requestGroq(apiKey, body);
  } catch (error) {
    if (error.status) throw error;
    throw requestError(`Network failure calling Groq API: ${error.message}`, 502);
  }
}

async function queryProvider({ q, o, images, answerType, apiKey, model, turbo, maxTokens }) {
  const task = answerType === 'numeric'
    ? 'Solve the numerical question, following its stated rounding and precision requirements. The answer must be a single finite decimal or scientific-notation number as a string, without units, fractions, expressions, lists or prose.'
    : 'Choose the single correct key from the supplied options.';
  const answerValue = answerType === 'numeric' ? '<numeric value>' : '<key>';
  const systemPrompt = task + (turbo
    ? ` Return only JSON {"a":"${answerValue}"}.`
    : ` Return JSON {"a":"${answerValue}","reason":"<brief explanation>"}. Keep the explanation to one or two sentences.`);
  const questionText = JSON.stringify(answerType === 'numeric' ? { q } : { q, o });
  const userContent = images.length ? [
    { type: 'text', text: questionText },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ] : questionText;
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0,
    max_tokens: maxTokens,
    ...(turbo && model === 'qwen/qwen3.8-27b' ? { reasoning_effort: 'none' } : {}),
    response_format: { type: 'json_object' },
  };
  let response = await requestProvider(apiKey, body);
  let recovered = false;

  if (!response.ok) {
    const failure = await providerError(response);
    // Prompt changes cannot fix rate limits, authentication, or missing models.
    if (response.status !== 400 || (!failure.failedGeneration && failure.code !== 'json_validate_failed')) {
      throw failure.error;
    }

    if (failure.failedGeneration) {
      try {
        return {
          ...parseAnswer(failure.failedGeneration, o, answerType),
          ...providerMetadata(null),
          recovered: true,
        };
      } catch {
        // Only a complete answer valid for this question type can be recovered.
      }
    }

    response = await requestProvider(apiKey, {
      ...body,
      messages: [
        {
          role: 'system',
          content: answerType === 'numeric'
            ? 'Solve the numerical question, following its rounding and precision requirements. Return only one finite decimal or scientific-notation number. No units, fractions, expressions, lists or other text.'
            : 'Choose the single correct key from the supplied options. Return only that key, without explanation or other text.',
        },
        { role: 'user', content: userContent },
      ],
      max_tokens: Math.min(maxTokens, TURBO_TOKEN_LIMIT),
      response_format: undefined,
    });
    if (!response.ok) throw (await providerError(response)).error;
    recovered = true;
  }

  const data = await response.json();
  return {
    ...parseAnswer(data.choices?.[0]?.message?.content, o, answerType),
    ...providerMetadata(data.usage),
    recovered,
  };
}

/** Solve an MCQ or numerical question, reusing identical successful requests. */
async function solveMcq({
  q,
  o,
  answerType = 'mcq',
  images = [],
  apiKey: clientApiKey,
  model: clientModel,
  turbo = true,
  maxTokens: clientMaxTokens,
  tBackendReceivedAt = Date.now(),
}) {
  if (answerType !== 'mcq' && answerType !== 'numeric') {
    throw requestError('Invalid answerType: expected "mcq" or "numeric".');
  }
  if (typeof q !== 'string' || !q.trim()) {
    throw requestError('Invalid payload: "q" must be a non-empty question.');
  }
  if (answerType === 'mcq' && (!o || typeof o !== 'object' || Array.isArray(o)
    || !Object.keys(o).length || Object.entries(o).some(([key, value]) => !key.trim() || typeof value !== 'string'))) {
    throw requestError('Invalid payload: "q" must be a question and "o" must map option keys to text.');
  }

  const questionImages = normalizeImages(images);
  const apiKey = (clientApiKey || process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    throw requestError('Groq API Key is missing. Add GROQ_API_KEY to backend/.env or enter it in extension settings.');
  }
  const model = (clientModel || process.env.GROQ_MODEL || 'qwen/qwen3.8-27b').trim();
  const isTurbo = Boolean(turbo);
  const maxTokens = effectiveTokenLimit(clientMaxTokens, isTurbo);
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const cacheKey = hash(JSON.stringify({
    credential: hash(apiKey),
    model,
    q,
    answerType,
    images: questionImages,
    options: answerType === 'mcq' ? Object.entries(o).sort(([left], [right]) => left.localeCompare(right)) : null,
    turbo: isTurbo,
    maxTokens,
  }));
  const startedAt = Date.now();

  try {
    const cached = await solutionCache.getOrCreate(cacheKey, () => queryProvider({
      q, o, images: questionImages, answerType, apiKey, model, turbo: isTurbo, maxTokens,
    }));
    // Callers receive separate objects so changing a response cannot change the cache.
    const result = structuredClone(cached.value);
    const reused = cached.cacheHit || cached.deduplicated;
    const providerTimings = reused ? null : result.providerTimings;
    const inferenceMs = Number.isFinite(providerTimings?.promptMs) && Number.isFinite(providerTimings?.completionMs)
      ? providerTimings.promptMs + providerTimings.completionMs
      : null;
    return {
      success: true,
      answer: result.answer,
      answerType,
      reason: result.reason,
      confidence: result.confidence,
      modelUsed: model,
      turbo: isTurbo,
      maxTokens,
      recovered: result.recovered,
      cacheHit: cached.cacheHit,
      deduplicated: cached.deduplicated,
      usage: reused ? null : result.usage,
      sourceUsage: result.usage,
      providerTimings,
      timings: {
        t3_backend_to_llm_ms: null,
        t4_llm_inference_ms: inferenceMs,
        t3_t4_total_ms: cached.cacheHit ? 0 : Date.now() - startedAt,
      },
      serverReceivedAt: tBackendReceivedAt,
      serverRespondedAt: Date.now(),
    };
  } catch (error) {
    error.timings = { t3_t4_total_ms: Date.now() - startedAt };
    throw error;
  }
}

function getLlmConfig() {
  return {
    hasGroqKey: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()),
    model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    maxTokens: effectiveTokenLimit(undefined, false),
    turboMaxTokens: TURBO_TOKEN_LIMIT,
    cacheTtlMs,
    cacheMaxEntries,
  };
}

module.exports = { solveMcq, getLlmConfig };
