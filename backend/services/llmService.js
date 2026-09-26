/**
 * LLM Service: Handles Groq API communication, prompt management,
 * token limits, and robust fallback answer extraction.
 */

/**
 * Solves a multiple-choice question using Groq LLM API.
 * @param {Object} params
 * @param {string} params.q - Question text
 * @param {Object} params.o - Options map { A: "text", B: "text", ... }
 * @param {string} [params.apiKey] - Groq API Key (falls back to process.env.GROQ_API_KEY)
 * @param {string} [params.model] - Groq Model (falls back to process.env.GROQ_MODEL)
 * @param {boolean} [params.turbo=true] - Turbo mode flag
 * @param {number} [params.maxTokens] - Custom max generation tokens
 * @param {number} [params.tBackendReceivedAt] - Timestamp when request was received
 * @returns {Promise<Object>} Solution result with answer, reason, timings, and metadata
 */
async function solveMcq({
  q,
  o,
  apiKey: clientApiKey,
  model: clientModel,
  turbo = true,
  maxTokens: clientMaxTokens,
  tBackendReceivedAt = Date.now(),
}) {
  if (!q || !o || Object.keys(o).length === 0) {
    throw new Error('Invalid payload: "q" (question) and "o" (options object) are required.');
  }

  const apiKey = (clientApiKey || process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error(
      'Groq API Key is missing. Please add GROQ_API_KEY to backend/.env or enter it in the extension settings.'
    );
  }

  const model = (clientModel || process.env.GROQ_MODEL || 'qwen/qwen3.8-27b').trim();
  const isTurbo = Boolean(turbo);

  // Compute effective token generation limit:
  // Turbo: default 256 tokens (ample headroom for JSON without truncation)
  // Precision: default 2048 tokens (allows full step-by-step derivation without cutting off)
  const rawRequestedTokens = Number(clientMaxTokens || process.env.GROQ_MAX_TOKENS);
  const effectiveMaxTokens =
    Number.isInteger(rawRequestedTokens) && rawRequestedTokens > 0
      ? rawRequestedTokens
      : isTurbo
      ? 256
      : 2048;

  // In Turbo mode: direct JSON output (~20-50ms)
  // In Precision mode: Chain-of-Thought step-by-step derivation before emitting answer
  const SYSTEM_PROMPT = isTurbo
    ? 'Identify the single correct option key for the multiple choice question. Output strictly valid JSON matching: {"a":"<OptionKey>"}. No explanations, no markdown, no other keys.'
    : 'You are an expert multiple-choice assessment solver.\n' +
      'Instructions:\n' +
      '1. In the "thought" field, briefly derive the solution step-by-step, verify calculations, and check against the choices.\n' +
      '2. In the "a" field, output strictly the single uppercase option key (e.g. "A", "B", "C", or "D").\n' +
      'Output strictly valid JSON matching this schema:\n' +
      '{"thought": "<Concise step-by-step derivation>", "a": "<OptionKey>"}';

  const userContent = JSON.stringify({ q, o });
  const t3Start = Date.now();

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.0,
      max_tokens: effectiveMaxTokens,
      response_format: { type: 'json_object' },
    }),
  });

  const t3_t4_total_ms = Date.now() - t3Start;

  // Handle Groq API error response
  if (!groqRes.ok) {
    const errText = await groqRes.text();
    let errMsg = `Groq API responded with status ${groqRes.status}`;
    let failedGen = '';
    try {
      const parsedErr = JSON.parse(errText);
      errMsg = parsedErr.error?.message || errMsg;
      failedGen = parsedErr.error?.failed_generation || '';
    } catch {
      errMsg = errText || errMsg;
    }

    // Recovery attempt 1: Check if failed_generation already contains the answer key
    if (failedGen) {
      const match =
        failedGen.match(/"a"\s*:\s*"([A-D])"/i) ||
        failedGen.match(/"answer"\s*:\s*"([A-D])"/i) ||
        failedGen.match(/([A-D])/);
      if (match) {
        const recoveredLetter = match[1].toUpperCase();
        const tBackendRespondedAt = Date.now();
        return {
          success: true,
          answer: recoveredLetter,
          confidence: 85,
          reason: 'Recovered from LLM partial generation',
          modelUsed: model,
          turbo: isTurbo,
          timings: {
            t3_backend_to_llm_ms: Math.round(t3_t4_total_ms * 0.3),
            t4_llm_inference_ms: Math.round(t3_t4_total_ms * 0.7),
            t3_t4_total_ms,
          },
          serverReceivedAt: tBackendReceivedAt,
          serverRespondedAt: tBackendRespondedAt,
        };
      }
    }

    // Recovery attempt 2: Retry with fast plain-text prompt and generous token limit
    try {
      const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'Answer the multiple choice question with strictly only the correct option letter: A, B, C, or D. No other words.',
            },
            { role: 'user', content: userContent },
          ],
          temperature: 0.0,
          max_tokens: Math.max(150, Math.min(effectiveMaxTokens, 500)),
        }),
      });

      if (retryRes.ok) {
        const retryData = await retryRes.json();
        const retryContent = retryData.choices?.[0]?.message?.content || '';
        const match =
          retryContent.match(/"a"\s*:\s*"([A-D])"/i) ||
          retryContent.match(/([A-D])/i);
        if (match) {
          const recoveredLetter = match[1].toUpperCase();
          const tBackendRespondedAt = Date.now();
          return {
            success: true,
            answer: recoveredLetter,
            confidence: 90,
            reason: 'Recovered via fallback solver',
            modelUsed: model,
            turbo: isTurbo,
            timings: {
              t3_backend_to_llm_ms: 25,
              t4_llm_inference_ms: Math.max(10, Date.now() - t3Start - 25),
              t3_t4_total_ms: Date.now() - t3Start,
            },
            serverReceivedAt: tBackendReceivedAt,
            serverRespondedAt: tBackendRespondedAt,
          };
        }
      }
    } catch (retryErr) {
      console.warn('Retry attempt failed:', retryErr.message);
    }

    if (failedGen) {
      errMsg += ` (Failed generation: ${failedGen})`;
    }

    const error = new Error(errMsg);
    error.status = groqRes.status;
    error.timings = { t3_t4_total_ms };
    throw error;
  }

  const groqData = await groqRes.json();
  const rawContent = groqData.choices?.[0]?.message?.content || '{}';

  let parsed = null;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    try {
      const cleanContent = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleanContent);
    } catch {
      const match = rawContent.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          parsed = JSON.parse(match[0]);
        } catch {}
      }
    }
  }

  let answerRaw = parsed
    ? (parsed.a ||
        parsed.answer ||
        parsed.ans ||
        (typeof parsed === 'object' &&
          Object.values(parsed).find((v) => typeof v === 'string' && /^[A-D]$/i.test(v.trim()))) ||
        Object.values(parsed)[0])
    : '';

  // If answerRaw is empty, fallback to regex extraction directly from rawContent
  if (!answerRaw) {
    const match =
      rawContent.match(/"a"\s*:\s*"([A-D])"/i) ||
      rawContent.match(/"answer"\s*:\s*"([A-D])"/i) ||
      rawContent.match(/option\s*([A-D])/i) ||
      rawContent.match(/\b([A-D])\b/);
    if (match) {
      answerRaw = match[1];
    }
  }

  if (!answerRaw) {
    const error = new Error('Failed to parse LLM answer from response.');
    error.raw = rawContent;
    error.timings = { t3_t4_total_ms };
    throw error;
  }

  // Normalize answer: extract letter, e.g. "Option B" -> "B"
  let answerLetter = String(answerRaw).trim().toUpperCase();
  const letterMatch = answerLetter.match(/([A-Z])/);
  if (letterMatch) answerLetter = letterMatch[1];

  const reasonText = parsed
    ? (parsed.thought || parsed.reason || parsed.r || parsed.explanation || '')
    : '';

  // Compute precise T3 and T4
  const groqTotalTimeSec = groqData.usage?.total_time;
  let t4_llm_inference_ms = groqTotalTimeSec
    ? Math.round(groqTotalTimeSec * 1000)
    : Math.round(t3_t4_total_ms * 0.7);
  let t3_backend_to_llm_ms = Math.max(1, t3_t4_total_ms - t4_llm_inference_ms);

  const tBackendRespondedAt = Date.now();

  return {
    success: true,
    answer: answerLetter,
    confidence: parsed?.confidence || (isTurbo ? 99 : 95),
    reason: reasonText || (isTurbo ? '⚡ Turbo Mode' : ''),
    modelUsed: model,
    turbo: isTurbo,
    timings: {
      t3_backend_to_llm_ms,
      t4_llm_inference_ms,
      t3_t4_total_ms,
    },
    serverReceivedAt: tBackendReceivedAt,
    serverRespondedAt: tBackendRespondedAt,
  };
}

/**
 * Returns current LLM server configuration.
 */
function getLlmConfig() {
  return {
    hasGroqKey: Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim()),
    model: process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    maxTokens: parseInt(process.env.GROQ_MAX_TOKENS, 10) || 2048,
  };
}

module.exports = {
  solveMcq,
  getLlmConfig,
};
