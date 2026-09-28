import { finalizeSnapshot, hashSource, injectionTarget, revalidateAssignmentContext } from './assignmentDetector.js';

// This function is deliberately self-contained: Chrome serializes it into the
// selected notebook document, where classic Jupyter owns the cells and kernel.
export async function notebookPageOperation(operation, payload) {
  const fail = (status, reason, extra = {}) => ({ success: false, status, reason, changedTargetIds: [], ...extra });
  const notebook = window.Jupyter?.notebook;
  const documentToken = `${location.href}::${performance.timeOrigin}`;
  if (payload.documentToken && payload.documentToken !== documentToken) return fail('conflict', 'The notebook document changed. Inspect it again.');
  if (!notebook?.get_cells || !notebook.notebook_path) return fail('unsupported', 'A complete classic Jupyter notebook model is unavailable.');

  const stateKey = '__solverAIAssignmentNotebookV1';
  let state = window[stateKey];
  if (!state || state.documentToken !== documentToken) {
    state = { documentToken, kernelEpoch: 0, kernelStatus: null, executions: {}, saves: {}, lifecycleObserved: false };
    window[stateKey] = state;
    if (notebook.events?.on) {
      notebook.events.on('kernel_restarting.Kernel kernel_autorestarting.Kernel kernel_dead.Kernel kernel_created.Kernel', () => {
        state.kernelEpoch++;
        state.kernelStatus = 'unknown';
      });
      notebook.events.on('kernel_busy.Kernel', () => { state.kernelStatus = 'busy'; });
      notebook.events.on('kernel_idle.Kernel', () => { state.kernelStatus = 'idle'; });
      notebook.events.on('kernel_disconnected.Kernel', () => { state.kernelStatus = 'unknown'; });
      state.lifecycleObserved = true;
    }
  }
  // Classic Jupyter emits status events; it does not expose kernel.status.
  // On first inspection only, its visible indicator can establish initial state.
  const kernelStatus = () => {
    if (state.kernelStatus !== null) return state.kernelStatus;
    if (['idle', 'busy'].includes(notebook.kernel?.status)) return notebook.kernel.status;
    const indicator = document.querySelector('#kernel_indicator_icon');
    if (!indicator?.getClientRects().length) return 'unknown';
    const idle = indicator.classList.contains('kernel_idle_icon');
    const busy = indicator.classList.contains('kernel_busy_icon');
    return idle !== busy ? (idle ? 'idle' : 'busy') : 'unknown';
  };
  const text = (value) => Array.isArray(value) ? value.join('') : String(value ?? '');
  const warnings = () => Array.from(document.querySelectorAll('[role="dialog"], [role="alert"], [aria-modal="true"]'))
    .filter((element) => element.getClientRects().length).map((element) => element.innerText?.trim()).filter(Boolean);
  const kernelIdentity = () => ({ id: notebook.kernel?.id || '', name: notebook.kernel?.name || '',
    sessionId: notebook.session?.id || notebook.kernel?.session_id || '', epoch: state.kernelEpoch });
  const runtime = () => ({ language: notebook.metadata?.kernelspec?.language || notebook.metadata?.language_info?.name || '',
    label: notebook.metadata?.kernelspec?.display_name || notebook.kernel?.name || '',
    ...(notebook.metadata?.language_info?.version ? { version: notebook.metadata.language_info.version } : {}) });
  const protectedCell = (cell) => cell.cell_type !== 'code' || cell.metadata?.editable === false ||
    cell.metadata?.nbgrader?.grade === true || cell.metadata?.nbgrader?.locked === true || cell.is_editable?.() === false;
  const summarizeOutputs = (cell, budget = { remaining: 20000 }) => (cell.output_area?.outputs || []).slice(0, 100).map((output) => {
    const content = output.output_type === 'error' ? (output.traceback || []).join('\n') :
      text(output.text || output.data?.['text/plain']);
    const kept = content.slice(0, budget.remaining);
    budget.remaining -= kept.length;
    return { type: output.output_type || 'unknown', text: kept,
      truncated: content.length > kept.length || (cell.output_area?.outputs?.length || 0) > 100,
      ...(output.output_type === 'error' ? { name: text(output.ename).slice(0, 200), message: text(output.evalue).slice(0, 1000) } : {}) };
  });
  const cells = () => notebook.get_cells();
  const targets = () => {
    const budget = { remaining: 20000 };
    return cells().map((cell, index) => ({
    targetId: String(cell.cell_id || cell.id || cell.toJSON?.()?.id || `position:${index}`), index,
    cellType: cell.cell_type, source: cell.get_text(), metadata: JSON.parse(JSON.stringify(cell.metadata || {})),
    editable: !protectedCell(cell), executionCount: cell.input_prompt_number ?? null, outputs: summarizeOutputs(cell, budget),
    }));
  };
  const identity = () => ({ path: notebook.notebook_path, name: notebook.notebook_name || '', frameUrl: location.href });
  const inspect = () => {
    const values = targets();
    const reasons = [];
    const complete = values.length <= 500 && values.reduce((total, target) => total + target.source.length, 0) <= 1000000 &&
      new Set(values.map((target) => target.targetId)).size === values.length;
    const language = runtime();
    const alerts = warnings();
    if (!complete) reasons.push('The notebook exceeds snapshot limits or has duplicate cell identities; no context was silently dropped.');
    if (!language.language || !language.label) reasons.push('The kernel runtime is not explicitly identified.');
    if (!state.lifecycleObserved) reasons.push('Kernel lifecycle events are unavailable; execution cannot be tracked safely.');
    if (alerts.length) reasons.push('A visible notebook dialog or warning needs attention.');
    const canEdit = complete && !alerts.length && typeof notebook.set_dirty === 'function' &&
      cells().every((cell) => protectedCell(cell) || typeof cell.set_text === 'function');
    const canRun = complete && Boolean(language.language && language.label) && !alerts.length && state.lifecycleObserved && kernelStatus() !== 'unknown' && Boolean(notebook.kernel?.id) &&
      cells().filter((cell) => cell.cell_type === 'code').every((cell) => typeof cell.execute === 'function' && 'last_msg_id' in cell && 'input_prompt_number' in cell);
    if (!canEdit) reasons.push('Guarded cell setters and dirty-state tracking are required for editing.');
    if (!canRun) reasons.push('An identified kernel and attributable cell execution APIs are required for running.');
    if (kernelStatus() === 'unknown') reasons.push('The kernel idle or busy state has not been observed.');
    if (typeof notebook.save_notebook !== 'function') reasons.push('The notebook does not expose its native save control.');
    return { documentToken, frameUrl: location.href, notebookIdentity: identity(), kernelIdentity: kernelIdentity(),
      kernelStatus: kernelStatus(), runtime: language, complete,
      targets: values, cells: values.map(({ targetId, index, cellType }) => ({ targetId, index, cellType })),
      dirty: notebook.dirty === true, warnings: alerts, reasons,
      capabilities: { generate: complete && Boolean(language.language && language.label) && !alerts.length,
        apply: canEdit, restore: canEdit, run: canRun, save: complete && !alerts.length && typeof notebook.save_notebook === 'function' } };
  };
  const checkSnapshot = (expected, overrides = {}) => {
    if (!expected || JSON.stringify(identity()) !== JSON.stringify(expected.notebookIdentity) ||
        JSON.stringify(runtime()) !== JSON.stringify(expected.runtime) ||
        JSON.stringify(kernelIdentity()) !== JSON.stringify(expected.kernelIdentity)) return 'The notebook, runtime or kernel session changed.';
    const actual = targets();
    if (actual.length !== expected.targets.length) return 'The notebook cell count changed.';
    const stableMetadata = (metadata) => Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => !['execution', 'ExecuteTime'].includes(key)));
    for (let index = 0; index < actual.length; index++) {
      const current = actual[index];
      const original = expected.targets[index];
      if (current.targetId !== original.targetId || current.cellType !== original.cellType || current.editable !== original.editable ||
          JSON.stringify(stableMetadata(current.metadata)) !== JSON.stringify(stableMetadata(original.metadata)) ||
          current.source !== (Object.hasOwn(overrides, current.targetId) ? overrides[current.targetId] : original.source)) {
        return `Cell ${index + 1} or its dependency context changed.`;
      }
    }
    return null;
  };
  const publicExecution = (record) => ({ runId: record.runId, requestId: record.requestId, targetId: record.targetId,
    sourceHash: record.sourceHash, kernelIdentity: record.kernelIdentity, documentToken,
    outerContextHash: record.snapshot.outerContextHash, startedAt: record.startedAt, status: record.status });

  try {
    if (operation === 'read') return inspect();
    if (operation === 'apply' || operation === 'restore') {
      const snapshot = payload.snapshot;
      const edits = payload.edits;
      if (!inspect().capabilities.apply) return fail('unsupported', 'Notebook editing is unavailable or a warning needs attention.');
      if (!Array.isArray(edits) || !edits.length || new Set(edits.map((edit) => edit.targetId)).size !== edits.length) return fail('conflict', 'Edits must contain unique declared targets.');
      const expectedOverrides = operation === 'restore' ? Object.fromEntries(edits.map((edit) => [edit.targetId, edit.content])) : {};
      const conflict = checkSnapshot(snapshot, expectedOverrides);
      if (conflict) return fail('conflict', conflict);
      for (const edit of edits) {
        const target = snapshot.targets.find((candidate) => candidate.targetId === edit.targetId);
        if (!target?.editable || typeof edit.content !== 'string' || edit.baseSourceHash !== target.sourceHash || protectedCell(cells()[target.index])) {
          return fail('conflict', 'An edit targets an unknown, changed or protected cell.');
        }
      }
      const appliedEdits = [];
      try {
        for (const edit of edits) {
          const currentConflict = checkSnapshot(snapshot, expectedOverrides);
          if (currentConflict || warnings().length) throw new Error(currentConflict || 'A warning appeared during editing.');
          const target = snapshot.targets.find((candidate) => candidate.targetId === edit.targetId);
          const cell = cells()[target.index];
          const before = cell.get_text();
          const content = operation === 'restore' ? target.source : edit.content;
          try { cell.set_text(content); }
          finally {
            const actual = cell.get_text();
            if (actual !== before) {
              appliedEdits.push({ targetId: target.targetId, baseSourceHash: target.sourceHash, content: actual });
              expectedOverrides[target.targetId] = actual;
              notebook.set_dirty(true);
            }
          }
          if (cell.get_text() !== content) throw new Error(`Cell ${target.index + 1} did not retain the complete replacement.`);
        }
        const finalConflict = checkSnapshot(snapshot, expectedOverrides);
        if (finalConflict || warnings().length) throw new Error(finalConflict || 'A warning appeared after editing.');
        return { success: true, status: operation === 'restore' ? 'restored' : 'applied',
          changedTargetIds: appliedEdits.map((edit) => edit.targetId), appliedEdits };
      } catch (error) {
        return fail(appliedEdits.length ? 'partial' : 'conflict', error.message,
          { changedTargetIds: appliedEdits.map((edit) => edit.targetId), appliedEdits });
      }
    }
    if (operation === 'start') {
      const { snapshot, targetId, runId } = payload;
      if (!runId) return fail('conflict', 'An execution ID is required.');
      if (state.executions[runId]) {
        const previous = state.executions[runId];
        if (previous.targetId !== targetId || previous.snapshot.contextHash !== snapshot.contextHash) return fail('conflict', 'This execution ID belongs to a different target or source.');
        return { success: ['running', 'completed'].includes(previous.status), status: previous.status, execution: publicExecution(previous), deduplicated: true };
      }
      const conflict = checkSnapshot(snapshot);
      if (conflict) return fail('conflict', conflict);
      if (!inspect().capabilities.run) return fail('unsupported', 'This notebook cannot expose attributable cell executions.');
      if (kernelStatus() !== 'idle' || notebook.kernel.is_connected?.() === false) return fail('needs_attention', 'The kernel must be connected and idle before starting a tracked execution.');
      if (Object.values(state.executions).some((record) => ['running', 'unknown', 'dispatching'].includes(record.status) &&
          JSON.stringify(record.kernelIdentity) === JSON.stringify(kernelIdentity()))) return fail('unknown', 'A previous execution is unresolved; reconcile it before running again.');
      const oldRecords = Object.keys(state.executions);
      if (oldRecords.length >= 32) oldRecords.slice(0, 16).forEach((id) => { if (state.executions[id].status === 'completed') delete state.executions[id]; });
      const target = snapshot.targets.find((candidate) => candidate.targetId === targetId);
      if (!target || target.cellType !== 'code') return fail('conflict', 'Only a declared code cell can execute.');
      const cell = cells()[target.index];
      const record = { runId, targetId, sourceHash: target.sourceHash, snapshot, kernelIdentity: kernelIdentity(),
        previousRequestId: cell.last_msg_id, initialCount: cell.input_prompt_number, startedAt: Date.now(), status: 'dispatching' };
      state.executions[runId] = record;
      try { cell.execute(); }
      catch (error) { record.status = 'unknown'; return fail('unknown', `Execution may have started: ${error.message}`, { execution: publicExecution(record) }); }
      record.requestId = cell.last_msg_id;
      record.sawRunning = cell.input_prompt_number === '*' || cell.running === true;
      record.outputsCleared = !cell.output_area?.outputs?.length;
      record.status = record.requestId && record.requestId !== record.previousRequestId ? 'running' : 'unknown';
      return { success: record.status === 'running', status: record.status,
        reason: record.status === 'unknown' ? 'Execution started without a fresh request ID; do not replay it.' : undefined,
        execution: publicExecution(record) };
    }
    if (operation === 'poll') {
      const record = state.executions[payload.execution?.runId];
      if (!record || !record.requestId || record.requestId !== payload.execution.requestId) return fail('unknown', 'The recorded execution cannot be reconciled in this notebook document.');
      if (warnings().length) {
        record.status = 'unknown';
        return fail('unknown', 'A notebook warning appeared; execution requires attention.', { execution: publicExecution(record) });
      }
      const conflict = checkSnapshot(record.snapshot);
      const target = record.snapshot.targets.find((candidate) => candidate.targetId === record.targetId);
      const cell = cells()[target.index];
      if (conflict || cell.last_msg_id !== record.requestId) {
        record.status = 'unknown';
        return fail('unknown', conflict || 'Another execution replaced the tracked request.', { execution: publicExecution(record) });
      }
      record.sawRunning ||= cell.input_prompt_number === '*' || cell.running === true;
      record.outputsCleared ||= !cell.output_area?.outputs?.length;
      const freshCompletion = record.sawRunning && typeof cell.input_prompt_number === 'number' &&
        cell.input_prompt_number !== record.initialCount && kernelStatus() === 'idle' && cell.running !== true;
      if (!freshCompletion) return { success: false, status: 'running', execution: publicExecution(record) };
      if (!record.outputsCleared) {
        record.status = 'unknown';
        return fail('unknown', 'The old outputs were never observed clearing; fresh output cannot be established.', { execution: publicExecution(record) });
      }
      record.status = 'completed';
      const outputs = summarizeOutputs(cell);
      // Display output is bounded, but an error after many stream/display
      // records must still make execution fail.
      const errorOutputs = (cell.output_area?.outputs || []).filter((output) => output.output_type === 'error');
      const errors = summarizeOutputs({ output_area: { outputs: errorOutputs } });
      return { success: errors.length === 0, status: 'completed', outcome: errors.length ? 'runtime_error' : 'completed',
        checksPassed: null, outputs, errors, execution: publicExecution(record),
        reason: errors.length ? 'The cell completed with an error.' : 'The cell completed; assignment correctness and grading remain unverified.' };
    }
    if (operation === 'save') {
      const { snapshot, saveId, timeoutMs } = payload;
      const conflict = checkSnapshot(snapshot);
      if (conflict) return fail('conflict', conflict);
      if (kernelStatus() !== 'idle') return fail('needs_attention', 'Wait for the kernel to become idle before saving the verified result.');
      if (warnings().length || typeof notebook.save_notebook !== 'function') return fail('unsupported', 'A supported save operation is unavailable or a warning needs attention.');
      if (state.saves[saveId]) return { ...state.saves[saveId].result, outerContextHash: state.saves[saveId].outerContextHash };
      if (Object.values(state.saves).some((record) => record.result.status === 'unknown')) return fail('unknown', 'A previous save has an unknown outcome; reconcile it before saving again.');
      const record = { outerContextHash: snapshot.outerContextHash, result: fail('unknown', 'Notebook save is pending.', { saveId }) };
      state.saves[saveId] = record;
      let saving;
      try { saving = notebook.save_notebook(); }
      catch (error) { record.result = fail('unknown', `Save may have started: ${error.message}`, { saveId }); return record.result; }
      if (!saving || typeof saving.then !== 'function') return record.result = fail('unknown', 'The save control returned no acknowledgement promise.', { saveId });
      const acknowledged = Promise.resolve(saving).then(() => {
        const changed = checkSnapshot(snapshot);
        return record.result = !changed && notebook.dirty === false && !warnings().length
          ? { success: true, status: 'saved', saveId, saved: true }
          : fail('unknown', changed || 'The notebook has not confirmed a clean saved state.', { saveId });
      }, (error) => record.result = fail('failed', `Notebook save failed: ${error.message}`, { saveId }));
      let timer;
      const result = await Promise.race([acknowledged, new Promise((resolve) => { timer = setTimeout(() => resolve(record.result), timeoutMs); })]);
      clearTimeout(timer);
      return result;
    }
    if (operation === 'poll-save') {
      const record = state.saves[payload.saveId];
      return record ? { ...record.result, outerContextHash: record.outerContextHash } : fail('unknown', 'This document has no record of the save request.', { saveId: payload.saveId });
    }
    return fail('unsupported', 'Unknown notebook adapter operation.');
  } catch (error) {
    return fail('failed', `Could not inspect the notebook model: ${error.message}`);
  }
}

