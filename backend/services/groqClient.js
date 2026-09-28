const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function checkAborted(signal) {
  if (signal?.aborted) throw signal.reason || new Error('Request cancelled');
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  checkAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function parseRetryAfter(value, now) {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

async function retryDelayMs(response, now, attempt) {
  const headerDelay = parseRetryAfter(response.headers.get('retry-after'), now);
  if (headerDelay !== null) return headerDelay;

  // Some provider errors include a wait in the message but omit Retry-After.
  const data = await response.clone().json().catch(() => null);
  const duration = data?.error?.message?.match(
    /try again in ((?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)\s*)+)/i
  )?.[1];
  if (duration) {
    const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    return Array.from(duration.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/gi))
      .reduce((total, [, amount, unit]) => total + Number(amount) * units[unit.toLowerCase()], 0);
  }
  return 2000 * 2 ** attempt;
}

function createGroqClient({
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = 2100,
  maxRetries = 3,
  maxRetryDelayMs = 30000,
  requestTimeoutMs = 30000,
  timeoutSignal = (ms) => AbortSignal.timeout(ms),
} = {}) {
  const interval = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 2100;
  const retryLimit = Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 10 ? maxRetries : 3;
  const maxWait = Number.isFinite(maxRetryDelayMs) && maxRetryDelayMs > 0 ? maxRetryDelayMs : 30000;
  const timeout = Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 30000;
  const queues = new Map();

  return function requestGroq(apiKey, payload, { signal, beforeAttempt } = {}) {
    // Share pacing across primary, fallback and concurrent calls for each model.
    // Pacing is shared across credentials because quotas can be organization-wide.
    if (!queues.has(payload.model)) {
      queues.set(payload.model, { tail: Promise.resolve(), nextAllowedAt: 0, lastRateLimit: null });
    }
    const state = queues.get(payload.model);
    const request = state.tail.then(async () => {
      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        checkAborted(signal);
        let waitMs = state.nextAllowedAt - now();
        if (state.lastRateLimit && waitMs > maxWait) {
          return state.lastRateLimit.clone();
        }
        while (waitMs > 0) {
          await withAbort(sleep(waitMs), signal);
          waitMs = state.nextAllowedAt - now();
        }

        checkAborted(signal);
        // The caller can enforce a job-wide budget at actual dispatch, including 429 retries.
        if (beforeAttempt) beforeAttempt({ attempt });
        checkAborted(signal);
        state.nextAllowedAt = now() + interval;
        const timerSignal = timeoutSignal(timeout);
        const controller = signal ? new AbortController() : null;
        const cleanup = () => {
          signal?.removeEventListener('abort', abort);
          timerSignal.removeEventListener('abort', abort);
        };
        const abort = () => {
          controller.abort(signal.aborted ? signal.reason : timerSignal.reason);
          cleanup();
        };
        if (controller) {
          signal.addEventListener('abort', abort, { once: true });
          timerSignal.addEventListener('abort', abort, { once: true });
          if (signal.aborted || timerSignal.aborted) abort();
        }
        let response;
        try {
          response = await fetchImpl(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(payload),
            signal: controller?.signal || timerSignal,
          });
        } catch (error) {
          if (controller) cleanup();
          throw error;
        }
        // Keep cancellation/deadline connected while the caller consumes the body.
        // Abort (including the deadline) removes these listeners within the timeout.
        checkAborted(signal);
        if (response.status !== 429) {
          state.lastRateLimit = null;
          return response;
        }

        const delay = await retryDelayMs(response, now(), attempt);
        // A small buffer avoids retrying just before the provider's window resets.
        state.nextAllowedAt = Math.max(state.nextAllowedAt, now() + delay + 250);
        state.lastRateLimit = response.clone();
        if (attempt === retryLimit || state.nextAllowedAt - now() > maxWait) return response;
      }
    });
    // A failed request must not stop later queued requests from running.
    state.tail = request.then(() => undefined, () => undefined);
    // A cancelled queued caller returns promptly; its queue slot later exits without dispatch.
    return withAbort(request, signal);
  };
}

const requestGroq = createGroqClient({
  minIntervalMs: Number(process.env.GROQ_MIN_REQUEST_INTERVAL_MS || 2100),
});

module.exports = { createGroqClient, requestGroq };
