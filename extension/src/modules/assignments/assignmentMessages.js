export const ASSIGNMENT_PROTOCOL_VERSION = 2;
const RELOAD = 'Reload DOM Fetcher in chrome://extensions, then close and reopen its popup or floating dashboard.';

function send(runtime, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The extension background did not respond in time.')), timeoutMs);
    Promise.resolve().then(() => runtime.sendMessage(message)).then(
      (response) => { clearTimeout(timer); resolve(response); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function getAssignmentWorkerState({ runtime = globalThis.chrome?.runtime, timeoutMs = 8000 } = {}) {
  if (!runtime?.sendMessage) throw new Error('Load the built extension in Chrome to use assignment actions.');
  let state;
  try { state = await send(runtime, { type: 'GET_ASSIGNMENT_STATE' }, timeoutMs); }
  catch (error) { throw new Error(`Cannot connect to the extension background: ${error.message || String(error)} ${RELOAD}`); }
  if (!state || state.protocolVersion !== ASSIGNMENT_PROTOCOL_VERSION) {
    throw new Error(`The extension popup and background worker are out of sync. ${RELOAD}`);
  }
  if (state.error) throw new Error(state.error);
  return state;
}

/** One command only. A missing reply never causes automatic replay of effects. */
export async function sendAssignmentCommand({ scope, action, payload, onState,
  runtime = globalThis.chrome?.runtime, timeoutMs = 8000 } = {}) {
  const state = await getAssignmentWorkerState({ runtime, timeoutMs });
  onState?.(state);
  const capability = scope === 'batch' ? 'assignmentBatchActions' : 'assignmentActions';
  if (!state.capabilities?.[capability]?.includes(action)) {
    throw new Error(`This background worker does not support assignment ${action}. ${RELOAD}`);
  }
  let response;
  let failure;
  try {
    response = await send(runtime, {
      type: scope === 'batch' ? 'ASSIGNMENT_BATCH_ACTION' : 'ASSIGNMENT_ACTION', action, payload,
    }, timeoutMs);
  } catch (error) { failure = error; }
  if (response?.success === false && response.error) throw new Error(response.error);
  if (response?.success === true && response.protocolVersion === ASSIGNMENT_PROTOCOL_VERSION) return response;

  // Read state after a lost response, but never retry Start, Run, or Submit.
  let current;
  try { current = await getAssignmentWorkerState({ runtime, timeoutMs }); onState?.(current); } catch { /* Preserve the action's uncertain outcome. */ }
  if (current?.busy) throw new Error('The action acknowledgement was lost, but assignment work is still running. Follow its progress or use Stop; do not start another batch.');
  const detail = failure?.message ? ` (${failure.message})` : '';
  throw new Error(`The background did not acknowledge this assignment action${detail}. It was not retried. Check the saved assignment state before trying again. ${RELOAD}`);
}