async function invoke(context, operation, payload = {}, signal) {
  const outerContextHash = payload.snapshot?.outerContextHash || payload.execution?.outerContextHash;
  const outer = await revalidateAssignmentContext(context, { outerContextHash });
  if (signal?.aborted) return { success: false, status: 'stopped', reason: 'Stopped before the next notebook operation.', changedTargetIds: [] };
  const results = await chrome.scripting.executeScript({ target: injectionTarget(context), world: 'MAIN',
    func: notebookPageOperation, args: [operation, { ...payload, documentToken: context.documentToken }] });
  const result = results[0]?.result || { success: false, status: 'unknown', reason: 'The notebook document returned no result.' };
  try { await revalidateAssignmentContext(context, { outerContextHash: outerContextHash || result.outerContextHash || await hashSource(JSON.stringify(outer)) }); }
  catch (error) { return { ...result, success: false, status: 'unknown', reason: error.message }; }
  return operation === 'read' ? { ...result, ...outer } : result;
}

async function readSnapshot(context) {
  const data = await invoke(context, 'read');
  if (!data.targets) throw new Error(data.reason || 'Notebook snapshot unavailable.');
  if (!data.statement?.trim()) {
    data.capabilities.generate = false;
    data.reasons.push('The assignment question pane could not be identified.');
  }
  return finalizeSnapshot(context, data);
}

