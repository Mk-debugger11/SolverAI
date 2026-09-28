# Quiz solver: numerical answers, API limits and local testing

The solver extracts editable MCQ and numerical questions, sends compact JSON to the local backend, validates the answer type, then selects an option or fills the answer field.

## Numerical questions

Newton's numerical questions can use `input[type="text"][data-puzzle-answer]` with the placeholder "Enter your answer here". Extraction associates that field with its question heading and preserves the order of mixed MCQ/numerical questions.

- Click Inspect DOM to see the Numerical badge and answer field in a question card.
- Click Solve on that card to generate and fill its numerical answer. Or enter your own number and click Fill answer, which uses no AI request.
- Integers, zero, signed decimals and scientific notation are supported. Units, prose, expressions, fractions and nonfinite values are rejected. Use a decimal value for a fractional answer.
- Values such as `6.0` remain strings so formatting is preserved. Numeric cache entries are separate from MCQ entries.
- The filler dispatches native input/change events and checks the field after rendering. It stops if the question/field changed or a manual edit happened during the AI wait. A retained field value verifies the local input, not the server's saved answer.
- On paginated quizzes, the existing automatic runner handles mixed question types and advances normally.
- On revision pages that show several questions together without Next/Submit, use Inspect DOM and the individual cards. Fill and Solve fill the numerical field; use the portal's Check Answer control yourself to check it. The full automatic runner stops before a request or write on this layout.

Live reference: the CPU Registers Preview revision quiz has a numerical first question and three MCQs. Its numerical input and question layout were inspected through DevTools; answers were left untouched during that inspection.

## Saving requests and tokens

- Requests for the same model share a backend queue. Starts are spaced at least 2100 ms apart by default, below a 30 requests/minute allowance.
- A 429 response respects `Retry-After`, including fractional seconds and HTTP dates. If the header is missing, the client uses the provider's wait message or exponential backoff. There are at most three retries; waits longer than 30 seconds surface the error and preserve the cooldown.
- The JSON fallback is reserved for JSON-generation errors. Authentication and rate-limit errors do not trigger another prompt.
- Upstream calls have a 30-second timeout so a stalled call cannot block the model queue indefinitely. Unknown-outcome network errors are not automatically retried.
- Successful answers are cached in backend memory for 15 minutes, with a maximum of 200 entries. Identical simultaneous requests share one provider call. Failures are not cached.
- Cache keys include the credential hash, model, answer type, exact question, option mapping, mode and effective token budget. Reordered or changed options cannot reuse a mismatched answer. Restarting the backend clears the cache.
- Turbo requests ask for an option key or numeric string in JSON and cap completion tokens at 512. For `qwen/qwen3.8-27b`, Turbo also uses `reasoning_effort: "none"` to disable thinking, following [Groq's model documentation](https://console.groq.com/docs/model/qwen/qwen3.8-27b). Detailed mode requests a brief explanation and caps completion tokens at 2048. Turn Turbo off for questions that benefit from more reasoning. These are output ceilings, not measured token savings or accuracy guarantees.
- Only valid option keys or finite numeric values can be applied. If the page changes while waiting, the runner stops before applying an answer. Stopping a run prevents further selection after the pending request returns.
- Batch runs stop on exhausted rate limits or authentication errors, leaving the current quiz open. Single and batch runs cannot overlap.
- Automated extraction omits full HTML serialization and decorative style inspection. Inspect DOM still captures HTML for manual review.

Pacing covers this backend process. Groq's organization-wide usage, token limits and daily quotas can still cause 429 responses. The popup shows cache hits and reported token usage instead of promising a fixed latency.

## Configuration

These optional values in `backend/.env` already have safe defaults:

```env
GROQ_MIN_REQUEST_INTERVAL_MS=2100
GROQ_CACHE_TTL_MS=900000
GROQ_CACHE_MAX_ENTRIES=200
```

Keep `PORT=5001`; the extension connects to that address. Configure `GROQ_API_KEY` in the backend or extension settings. Extension model/key settings override backend defaults. MongoDB is optional for solving and required for saved captures/history.

## Verify and reload

From the repository root:

```bash
npm test --prefix backend
npm test --prefix extension
npm run build:extension
```

Tests mock the provider and Chrome APIs. They do not send questions to Groq or change portal answers.

Restart `npm run dev:server` if needed, then click Reload on DOM Fetcher (MERN) at `chrome://extensions`. Load `extension/dist` if this is the first installation.

Use Inspect DOM to confirm the extracted question/options. On a practice question, Solve Current selects its result automatically. Repeating an identical request during the cache lifetime should show Cached and make no new provider call. Changing options, model or mode should create a new request. Keep Turbo on for compact output.
