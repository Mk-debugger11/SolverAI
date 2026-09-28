import { finalizeSnapshot, injectionTarget, revalidateAssignmentContext } from './assignmentDetector.js';

// Runs in the main world through public Monaco APIs and visible portal controls.
export async function codePageOperation(operation, payload = {}) {
  const fail = (status, reason, extra = {}) => ({ success: false, status, reason, changedTargetIds: [], ...extra });
  const token = `${location.href}::${performance.timeOrigin}`;
  if (payload.documentToken && payload.documentToken !== token) return fail('conflict', 'The coding document changed. Inspect it again.');
  const visible = (element) => Boolean(element?.getClientRects?.().length);
  const label = (element) => (element?.getAttribute?.('aria-label') || element?.innerText || element?.textContent || '').trim();
  const resultNotice = /^(?:run successful|execution completed|compilation successful|all test.?cases? passed|tests passed|accepted|wrong answer|runtime error|compilation error|time limit exceeded|memory limit exceeded)[.!]?$/i;
  const alerts = () => Array.from(document.querySelectorAll('[role="dialog"], [role="alert"], [aria-modal="true"]'))
    .filter(visible).filter((element) => element.getAttribute?.('role') !== 'alert' || !resultNotice.test(label(element)))
    .map(label).filter(Boolean);
  const api = window.monaco?.editor;
  const models = () => (api?.getModels?.() || []).filter((model) => !model.isDisposed?.());
  const role = (text) => {
    const value = String(text || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (/^(source|source editor|code source|solution|solution editor|solution code|your code|edit code here|program|code|code editor)$/.test(value)) return 'source';
    if (/^(input|input editor|stdin|custom input)$/.test(value)) return 'input';
    if (/^(output|output editor|stdout|actual output|run output)$/.test(value)) return 'output';
    if (/^(error|errors|error editor|stderr|compiler error|compile error)$/.test(value)) return 'error';
    if (/^(expected output|expected output editor)$/.test(value)) return 'expected';
    if (/^(testbench|test bench|test bench editor)$/.test(value)) return 'testbench';
    return '';
  };
  const roleOf = (node) => {
    for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth++) {
      const explicit = role(current.getAttribute?.('data-editor-role')) || role(current.getAttribute?.('data-testid')) || role(current.getAttribute?.('aria-label'));
      if (explicit) return explicit;
      const previous = role(label(current.previousElementSibling));
      if (previous) return previous;
      const headings = Array.from(current.children || []).filter((child) => child !== node && !child.contains?.(node))
        .map((child) => role(label(child))).filter(Boolean);
      if (new Set(headings).size === 1) return headings[0];
    }
    return '';
  };
  const runtime = () => {
    const selector = document.querySelector('[data-testid="runtime-selector"], [data-testid="language-selector"], select[name="language"], select[name="runtime"]');
    const chosen = selector?.selectedOptions?.[0]?.textContent || selector?.innerText || '';
    const patterns = /(?:Verilog\s*\(Icarus\s+[\d.]+\)|MIPS\s*\(?Mars\s+[\d.]+\)?|Python\s+[23](?:\.[\d]+)*(?:\s*\([^\n)]+\))?|C\+\+\s*\([^\n)]+\)|Java\s*\([^\n)]+\)|JavaScript\s*\([^\n)]+\))/gi;
    const labels = chosen.trim() ? [chosen.trim()] : [...new Set((document.body?.innerText || '').match(patterns) || [])];
    if (labels.length !== 1) return null;
    const name = labels[0];
    const family = /verilog/i.test(name) ? 'verilog' : /mips|mars/i.test(name) ? 'mips' : /python|pypy/i.test(name) ? 'python'
      : /javascript|node\.?js/i.test(name) ? 'javascript' : /typescript/i.test(name) ? 'typescript' : /c\+\+|g\+\+|clang\+\+/i.test(name) ? 'cpp'
        : /^java\b|openjdk/i.test(name) ? 'java' : /^c(?:\s|$|\()/i.test(name) ? 'c' : /^go(?:lang)?\b/i.test(name) ? 'go'
          : /rust/i.test(name) ? 'rust' : /ruby/i.test(name) ? 'ruby' : /c#|csharp/i.test(name) ? 'csharp' : null;
    return family ? { language: family, label: name } : null;
  };
  const inspectModels = () => {
    const available = models();
    const editors = api?.getEditors?.() || [];
    const domEditors = Array.from(document.querySelectorAll('.monaco-editor')).filter(visible);
    return available.map((model) => {
      const owners = editors.filter((editor) => editor.getModel?.() === model && visible(editor.getDomNode?.()));
      const editor = owners.length === 1 ? owners[0] : null;
      const targetId = model.uri?.toString?.() || '';
      const languageId = model.getLanguageId?.() || '';
      // Fallback uses an explicitly associated visible DOM editor, never array order.
      const associated = domEditors.filter((node) => node.getAttribute?.('data-model-uri') === targetId || node.getAttribute?.('data-uri') === targetId);
      const languageNodes = domEditors.filter((node) => node.getAttribute?.('data-mode-id') === languageId);
      const uniqueLanguage = available.filter((item) => item.getLanguageId?.() === languageId).length === 1;
      const node = editor?.getDomNode?.() || (associated.length === 1 ? associated[0] :
        uniqueLanguage && languageNodes.length === 1 && model.isAttachedToEditor?.() === true ? languageNodes[0] : null);
      const input = node?.querySelector?.('textarea.inputarea, textarea[aria-label], [role="textbox"][aria-readonly]');
      const readOnlyOption = api?.EditorOption?.readOnly;
      const option = editor && readOnlyOption !== undefined && typeof editor.getOption === 'function' ? editor.getOption(readOnlyOption) : undefined;
      let readOnly = typeof option === 'boolean' ? option : null;
      if (readOnly === null && input && (typeof input.readOnly === 'boolean' || ['true', 'false'].includes(input.getAttribute?.('aria-readonly')))) {
        readOnly = input.readOnly === true || input.getAttribute?.('aria-readonly') === 'true';
      }
      const roleHint = roleOf(node);
      const nativeEdit = Boolean(node && readOnly === false && typeof model.getFullModelRange === 'function' &&
        (typeof editor?.executeEdits === 'function' || (typeof model.pushEditOperations === 'function' && typeof model.pushStackElement === 'function')));
      return { model, editor, node, targetId, source: model.getValue(), languageId, roleHint, readOnly, nativeEdit,
        editable: readOnly !== true, editabilityVerified: readOnly !== null };
    }).filter((entry) => entry.targetId);
  };
  const plain = ({ model, editor, node, ...value }) => value;
  const languageMatches = (language, mode) => {
    const aliases = { mips: ['mips', 'asm', 'assembly'], python: ['python'], verilog: ['verilog', 'systemverilog'], cpp: ['cpp', 'c++'], c: ['c', 'cpp'] };
    return (aliases[language] || [language]).includes(mode.toLowerCase());
  };
  const sourceOf = (entries, profile) => {
    const selectedId = payload.snapshot?.sourceTargetId || payload.selectedTargetId;
    if (selectedId) return entries.find((entry) => entry.targetId === selectedId && entry.editable && !['input', 'output', 'error', 'expected', 'testbench'].includes(entry.roleHint));
    const declared = entries.filter((entry) => entry.roleHint === 'source' && entry.editabilityVerified && entry.editable);
    if (declared.length === 1) return declared[0];
    if (declared.length) return null;
    const candidates = entries.filter((entry) => entry.editable && entry.editabilityVerified &&
      !['input', 'output', 'error', 'expected', 'testbench'].includes(entry.roleHint) && profile &&
      (languageMatches(profile.language, entry.languageId) || (profile.language === 'mips' && /^(plaintext|text)$/i.test(entry.languageId) &&
        /^\s*\.text\b/m.test(entry.source) && /^\s*main\s*:/m.test(entry.source))));
    return candidates.length === 1 ? candidates[0] : null;
  };
  const runControls = () => Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
    .filter((element) => visible(element) && /^run(?:\s+code)?$/i.test(label(element)));
  const busy = (button) => Boolean(button?.disabled || button?.getAttribute?.('aria-disabled') === 'true' ||
    button?.getAttribute?.('aria-busy') === 'true' || /^(running|compiling|executing)(?:\b|\.{1,3})/i.test(label(button)));
  const runOutput = (entries = inspectModels()) => {
    const fields = entries.filter((entry) => ['output', 'error'].includes(entry.roleHint))
      .map((entry) => ({ id: entry.targetId, role: entry.roleHint, text: entry.source, version: entry.model.getVersionId?.() ?? null, node: entry.node }));
    for (const kind of ['output', 'error']) {
      if (fields.some((field) => field.role === kind)) continue;
      const nodes = Array.from(document.querySelectorAll(`[data-testid="run-${kind}"], [data-editor-role="${kind}"], [aria-label="${kind}"], [aria-label="${kind.toUpperCase()}"]`)).filter(visible);
      if (nodes.length === 1) fields.push({ id: `dom:${kind}`, role: kind, text: label(nodes[0]), version: null, node: nodes[0] });
    }
    const statuses = Array.from(document.querySelectorAll('[data-testid="run-status"], [data-testid="execution-status"], [data-run-status], [role="status"], [role="alert"]'))
      .filter(visible).map(label).filter((value) => /(?:compil|runn?ing|execut|test.?case|wrong answer|time limit|memory limit|runtime error|accepted|passed|successful)/i.test(value));
    return { fields, statuses };
  };
  const outputSignature = (output) => JSON.stringify({ fields: output.fields.map(({ node, ...field }) => field), statuses: output.statuses });
  const fieldSignature = (output) => JSON.stringify(output.fields.map(({ node, ...field }) => field));
  const errorSignature = (output) => JSON.stringify(output.fields.filter((field) => field.role === 'error').map(({ node, ...field }) => field));
  const inspect = () => {
    const profile = runtime();
    const entries = inspectModels();
    const selected = sourceOf(entries, profile);
    const warnings = alerts();
    const complete = entries.length <= 100 && entries.reduce((total, entry) => total + entry.source.length, 0) <= 1000000 &&
      new Set(entries.map((entry) => entry.targetId)).size === entries.length;
    const reasons = [];
    if (!complete) reasons.push('The source context is too large or model identities are ambiguous; no context was truncated.');
    if (!selected) reasons.push('Select the verified source editor; input, testbench and output editors are separate.');
    if (!profile) reasons.push('A unique explicit runtime label is required.');
    if (selected && !selected.nativeEdit) reasons.push('The selected model has no verified writable native Monaco integration.');
    if (warnings.length) reasons.push('A visible portal dialog or warning needs attention.');
    const ready = Boolean(complete && selected && profile && !warnings.length);
    const outputs = runOutput(entries);
    const canRun = ready && runControls().length === 1 && (outputs.fields.length > 0 || outputs.statuses.length > 0);
    if (ready && !canRun) reasons.push('A unique Run control and readable result area are required to verify execution.');
    return { documentToken: token, runtime: profile, sourceTargetId: selected?.targetId || null,
      candidates: entries.map(plain),
      targets: selected ? entries.filter((entry) => !['output', 'error'].includes(entry.roleHint))
        .map((entry) => ({ ...plain(entry), editable: entry.targetId === selected.targetId })) : [],
      warnings, reasons, complete,
      capabilities: { generate: ready, apply: ready && selected.nativeEdit, restore: ready && selected.nativeEdit, run: canRun, save: ready } };
  };
  const checkSnapshot = (snapshot, overrides = {}) => {
    if (!snapshot || JSON.stringify(runtime()) !== JSON.stringify(snapshot.runtime)) return 'The compiler or runtime changed.';
    const current = inspect();
    if (current.sourceTargetId !== snapshot.sourceTargetId || current.targets.length !== snapshot.targets.length) return 'The source editor or dependency models changed.';
    for (const expected of snapshot.targets) {
      const target = current.targets.find((entry) => entry.targetId === expected.targetId);
      if (!target || target.languageId !== expected.languageId || target.roleHint !== expected.roleHint || target.readOnly !== expected.readOnly ||
        target.source !== (Object.hasOwn(overrides, expected.targetId) ? overrides[expected.targetId] : expected.source)) return 'A source, input or testbench changed.';
    }
    return alerts().length ? 'A visible portal warning needs attention.' : null;
  };
  const digest = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const stateKey = '__solverAICodeExecutionsV1';
  if (!window[stateKey] || window[stateKey].documentToken !== token) window[stateKey] = { documentToken: token, records: {} };
  const state = window[stateKey];
  const execution = (record) => ({ runId: record.runId, requestId: record.runId, targetId: record.snapshot.sourceTargetId,
    sourceHash: record.snapshot.targets.find((target) => target.targetId === record.snapshot.sourceTargetId)?.sourceHash,
    documentToken: token, startedAt: record.startedAt, status: record.status });
  const sample = (record) => {
    const output = runOutput();
    const controls = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
      .filter((element) => visible(element) && /^(?:run(?:\s+code)?|running(?:\.{1,3})?|compiling(?:\.{1,3})?)$/i.test(label(element)));
    const button = record.button?.isConnected === false ? controls.length === 1 ? controls[0] : null : record.button;
    if (button) record.button = button;
    record.sawBusy ||= busy(button);
    record.resultChanged ||= outputSignature(output) !== record.baseline;
    record.fieldsChanged ||= fieldSignature(output) !== record.baselineFields;
    record.errorChanged ||= errorSignature(output) !== record.baselineErrors;
    record.statusChanged ||= JSON.stringify(output.statuses) !== record.baselineStatuses;
    return { output, button, running: busy(button) };
  };
  const finish = (record, result) => {
    record.status = result.status;
    record.result = result;
    record.observer?.disconnect();
    return { ...result, execution: execution(record) };
  };

  try {
    if (operation === 'read') return inspect();
    if (operation === 'apply' || operation === 'restore') {
      if (!inspect().capabilities.apply) return fail('unsupported', 'Native source editing is unavailable, ambiguous, or blocked by a visible warning.');
      const { snapshot, edits } = payload;
      if (!Array.isArray(edits) || edits.length !== 1 || edits[0].targetId !== snapshot?.sourceTargetId) return fail('conflict', 'Only the selected source editor may be changed.');
      const edit = edits[0];
      const expected = snapshot.targets.find((target) => target.targetId === edit.targetId);
      if (!expected?.editable || edit.baseSourceHash !== expected.sourceHash || await digest(expected.source) !== expected.sourceHash || typeof edit.content !== 'string') {
        return fail('conflict', 'The edit source guard is invalid.');
      }
      const overrides = operation === 'restore' ? { [edit.targetId]: edit.content } : {};
      const conflict = checkSnapshot(snapshot, overrides);
      if (conflict) return fail('conflict', conflict);
      const entry = inspectModels().find((candidate) => candidate.targetId === edit.targetId);
      const content = operation === 'restore' ? expected.source : edit.content;
      if (expected.editableRange && operation === 'apply') {
        const { start, end } = expected.editableRange;
        if (!content.startsWith(expected.source.slice(0, start)) || !content.endsWith(expected.source.slice(end))) return fail('conflict', 'The edit changes protected starter code.');
      }
      const before = entry.model.getValue();
      let error;
      try {
        const changes = [{ range: entry.model.getFullModelRange(), text: content, forceMoveMarkers: true }];
        if (entry.editor?.executeEdits) {
          entry.editor.pushUndoStop?.();
          if (entry.editor.executeEdits('SolverAI', changes) === false) throw new Error('The native editor rejected the edit.');
          entry.editor.pushUndoStop?.();
        } else {
          entry.model.pushStackElement();
          entry.model.pushEditOperations([], changes, () => null);
          entry.model.pushStackElement();
        }
      } catch (caught) { error = caught; }
      const observedAfterEdit = entry.model.getValue();
      const changedTargetIds = observedAfterEdit !== before ? [edit.targetId] : [];
      const appliedEdits = changedTargetIds.map((targetId) => ({ targetId, baseSourceHash: expected.sourceHash, content: observedAfterEdit }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const actual = entry.model.getValue();
      const after = checkSnapshot(snapshot, { [edit.targetId]: actual });
      if (error || after || actual !== content || actual !== observedAfterEdit) return fail(changedTargetIds.length ? 'partial' : 'conflict', error?.message || after || 'Source changed before complete readback. Further edits were not attributed to this operation.', { changedTargetIds, appliedEdits });
      return { success: true, status: operation === 'restore' ? 'restored' : 'applied', changedTargetIds, appliedEdits };
    }
    if (operation === 'ready') {
      const conflict = checkSnapshot(payload.snapshot);
      return conflict ? fail('conflict', conflict) : { success: true, status: 'ready', saved: false,
        reason: 'The current source is verified in the editor. Server persistence has not been asserted.' };
    }
    if (operation === 'start') {
      const { snapshot, runId } = payload;
      if (!runId || typeof runId !== 'string') return fail('conflict', 'A run ID is required.');
      const existing = state.records[runId];
      if (existing) {
        if (existing.snapshot.contextHash !== snapshot.contextHash) return fail('conflict', 'This run ID belongs to different source.');
        return { success: existing.status === 'running' || existing.status === 'completed', status: existing.status,
          execution: execution(existing), deduplicated: true };
      }
      const conflict = checkSnapshot(snapshot);
      if (conflict) return fail('conflict', conflict);
      if (!inspect().capabilities.run) return fail('unsupported', 'A unique Run control and readable result area are required.');
      if (Object.values(state.records).some((record) => ['running', 'unknown', 'dispatching'].includes(record.status))) return fail('unknown', 'The previous run is unresolved. Reconcile it before running again.');
      const button = runControls()[0];
      if (busy(button)) return fail('needs_attention', 'The Run control is already busy or disabled.');
      for (const id of Object.keys(state.records)) if (Object.keys(state.records).length >= 32 && !['running', 'unknown', 'dispatching'].includes(state.records[id].status)) delete state.records[id];
      const initialOutput = runOutput();
      const record = { runId, snapshot, button, startedAt: Date.now(), status: 'dispatching', baseline: outputSignature(initialOutput),
        baselineFields: fieldSignature(initialOutput), baselineErrors: errorSignature(initialOutput), baselineStatuses: JSON.stringify(initialOutput.statuses),
        sawBusy: false, resultChanged: false, fieldsChanged: false, errorChanged: false, statusChanged: false };
      state.records[runId] = record;
      if (typeof MutationObserver === 'function') {
        record.observer = new MutationObserver((changes) => {
          for (const change of changes) {
            if (change.target === record.button && ['disabled', 'aria-disabled', 'aria-busy'].includes(change.attributeName) && change.oldValue !== null) record.sawBusy = true;
          }
          sample(record);
        });
        record.observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
      }
      try { button.click(); } catch (error) { return finish(record, fail('unknown', `Run may have started: ${error.message}`)); }
      record.status = 'running';
      sample(record);
      return { success: true, status: 'running', execution: execution(record) };
    }
    if (operation === 'poll') {
      const record = state.records[payload.execution?.runId];
      if (!record || payload.execution.requestId !== record.runId) return fail('unknown', 'This document has no matching run record.');
      const conflict = checkSnapshot(record.snapshot);
      if (conflict) return finish(record, fail('unknown', conflict));
      if (record.result && ['completed', 'failed'].includes(record.result.status)) return { ...record.result, execution: execution(record) };
      const { output, button, running } = sample(record);
      if (!button || running || !record.sawBusy || !record.resultChanged) return { success: false, status: 'running', execution: execution(record) };
      const outputText = output.fields.filter((field) => field.role === 'output').map((field) => field.text).join('\n');
      const errorText = output.fields.filter((field) => field.role === 'error').map((field) => field.text).join('\n');
      if (errorText.trim() && !record.errorChanged) return finish(record, fail('unknown', 'The earlier error output has not refreshed; it cannot be attributed to this run.'));
      const statusText = output.statuses.join('\n');
      if (/\b(running|compiling|executing|pending|queued)\b/i.test(statusText)) return { success: false, status: 'running', execution: execution(record) };
      const terminal = /\b(wrong answer|runtime error|compilation error|compile error|time limit exceeded|memory limit exceeded|test.?cases? failed|all test.?cases? passed|tests passed|accepted|run successful|execution completed|compilation successful)\b/i;
      if (!record.fieldsChanged && !(record.statusChanged && terminal.test(statusText))) return { success: false, status: 'running', execution: execution(record) };
      const failureText = errorText.trim() || (record.statusChanged && /\b(wrong answer|runtime error|compilation error|compile error|time limit exceeded|memory limit exceeded|test.?cases? failed)\b/i.test(statusText) ? statusText : '');
      const passed = record.statusChanged && /\b(all test.?cases? passed|tests passed|accepted)\b/i.test(statusText);
      const result = { success: !failureText, status: failureText ? 'failed' : 'completed', outcome: failureText ? 'execution_error' : 'completed',
        checksPassed: failureText ? false : passed ? true : null,
        results: [{ targetId: record.snapshot.sourceTargetId, status: failureText ? 'failed' : 'completed',
          output: outputText.slice(0, 20000), error: failureText.slice(0, 12000), truncated: outputText.length > 20000 || failureText.length > 12000 }],
        reason: failureText ? 'The fresh run reported an error.' : 'A fresh run completed. Portal acceptance is separate from this run.' };
      return finish(record, result);
    }
    return fail('unsupported', 'Unknown coding adapter operation.');
  } catch (error) { return fail('unknown', error.message || 'The coding adapter could not verify the operation.'); }
}

async function invoke(context, operation, payload = {}, signal) {
  await revalidateAssignmentContext(context, { outerContextHash: payload.snapshot?.outerContextHash });
  if (signal?.aborted) return { success: false, status: 'stopped', changedTargetIds: [], reason: 'Stopped before dispatching the coding operation.' };
  const results = await chrome.scripting.executeScript({ target: injectionTarget(context), world: 'MAIN',
    func: codePageOperation, args: [operation, { ...payload, documentToken: context.documentToken,
      selectedTargetId: context.sourceTargetId || context.selectedTargetId || null }] });
  const result = results[0]?.result || { success: false, status: 'unknown', reason: 'The coding document returned no result.' };
  try { await revalidateAssignmentContext(context, { outerContextHash: payload.snapshot?.outerContextHash }); }
  catch (error) { return { ...result, success: false, status: 'unknown', reason: error.message }; }
  return result;
}

export async function readCodeSnapshot(context) {
  const outer = await revalidateAssignmentContext(context);
  const data = await invoke(context, 'read');
  if (!data.targets) throw new Error(data.reason || 'Coding snapshot unavailable.');
  if (!outer.statement?.trim()) {
    data.capabilities.generate = false;
    data.reasons.push('A stable assignment statement is required before generation.');
  }
  return finalizeSnapshot(context, { ...data, ...outer });
}
async function applyEdits(context, snapshot, edits, { signal } = {}) { return invoke(context, 'apply', { snapshot, edits }, signal); }
async function restoreEdits(context, snapshot, edits, { signal } = {}) { return invoke(context, 'restore', { snapshot, edits }, signal); }
async function startExecution(context, snapshot, { runId, signal }) { return invoke(context, 'start', { snapshot, runId }, signal); }
async function pollExecution(context, execution) { return invoke(context, 'poll', { execution }); }
async function save(context, snapshot, { signal } = {}) { return invoke(context, 'ready', { snapshot }, signal); }

async function runChecks(context, snapshot, { timeoutMs = 60000, signal, onExecution } = {}) {
  if (signal?.aborted) return { success: false, status: 'stopped', reason: 'Stopped before Run.' };
  const runId = crypto.randomUUID();
  await onExecution?.({ runId, requestId: runId, targetId: snapshot.sourceTargetId, status: 'dispatching' });
  if (signal?.aborted) return { success: false, status: 'stopped', reason: 'Stopped before Run.' };
  const started = await startExecution(context, snapshot, { runId, signal });
  if (started.execution) await onExecution?.(started.execution);
  if (!started.success) return started;
  const deadline = Date.now() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 3600000) : 60000);
  while (true) {
    if (signal?.aborted) return { success: false, status: 'unknown', execution: started.execution, reason: 'Stopped waiting. Reconcile the already dispatched run before another Run.' };
    const result = await pollExecution(context, started.execution);
    if (result.status !== 'running') return result;
    if (Date.now() >= deadline) return { success: false, status: 'unknown', execution: started.execution, reason: 'Run timed out. Its outcome must be reconciled before another Run.' };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export const codeAdapter = { readSnapshot: readCodeSnapshot, applyEdits, restoreEdits, startExecution, pollExecution, runChecks, save };
