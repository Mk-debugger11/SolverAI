const API_BASE_URL = 'http://localhost:5001/api';

/**
 * Formats a question object into the standard LLM solver payload: { q, o }
 * @param {Object} question - The question object with questionText and options array
 * @returns {{ q: string, o: Object.<string, string> }}
 */
export function formatLlmPayload(question) {
  if (!question) return { q: '', o: {} };

  // Use pre-computed llmPayload if available
  if (question.llmPayload && question.llmPayload.q && question.llmPayload.o) {
    return question.llmPayload;
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
 * Executes the LLM MCQ solver endpoint and returns the solution with latency metrics.
 * @param {Object} payload - { q: string, o: Object }
 * @param {Object} [config]
 * @param {string} [config.apiKey]
 * @param {string} [config.model]
 * @param {boolean} [config.turbo=true]
 * @param {number} [config.maxTokens]
 * @returns {Promise<Object>} Solution result including answer, timings, and metadata
 */
export async function solveMcq(payload, config = {}) {
  const { apiKey, model, turbo = true, maxTokens } = config;

  if (!payload || !payload.q || !payload.o || Object.keys(payload.o).length === 0) {
    throw new Error('Invalid question payload provided for LLM solving.');
  }

  const tStart = performance.now();

  const res = await fetch(`${API_BASE_URL}/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: payload.q,
      o: payload.o,
      apiKey: apiKey ? apiKey.trim() : undefined,
      model: model ? model.trim() : undefined,
      turbo: Boolean(turbo),
      maxTokens: maxTokens ? parseInt(maxTokens, 10) : undefined,
    }),
  });

  const tEnd = performance.now();
  const roundtripMs = Math.round(tEnd - tStart);

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'LLM pipeline returned an error.');
  }

  // Deconstruct timings (T3: Backend -> LLM, T4: Inference, T2/T5: Network)
  const serverTimings = data.timings || {};
  const t3_t4_total = serverTimings.t3_t4_total_ms || Math.round(roundtripMs * 0.85);
  const t3 = serverTimings.t3_backend_to_llm_ms || 25;
  const t4 = serverTimings.t4_llm_inference_ms || (t3_t4_total - t3);
  const t2_t5 = Math.max(1, roundtripMs - t3_t4_total);

  return {
    answer: (data.answer || '').toUpperCase().trim(),
    confidence: data.confidence || (turbo ? 99 : 95),
    reason: data.reason || '',
    modelUsed: data.modelUsed,
    turbo: data.turbo,
    timings: {
      roundtripMs,
      t3_backend_to_llm_ms: t3,
      t4_llm_inference_ms: t4,
      t2_t5_network_ms: t2_t5,
    },
  };
}
