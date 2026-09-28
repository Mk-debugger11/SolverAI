import { revalidateAssignmentContext } from './assignmentDetector.js';

// Uses the portal's visible controls. The page ledger prevents replay after a
// lost worker response; only a fresh, explicit result acknowledges submission.
export function submissionPageOperation(operation, payload) {
  const fail = (status, reason, extra = {}) => ({ success: false, status, reason, ...extra });
  if (location.hostname !== 'my.newtonschool.co' || location.href !== payload.url) {
    return fail('unknown', 'The assignment page changed during submission.');
  }
  const token = `${location.href}::${performance.timeOrigin}`;
  const key = '__solverAIPortalSubmissionsV1';
  const state = window[key] ||= { token, records: {} };
  if (state.token !== token) return fail('unknown', 'The submission document was replaced.');
  const visible = (node) => Boolean(node?.getClientRects().length);
  const text = (node) => (node?.innerText || node?.textContent || '').trim().replace(/\s+/g, ' ');
  const controls = (root, label) => Array.from(root.querySelectorAll('button, [role="button"]'))
    .filter((node) => visible(node) && label.test(text(node)));
  const enabled = (node) => !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const busy = (node) => !enabled(node) || node.getAttribute('aria-busy') === 'true' || /submitting|evaluating|processing/i.test(text(node));
  const sourceConflict = () => {
    if (payload.kind !== 'code' || !payload.sourceTargets) return false;
    const models = window.monaco?.editor?.getModels?.();
    return !models || payload.sourceTargets.some((expected) => {
      const model = models.find((item) => item.uri?.toString?.() === expected.targetId);
      return !model || model.isDisposed?.() || model.getValue() !== expected.source;
    });
  };
  const submitLabel = payload.kind === 'notebook' ? /^Submit Solution$/i : /^Submit(?: Code| Solution)?$/i;
  const dialogs = () => Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .modal.show')).filter(visible);
  const classify = (value) => {
    if (/^(?:accepted|all (?:test cases|tests) passed|(?:solution|submission) accepted)[.!]?$/i.test(value)) return 'accepted';
    if (/^(?:wrong answer|compilation error|runtime error|time limit exceeded|memory limit exceeded|(?:some |\d+ )?(?:test cases|tests) failed|(?:submission|solution) rejected)[.!]?$/i.test(value)) return 'rejected';
    if (/^(?:(?:solution |assignment )?submitted successfully|(?:submission|solution) (?:submitted|saved|received) successfully|submission successful)[.!]?$/i.test(value)) return 'submitted';
    return null;
  };
  const results = () => Array.from(document.querySelectorAll('[role="status"], [role="alert"], h1, h2, h3, h4, p, span, div'))
    .filter((node) => visible(node) && !node.querySelector('div, p, span, h1, h2, h3, h4') &&
      !node.closest('.monaco-editor, .problem-statement, .question-description, [data-testid="problem-statement"], .text-span-question-renderer'))
    .map((node) => ({ node, text: text(node), status: classify(text(node)) })).filter((item) => item.status);
  const button = controls(document, submitLabel).filter((node) => !node.closest('[role="dialog"], [aria-modal="true"]'));
  if (operation === 'inspect') return { success: true, available: button.length === 1 && enabled(button[0]),
    reason: button.length !== 1 ? 'A unique visible Submit control is required.' : undefined };
  let record = state.records[payload.submissionId];
  const publicRecord = () => ({ submissionId: record.id, documentToken: token, status: record.result.status,
    sourceHash: record.sourceHash, dispatched: record.dispatched, confirmed: record.confirmed });
  if (operation === 'start') {
    if (record) return { ...record.result, submission: publicRecord() };
    if (Object.values(state.records).some((entry) => ['submitting', 'unknown'].includes(entry.result.status))) {
      return fail('unknown', 'An earlier submission has no acknowledged outcome; it will not be repeated.');
    }
    if (dialogs().length) return fail('needs_attention', 'A visible portal dialog needs attention before submission.');
    if (button.length !== 1 || !enabled(button[0])) return fail('unsupported', 'A unique enabled Submit control was not found.');
    if (sourceConflict()) return fail('conflict', 'The coding source changed before submission.');
    const counts = (items) => items.reduce((map, item) => map.set(item.text, (map.get(item.text) || 0) + 1), new Map());
    const baseline = counts(results());
    record = { id: payload.submissionId, sourceHash: payload.sourceHash, baseline, disappeared: new Set(), button: button[0], sawBusy: false,
      dispatched: false, confirmed: false, result: fail('submitting', 'Waiting for the portal submission result.') };
    state.records[record.id] = record;
    record.read = () => {
      if (!['submitting', 'unknown'].includes(record.result.status)) return;
      const current = results();
      const currentCounts = counts(current);
      const replacements = controls(document, submitLabel).filter((node) => !node.closest('[role="dialog"], [aria-modal="true"]'));
      const activeButton = record.button?.isConnected === false ? (replacements.length === 1 ? replacements[0] : null) : record.button;
      if (activeButton) record.sawBusy ||= busy(activeButton);
      for (const [value, count] of baseline) {
        if ((currentCounts.get(value) || 0) < count) record.disappeared.add(value);
      }
      // React may replace a historical result with an identical node. Text
      // counts, rather than node identity, prevent that remount becoming an ack.
      const fresh = current.filter((item) => (currentCounts.get(item.text) || 0) > (baseline.get(item.text) || 0) ||
        record.sawBusy && record.disappeared.has(item.text));
      if (record.sawBusy && activeButton && busy(activeButton)) return;
      if (fresh.length) {
        const statuses = new Set(fresh.map((item) => item.status));
        if (statuses.has('accepted') && statuses.has('rejected')) {
          record.result = fail('unknown', 'Conflicting submission results appeared. Review the portal result.');
          return;
        }
        const outcome = fresh.find((item) => item.status === 'rejected') || fresh.find((item) => item.status === 'accepted') || fresh[0];
        const container = outcome.node.closest('[role="dialog"], [role="status"], [role="alert"]') || outcome.node.parentElement;
        record.result = { success: outcome.status !== 'rejected', status: outcome.status,
          accepted: outcome.status === 'accepted', reason: outcome.text,
          feedback: (text(container) || outcome.text).slice(0, 8000) };
        record.observer?.disconnect();
      }
    };
    record.observer = new MutationObserver((changes) => {
      for (const change of changes || []) {
        if (change.target === record.button && ['disabled', 'aria-disabled', 'aria-busy'].includes(change.attributeName) && change.oldValue !== null) record.sawBusy = true;
      }
      record.read();
    });
    record.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true,
      attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled'] });
    record.dispatched = true;
    try { button[0].click(); } catch (error) { record.result = fail('unknown', `Submit may have started: ${error.message}`); }
  } else if (operation !== 'poll') return fail('unsupported', 'Unknown submission operation.');
  if (!record || (payload.documentToken && payload.documentToken !== token)) return fail('unknown', 'The page has no retained record of this submission.');
  record.read();
  if (['submitting', 'unknown'].includes(record.result.status)) {
    const shown = dialogs();
    if (shown.length) {
      const dialog = shown[0];
      const message = text(dialog);
      const confirm = controls(dialog, /^(?:Submit(?: Solution| Code)?|Yes,? Submit|Confirm(?: Submission)?)$/i);
      if (shown.length === 1 && record.confirmed && record.confirmedDialog === dialog &&
          !/paste|clipboard|warning|violation|terms|agree/i.test(message)) {
        return { ...record.result, submission: publicRecord() };
      } else if (payload.allowConfirm && shown.length === 1 && !record.confirmed && /(?:are you sure|confirm|ready to submit)/i.test(message) &&
          /submit|submission/i.test(message) && !/paste|clipboard|warning|violation|terms|agree/i.test(message) &&
          confirm.length === 1 && enabled(confirm[0])) {
        record.confirmed = true;
        record.confirmedDialog = dialog;
        if (sourceConflict()) return fail('unknown', 'The coding source changed before submission confirmation.', { submission: publicRecord() });
        try { confirm[0].click(); } catch (error) { record.result = fail('unknown', `Confirmation may have started: ${error.message}`); }
        record.read();
      } else return fail('unknown', 'The portal displayed a dialog requiring attention. Submission will not be repeated.', { submission: publicRecord() });
    }
  }
  return { ...record.result, submission: publicRecord() };
}