async function applyEdits(context, snapshot, edits, { signal } = {}) { return invoke(context, 'apply', { snapshot, edits }, signal); }
async function restoreEdits(context, snapshot, edits, { signal } = {}) { return invoke(context, 'restore', { snapshot, edits }, signal); }
async function startExecution(context, snapshot, { targetId, runId, signal }) { return invoke(context, 'start', { snapshot, targetId, runId }, signal); }
async function pollExecution(context, execution) { return invoke(context, 'poll', { execution }); }

async function runChecks(context, snapshot, { targetIds, timeoutMs = 60000, signal, onExecution } = {}) {
  if (!Array.isArray(targetIds) || !targetIds.length || new Set(targetIds).size !== targetIds.length) {
    return { success: false, status: 'needs_attention', reason: 'Choose explicit dependency and check cells in execution order.' };
  }
  if (targetIds.some((targetId) => !snapshot.targets.some((target) => target.targetId === targetId && target.cellType === 'code'))) {
    return { success: false, status: 'needs_attention', reason: 'Every execution target must be a declared code cell.', results: [] };
  }
  const orderedIds = [...targetIds].sort((a, b) => snapshot.targets.find((target) => target.targetId === a).index - snapshot.targets.find((target) => target.targetId === b).index);
  const completed = [];
  const summarize = () => completed.map((result) => ({ targetId: result.execution.targetId,
    status: result.outcome === 'runtime_error' ? 'failed' : result.status,
    output: result.outputs.map((output) => output.text).join('\n'),
    error: result.errors.map((error) => error.message || error.text).join('\n') }));
  for (const targetId of orderedIds) {
    if (signal?.aborted) return { success: false, status: 'stopped', completed, results: summarize(), reason: 'Stopped before the next cell execution.' };
    const runId = crypto.randomUUID();
    await onExecution?.({ runId, targetId, status: 'dispatching', completed, results: summarize() });
    if (signal?.aborted) return { success: false, status: 'stopped', completed, results: summarize(), reason: 'Stopped before dispatch.' };
    const started = await startExecution(context, snapshot, { targetId, runId, signal });
    if (started.execution) await onExecution?.({ ...started.execution, completed, results: summarize() });
    if (!started.success) return { ...started, completed, results: summarize() };
    const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 3600000) : 60000);
    while (true) {
      if (signal?.aborted) return { success: false, status: 'unknown', completed, results: summarize(), execution: started.execution,
        reason: 'Stopped waiting. The kernel execution may still be active; reconcile it before another run.' };
      const result = await pollExecution(context, started.execution);
      if (result.status === 'completed') {
        completed.push(result);
        await onExecution?.({ ...result.execution, completed, results: summarize() });
        if (!result.success) return { ...result, status: 'failed', completed, results: summarize() };
        break;
      }
      if (result.status !== 'running') return { ...result, completed, results: summarize() };
      if (Date.now() >= deadline) return { success: false, status: 'unknown', completed, results: summarize(), execution: started.execution,
        reason: 'Execution wait timed out. Do not rerun until the current request is reconciled.' };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return { success: true, status: 'completed', completed, results: summarize(), checksPassed: null,
    reason: 'Selected cells completed without errors. Assignment correctness and portal acceptance are unverified.' };
}

async function save(context, snapshot, { timeoutMs = 15000, saveId, signal } = {}) {
  const saveFingerprint = JSON.stringify({ contextHash: snapshot.contextHash,
    execution: snapshot.targets.map(({ targetId, executionCount, outputs }) => ({ targetId, executionCount, outputs })) });
  return invoke(context, 'save', { snapshot, saveId: saveId || `save:${await hashSource(saveFingerprint)}`,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60000) : 15000 }, signal);
}

async function pollSave(context, saveId) { return invoke(context, 'poll-save', { saveId }); }

export const notebookAdapter = { readSnapshot, applyEdits, restoreEdits, startExecution, pollExecution, runChecks, save, pollSave };
