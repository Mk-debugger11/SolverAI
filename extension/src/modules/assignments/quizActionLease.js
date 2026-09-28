// A popup may close while waiting for the API. Expiring leases avoid a stuck
// worker lock; revalidation immediately before writing prevents late responses
// from overlapping a newer assignment job.
export async function acquireQuizActionLease() {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Open the installed Chrome extension to edit the portal.');
  const response = await chrome.runtime.sendMessage({ type: 'ACQUIRE_POPUP_QUIZ_ACTION' });
  if (!response?.success) throw new Error(response?.error || 'Another action is still active.');
  return {
    async check() {
      const current = await chrome.runtime.sendMessage({ type: 'CHECK_POPUP_QUIZ_ACTION', token: response.token });
      if (!current?.success) throw new Error('This action expired while waiting. Start it again before editing the page.');
    },
    async release() {
      try { await chrome.runtime.sendMessage({ type: 'RELEASE_POPUP_QUIZ_ACTION', token: response.token }); } catch {}
    },
  };
}