async function invoke(context, operation, record, signal, beforeDispatch) {
  await revalidateAssignmentContext(context);
  if (beforeDispatch) await beforeDispatch();
  if (signal?.aborted) return { success: false, status: operation === 'start' ? 'stopped' : 'unknown',
    reason: operation === 'start' ? 'Stopped before submitting.' : 'Stopped waiting for submission; reconcile its outcome.', submission: record };
  const response = await chrome.scripting.executeScript({
    target: context.outerDocumentId ? { tabId: context.tabId, documentIds: [context.outerDocumentId] } : { tabId: context.tabId, frameIds: [0] },
    world: 'MAIN', func: submissionPageOperation,
    args: [operation, { ...record, url: context.url, kind: context.kind }],
  });
  return response[0]?.result || { success: false, status: 'unknown', reason: 'No submission acknowledgement was returned.' };
}

export const inspectSubmission = (context) => invoke(context, 'inspect', {});
export const pollAssignmentSubmission = (context, record) => invoke(context, 'poll', { ...record, allowConfirm: false });
export async function submitAssignment(context, snapshot, { submissionId, signal, onSubmission, beforeDispatch, timeoutMs = 120000 } = {}) {
  await revalidateAssignmentContext(context, { outerContextHash: snapshot.outerContextHash });
  const record = { submissionId, sourceHash: snapshot.contextHash, status: 'dispatching' };
  await onSubmission?.(record);
  if (signal?.aborted) return { success: false, status: 'stopped', reason: 'Stopped before submitting.' };
  const sourceTargets = snapshot.kind === 'code' ? snapshot.targets.map(({ targetId, source }) => ({ targetId, source })) : undefined;
  let result = await invoke(context, 'start', { ...record, sourceTargets, allowConfirm: true }, signal, beforeDispatch);
  let retained = result.submission || record;
  await onSubmission?.({ ...retained, status: result.status });
  const deadline = Date.now() + timeoutMs;
  while (result.status === 'submitting') {
    if (signal?.aborted || Date.now() >= deadline) return { success: false, status: 'unknown', submission: retained,
      reason: 'Submission was dispatched but its outcome is still unknown. Reconcile it before continuing.' };
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (signal?.aborted) return { success: false, status: 'unknown', submission: retained,
      reason: 'Stopped waiting. The dispatched submission must be reconciled.' };
    result = await invoke(context, 'poll', { ...retained, sourceTargets, allowConfirm: true }, signal, beforeDispatch);
    retained = result.submission || retained;
  }
  return { ...result, submission: retained };
}
export const portalSubmission = { inspect: inspectSubmission, submit: submitAssignment, poll: pollAssignmentSubmission };
