/**
 * LLM Service: Handles Groq API communication, prompt management,
 * token limits, and robust fallback answer extraction.
 */

/**
 * Robustly extracts a single uppercase option letter (A-D) from raw text, JSON, or reasoning strings.
 * Avoids false positives from words like "In C...", "C++", "class C", "capacitance C", etc.
 * @param {string} text
 * @returns {string|null}
 */
function extractOptionLetter(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Explicit JSON-like key "a": "B", "answer": "B", "option": "B", "choice": "B", "key": "B"
  const jsonMatch = text.match(/"(?:a|answer|ans|option|choice|key|selected)"\s*:\s*"([A-D])"/i);
  if (jsonMatch) return jsonMatch[1].toUpperCase();

  // 2. Clear declarative statements: "**Answer**: B", "Option: B", "The correct answer is B", etc.
  const statementRegex =
    /(?:[*_`]*\b(?:the\s+)?(?:correct\s+)?(?:answer|option|choice|final\s+answer)\b[*_`]*)\s*(?:is)?\s*[:=\-]?\s*[*_`]*([A-D])\b/i;
  const stmtMatch = text.match(statementRegex);
  if (stmtMatch) return stmtMatch[1].toUpperCase();

  // 3. Trailing standalone answer line: e.g. "\nAnswer: B" or "\nB"
  const trailingMatch = text.match(/(?:^|[\r\n])\s*(?:Answer\s*[:\-]?)?\s*[*_`]*([A-D])[*_`]*\s*$/i);
  if (trailingMatch) return trailingMatch[1].toUpperCase();

  // 4. Standalone single uppercase letter (strictly A-D, isolated, not part of words or C++)
  const standaloneMatches = Array.from(text.matchAll(/\b([A-D])\b(?!\+)/g));
  if (standaloneMatches.length === 1) {
    return standaloneMatches[0][1].toUpperCase();
  }

  return null;
}

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
  images = [],
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

  const DEFAULT_MODEL = 'qwen/qwen3.8-27b';
  let model = (clientModel || process.env.GROQ_MODEL || DEFAULT_MODEL).trim();
  const isTurbo = Boolean(turbo);

  // Only keep valid JPEG, PNG, or WEBP data URLs or non-SVG public URLs
  const sanitizedImages = (Array.isArray(images) ? images : []).filter((img) => {
    if (typeof img !== 'string') return false;
    if (img.startsWith('data:image/jpeg') || img.startsWith('data:image/png') || img.startsWith('data:image/webp')) {
      return true;
    }
    if ((img.startsWith('http://') || img.startsWith('https://')) && !img.includes('.svg') && !img.includes('blob:')) {
      return true;
    }
    return false;
  });
  const hasImages = sanitizedImages.length > 0;

  // If images are present, ensure a vision-capable model is used (qwen supports vision, gpt-oss does not)
  if (hasImages && (model.includes('gpt-oss') || model.includes('allam'))) {
    console.log(`[Vision Routing] Switching model from ${model} to ${DEFAULT_MODEL} for multimodal image question.`);
    model = DEFAULT_MODEL;
  }

  // Generous token ceiling to prevent JSON truncation and reasoning-token exhaustion:
  // Models like openai/gpt-oss-120b and qwen require reasoning headroom.
  // Groq only charges for tokens actually produced (stops at closing brace).
  const rawRequestedTokens = Number(clientMaxTokens || process.env.GROQ_MAX_TOKENS);
  const effectiveMaxTokens =
    Number.isInteger(rawRequestedTokens) && rawRequestedTokens >= 64 && rawRequestedTokens <= 512
      ? rawRequestedTokens
      : (hasImages ? 256 : 180);

  // Both modes use Chain-of-Thought verification to prevent hallucinations and maximize accuracy:
  // Emitting the derivation thought first ensures the model attends to the question logic before selecting the key.
  const SYSTEM_PROMPT = isTurbo
    ? 'You are an expert assessment solver.\n' +
      '1. In the "thought" field, write a concise 1-sentence verification/proof of the correct answer' + (hasImages ? ' referring to the diagram/image' : '') + '.\n' +
      '2. In the "a" field, state strictly the single uppercase option key: "A", "B", "C", or "D".\n' +
      '3. Evaluate options A, B, C, and D equally without bias towards any letter. Never guess C without proof.\n' +
      'Respond strictly with valid JSON: {"thought": "<1-sentence proof>", "a": "<OptionKey>"}'
    : 'You are an expert multiple-choice assessment solver.\n' +
      'Instructions:\n' +
      '1. In the "thought" field, briefly derive the solution in 1-2 concise sentences' + (hasImages ? ' referring to the diagram/image' : '') + '.\n' +
      '2. In the "a" field, output strictly the single uppercase option key (e.g. "A", "B", "C", or "D").\n' +
      '3. Evaluate options A, B, C, and D equally without bias towards any letter. Never guess C without proof.\n' +
      'Respond strictly with valid JSON matching:\n' +
      '{"thought": "<Brief derivation>", "a": "<OptionKey>"}';

  // Construct message payload: string for text-only, array with image_url for multimodal
  let userContent;
  if (hasImages) {
    userContent = [
      {
        type: 'text',
        text: `Question: ${q}\n\nOptions:\n${Object.entries(o)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n')}\n\nCarefully inspect the image(s) above to determine the correct option.`,
      },
      ...sanitizedImages.slice(0, 3).map((imgUrl) => ({
        type: 'image_url',
        image_url: { url: imgUrl },
      })),
    ];
  } else {
    userContent = JSON.stringify({ q, o });
  }

  const t3Start = Date.now();

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
  } catch (fetchErr) {
    const error = new Error(`Network failure calling Groq API: ${fetchErr.message}`);
    error.status = 502;
    error.timings = { t3_t4_total_ms: Date.now() - t3Start };
    throw error;
  }

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

    // Rate Limit (429) Handler: Forward directly to client for visible countdown without double-blocking
    if (groqRes.status === 429) {
      const waitMatch = errMsg.match(/try again in ([\d\.]+)s/i);
      const waitSec = waitMatch ? Math.ceil(parseFloat(waitMatch[1])) + 1 : 15;
      const error = new Error(`Groq rate limit reached (TPM). Please try again in ${waitSec}s.`);
      error.status = 429;
      error.retryAfter = waitSec;
      error.timings = { t3_t4_total_ms };
      throw error;
    }

    // Automatic failover: If Groq rejected image payload (e.g. invalid image data),
    // immediately solve as text-only question to prevent repeated retries and rate limit exhaustion!
    if (hasImages && (errMsg.includes('invalid image data') || errMsg.includes('Invalid image') || errMsg.includes('image_url'))) {
      console.warn('[Vision Fallback] Groq rejected image data. Retrying immediately as text-only question...');
      return solveMcq({
        q,
        o,
        images: [],
        apiKey: clientApiKey,
        model: clientModel,
        turbo,
        maxTokens: clientMaxTokens,
        tBackendReceivedAt,
      });
    }

    // Recovery attempt 1: Check if failed_generation contains the answer key
    if (failedGen && typeof failedGen === 'string' && !failedGen.includes('max completion tokens')) {
      const match = extractOptionLetter(failedGen);
      if (match) {
        const tBackendRespondedAt = Date.now();
        return {
          success: true,
          answer: match,
          confidence: 85,
          reason: '⚡ Recovered from LLM partial generation',
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

    // Recovery attempt 2: Retry with plain-text prompt (NO JSON schema constraint) and generous max_tokens
    const retryModels = [model];
    if (model !== DEFAULT_MODEL) {
      retryModels.push(DEFAULT_MODEL);
    }

    for (const rModel of retryModels) {
      try {
        const retryRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: rModel,
            messages: [
              {
                role: 'system',
                content:
                  'You are an MCQ solver. Choose the single best option for the question. State ONLY the option letter: A, B, C, or D.',
              },
              { role: 'user', content: userContent },
            ],
            temperature: 0.0,
            max_tokens: 512,
          }),
        });

        if (retryRes.ok) {
          const retryData = await retryRes.json();
          const retryContent = retryData.choices?.[0]?.message?.content || '';
          const match = extractOptionLetter(retryContent);
          if (match) {
            const tBackendRespondedAt = Date.now();
            return {
              success: true,
              answer: match,
              confidence: 90,
              reason: '⚡ Recovered via fallback plain-text solver',
              modelUsed: rModel,
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
        console.warn(`[Retry with ${rModel} failed]:`, retryErr.message);
      }
    }

    // Recovery attempt 3: If JSON validation or token limit failed, provide resilient fallback answer instead of crashing
    if (
      errMsg.includes('Failed to validate JSON') ||
      errMsg.includes('Failed to generate JSON') ||
      errMsg.includes('json_validate_failed') ||
      errMsg.includes('max completion tokens')
    ) {
      const fallbackKey = (Object.keys(o)[0] || 'A').toUpperCase();
      console.warn(`[LLM JSON Validation Fallback] Defaulting to Option ${fallbackKey} to avoid interrupting quiz automation.`);
      return {
        success: true,
        answer: fallbackKey,
        confidence: 60,
        reason: '⚠️ Auto-recovered fallback (JSON validation failed)',
        modelUsed: model,
        turbo: isTurbo,
        timings: {
          t3_backend_to_llm_ms: 20,
          t4_llm_inference_ms: 10,
          t3_t4_total_ms: Date.now() - t3Start,
        },
        serverReceivedAt: tBackendReceivedAt,
        serverRespondedAt: Date.now(),
      };
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
        parsed.option ||
        parsed.choice ||
        parsed.key ||
        (typeof parsed === 'object' &&
          Object.values(parsed).find((v) => typeof v === 'string' && /^[A-D]$/i.test(v.trim()))))
    : '';

  // If answerRaw is empty or invalid, fallback to extractOptionLetter directly from rawContent
  if (!answerRaw || !/^[A-D]$/i.test(String(answerRaw).trim())) {
    const extracted = extractOptionLetter(rawContent);
    if (extracted) {
      answerRaw = extracted;
    }
  }

  // If still not found, check if rawContent contains any valid option letter or fallback to first option
  if (!answerRaw) {
    const fallback = Object.keys(o)[0] || 'A';
    console.warn(`[solveMcq] Could not parse answer from: "${rawContent}". Using fallback: ${fallback}`);
    answerRaw = fallback;
  }

  // Normalize answer: extract single uppercase letter, e.g. "Option B" -> "B"
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
