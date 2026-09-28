const API_BASE_URL = 'http://localhost:5001/api';

/** Validate a numeric answer without dropping zero or changing its precision text. */
export function normalizeNumericAnswer(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error('The solver must return a single numeric answer.');
  }
  const answer = String(value).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(answer) || !Number.isFinite(Number(answer))) {
    throw new Error('The solver must return a finite decimal or scientific number without units or explanation.');
  }
  return answer;
}

/**
 * Formats an MCQ or numerical question into a compact solver payload.
 * @param {Object} question - The question object with questionText and options array
 * @returns {{ q: string, o?: Object.<string, string>, answerType?: string }}
 */
export function formatLlmPayload(question) {
  if (!question) return { q: '', o: {} };
  if (question.imageExtractionError) throw new Error(question.imageExtractionError);
  const images = question.llmPayload?.images ?? question.images ?? [];
  if (!Array.isArray(images) || images.some((image) => typeof image !== 'string') || images.length > 3) {
    throw new Error('A question may contain at most three supported images. Its visual content cannot be discarded.');
  }
  const imagePayload = images.length ? { images: [...images] } : {};

  if ((question.answerType || question.llmPayload?.answerType) === 'numeric') {
    return {
      q: (question.llmPayload?.q || question.questionText || question.question || '').trim(),
      answerType: 'numeric',
      ...imagePayload,
    };
  }

  // Use pre-computed llmPayload if available
  if (question.llmPayload && question.llmPayload.q && question.llmPayload.o) {
    return { q: question.llmPayload.q, o: question.llmPayload.o, ...imagePayload };
  }

  const optionsMap = {};
  if (Array.isArray(question.options)) {
    question.options.forEach((opt, idx) => {
      const key = opt.optionLetter || String.fromCharCode(65 + idx);
      optionsMap[key] = (opt.text || opt.label || '').trim();
    });
  }

  return {
    q: (question.questionText || question.question || '').trim(),
    o: optionsMap,
    ...imagePayload,
  };
}

/**
 * Fetches the backend LLM configuration (hasKey, default model, maxTokens).
 */
export async function fetchLlmConfig() {
  try {
    const res = await fetch(`${API_BASE_URL}/solve/config`);
    if (res.ok) {
      return await res.json();
    }
  } catch {
    // Offline or server not reached
  }
  return null;
}

/**
 * Executes the solver endpoint and returns an MCQ key or numeric string with metadata.
 * @param {Object} payload - { q: string, o?: Object, answerType?: 'mcq' | 'numeric' }
 * @param {Object} [config]
 * @param {string} [config.apiKey]
 * @param {string} [config.model]
 * @param {boolean} [config.turbo=true]
 * @param {number} [config.maxTokens]
 * @returns {Promise<Object>} Solution result including answer, timings, and metadata
 */
export async function solveMcq(payload, config = {}) {
  const { apiKey, model, turbo = true, maxTokens } = config;
  const answerType = payload?.answerType || 'mcq';

  if (!payload?.q || !['mcq', 'numeric'].includes(answerType) ||
      (answerType === 'mcq' && (!payload.o || Object.keys(payload.o).length === 0))) {
    throw new Error('Invalid question payload provided for LLM solving.');
  }

  const tStart = performance.now();

  const res = await fetch(`${API_BASE_URL}/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: payload.q,
      o: answerType === 'mcq' ? payload.o : undefined,
      answerType,
      images: payload.images?.length ? payload.images : undefined,
      apiKey: apiKey ? apiKey.trim() : undefined,
      model: model ? model.trim() : undefined,
      turbo: Boolean(turbo),
      maxTokens: maxTokens ? parseInt(maxTokens, 10) : undefined,
    }),
  });

  const tEnd = performance.now();
  const roundtripMs = Math.round(tEnd - tStart);

  let data;
  try {
    data = await res.json();
  } catch {
    const error = new Error(`The solver returned an invalid response (HTTP ${res.status}).`);
    error.status = res.status;
    throw error;
  }
  if (!res.ok || !data?.success) {
    const error = new Error(data?.error || 'LLM pipeline returned an error.');
    error.status = res.status;
    throw error;
  }

  if (data.answerType && data.answerType !== answerType) {
    throw new Error('The solver returned an answer for a different question type.');
  }
  const answer = answerType === 'numeric'
    ? normalizeNumericAnswer(data.answer)
    : String(data.answer ?? '').toUpperCase().trim();
  if (answerType === 'mcq' && !Object.hasOwn(payload.o, answer)) {
    throw new Error('The solver returned an answer that does not match the available option keys.');
  }

  // The round trip includes backend pacing and retries. Do not invent an
  // inference/network split when the provider did not report one.
  const serverTimings = data.timings || {};
  const backendMs = serverTimings.t3_t4_total_ms;
  const networkMs = Number.isFinite(backendMs)
    ? Math.max(0, roundtripMs - backendMs)
    : null;

  return {
    answer,
    answerType,
    confidence: data.confidence ?? null,
    reason: data.reason || '',
    modelUsed: data.modelUsed,
    turbo: data.turbo,
    cacheHit: Boolean(data.cacheHit),
    deduplicated: Boolean(data.deduplicated),
    usage: data.usage ?? null,
    timings: {
      ...serverTimings,
      roundtripMs,
      t3_backend_to_llm_ms: serverTimings.t3_backend_to_llm_ms ?? null,
      t4_llm_inference_ms: serverTimings.t4_llm_inference_ms ?? null,
      t2_t5_network_ms: networkMs,
    },
  };
}
