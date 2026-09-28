export const ASSIGNMENT_STORAGE_KEY = 'assignment_job_v1';
const RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024;
const INTERRUPTED = new Set(['generating', 'applying', 'running', 'saving', 'submitting', 'restoring', 'stopping']);
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const sourceMetadata = (value) => Object.fromEntries(Object.entries(value || {})
  .filter(([key]) => !['execution', 'ExecuteTime'].includes(key)));

function generationSnapshot(snapshot) {
  const { kind, problemId, documentId, title, statement, runtime } = snapshot;
  return { kind, problemId, documentId, title, statement, runtime,
    targets: snapshot.targets.map(({ targetId, source, sourceHash, editable, cellType, label, editableRange }) =>
      ({ targetId, source, sourceHash, editable, cellType, label, editableRange })) };
}

export function sameAssignmentSource(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.problemId === b.problemId &&
    a.documentId === b.documentId && a.url === b.url &&
    JSON.stringify(a.runtime) === JSON.stringify(b.runtime) &&
    JSON.stringify(a.notebookIdentity) === JSON.stringify(b.notebookIdentity) &&
    JSON.stringify(a.kernelIdentity) === JSON.stringify(b.kernelIdentity) &&
    a.statement === b.statement && a.title === b.title &&
    a.contextHash === b.contextHash && a.targets?.length === b.targets?.length &&
    a.targets.every((target, index) => {
      const current = b.targets[index];
      return target.targetId === current?.targetId && target.source === current.source &&
        target.sourceHash === current.sourceHash && target.editable === current.editable &&
        target.cellType === current.cellType && JSON.stringify(sourceMetadata(target.metadata)) === JSON.stringify(sourceMetadata(current.metadata));
    }));
}

function validateEdits(snapshot, targetIds, edits) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('The solver returned no edits.');
  const seen = new Set();
  for (const edit of edits) {
    const target = snapshot.targets.find((item) => item.targetId === edit.targetId);
    if (!targetIds.includes(edit.targetId) || !target?.editable || seen.has(edit.targetId) ||
        target.sourceHash !== edit.baseSourceHash || typeof edit.content !== 'string' || (!edit.content.trim() && target.source.trim())) {
      throw new Error('The solver returned an invalid, duplicate, or stale edit target.');
    }
    seen.add(edit.targetId);
  }
  if (seen.size !== targetIds.length) throw new Error('The response did not cover every selected edit target.');
}

/** All effects pass through this one worker-owned runner, including durable pre-effect checkpoints. */
export function createAssignmentRunner({ storage, detect, adapters, api, notify = () => {},
  submission, now = Date.now, makeId = () => crypto.randomUUID(), isOtherBusy = () => false }) {
  let job = null;
  let loaded = false;
  let loading;
  let busy = false;
  let controller;
  let activeKey;
  let writes = Promise.resolve();

  const view = () => ({ job: clone(job), busy });
  const emit = () => notify(view());

  async function persist() {
    if (!storage?.set) throw new Error('Chrome storage is unavailable; assignment actions cannot be checkpointed.');
    job.updatedAt = now();
    job.expiresAt = now() + RETENTION_MS;
    const value = clone(job);
    if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_CHECKPOINT_BYTES) {
      throw new Error('This assignment exceeds the 2 MB recovery limit. Narrow the notebook context before proceeding.');
    }
    writes = writes.catch(() => {}).then(() => storage.set({ [ASSIGNMENT_STORAGE_KEY]: value }));
    await writes;
    emit();
  }

  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      const saved = await storage?.get?.(ASSIGNMENT_STORAGE_KEY);
      job = saved?.[ASSIGNMENT_STORAGE_KEY] || null;
      const unresolved = job && (INTERRUPTED.has(job.phase) || job.pendingRequestId || job.pendingSaveId || job.pendingSubmissionId || job.recovery?.required);
      if (job && ((job.expiresAt <= now() && !unresolved) || job.version !== 1)) {
        await storage.remove(ASSIGNMENT_STORAGE_KEY);
        job = null;
      }
      if (job && (INTERRUPTED.has(job.phase) || job.pendingRequestId || job.pendingSaveId || job.pendingSubmissionId || job.recovery?.required)) {
        job.interruptedPhase ||= job.phase;
        job.phase = 'needs_reconciliation';
        job.recovery = { required: true, message: 'Check the current page before continuing this saved job.' };
      }
      loaded = true;
    })();
    try { await loading; } finally { loading = null; }
  }

  function checkStopped() {
    if (controller?.signal.aborted) throw new Error('Assignment stopped.');
  }

  function adapter() {
    const selected = adapters[job?.snapshot?.kind];
    if (!selected) throw new Error('Open a supported coding assignment or classic Jupyter notebook.');
    return selected;
  }

  function requireReady() {
    if (!job?.snapshot) throw new Error('Inspect an assignment first.');
    if (job.recovery?.required) throw new Error('Reconcile the saved job before continuing.');
    checkStopped();
  }

  function requireCapability(name) {
    requireReady();
    if (!job.snapshot.capabilities?.[name]) {
      throw new Error(job.snapshot.reasons?.join(' ') || `${name} is unavailable in this workspace.`);
    }
  }

  async function phase(value, extra = {}) {
    if (!['needs_attention', 'stopped', 'stopping'].includes(value)) job.error = null;
    Object.assign(job, extra, { phase: value });
    await persist();
    checkStopped();
  }

  async function currentSnapshot(expected = job.snapshot) {
    const snapshot = await adapter().readSnapshot(job.context);
    checkStopped();
    if (!sameAssignmentSource(expected, snapshot)) {
      throw new Error('The assignment, runtime, cell order, or source changed. Inspect again to preserve your edits.');
    }
    if (snapshot.warnings?.length) throw new Error(snapshot.warnings.join(' '));
    return snapshot;
  }

  function updateUsage(data) {
    const ledger = data?.job || {};
    job.usage = {
      ...job.usage,
      logicalGenerations: ledger.logicalCalls ?? job.usage.logicalGenerations,
      providerAttempts: ledger.providerAttempts ?? job.usage.providerAttempts,
      totalTokens: ledger.knownUsage?.total_tokens ?? job.usage.totalTokens,
      unknownUsage: ledger.unknownUsageAttempts ?? job.usage.unknownUsage,
    };
    job.providerLedger = ledger;
  }

  async function inspect({ tabId, sourceTargetId, waitForReady = false }) {
    const deadline = Date.now() + (waitForReady ? 20000 : 0);
    let context;
    let snapshot;
    while (true) {
      checkStopped();
      context = await detect(tabId);
      if (sourceTargetId) context.sourceTargetId = sourceTargetId;
      checkStopped();
      if (adapters[context.kind]) snapshot = await adapters[context.kind].readSnapshot(context);
      const ready = snapshot && ['generate', 'apply', 'run', 'save'].every((cap) => snapshot.capabilities?.[cap]);
      const workspace = /\/playground\/(?:code|newton-box)\//.test(context.url || snapshot?.url || '');
      if (!waitForReady || ready || snapshot?.warnings?.length || !workspace || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!snapshot || !adapters[context.kind]) throw Object.assign(new Error(context.reasons?.join(' ') || 'This page is not a supported assignment.'), { code: 'UNSUPPORTED_WORKSPACE' });
    checkStopped();
    job = {
      version: 1, id: makeId(), context, snapshot, phase: 'inspected',
      edits: [], selectedTargetIds: [], appliedTargetIds: [], canRestore: false,
      executionLedger: {},
      budget: { maxAttempts: 6, maxGenerations: 3 },
      usage: { logicalGenerations: 0, providerAttempts: 0, totalTokens: null, unknownUsage: 0 },
      recovery: { required: false }, createdAt: now(),
    };
    await persist();
  }

  async function generate(payload) {
    requireCapability('generate');
    if (job.pendingRequestId) throw new Error('The previous generation outcome needs reconciliation.');
    if (job.usage.logicalGenerations >= 3) throw new Error('This job used its three generation calls.');
    const ids = payload.targetIds || job.selectedTargetIds;
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
        ids.some((id) => !job.snapshot.targets.find((target) => target.targetId === id && target.editable))) {
      throw new Error('Select the editable source or notebook cells to generate.');
    }
    if (job.usage.logicalGenerations && (JSON.stringify([...ids].sort()) !== JSON.stringify([...job.selectedTargetIds].sort()) || !payload.feedback)) {
      throw new Error('Further generations require fresh failure feedback for the same targets. Inspect again for a new task.');
    }
    await currentSnapshot();
    job.selectedTargetIds = [...ids];
    job.draftSnapshot = clone(job.snapshot);
    job.pendingRequestId = makeId();
    job.usage.logicalGenerations += 1;
    job.error = null;
    job.edits = [];
    await phase('generating');
    let data;
    try {
      data = await api.generate({
        jobId: job.id, requestId: job.pendingRequestId, snapshot: generationSnapshot(job.snapshot), targetIds: ids,
        feedback: payload.feedback, apiKey: payload.apiKey, model: payload.model,
        maxTokens: Number(payload.maxTokens || (job.snapshot.kind === 'notebook' ? 4096 : 2048)),
      }, controller.signal);
    } catch (error) {
      updateUsage(error.data);
      if (error.status) job.pendingRequestId = null;
      else job.recovery = { required: true, message: 'Generation response was lost. Reconcile before another request.' };
      throw error;
    }
    updateUsage(data);
    job.pendingRequestId = null;
    checkStopped();
    validateEdits(job.draftSnapshot, ids, data.edits);
    if (!payload.allowUnchanged && data.edits.every((edit) => job.draftSnapshot.targets.find((target) => target.targetId === edit.targetId).source === edit.content)) {
      throw new Error('The candidate repeats the current source. No edit or additional execution was started.');
    }
    job.edits = data.edits;
    job.explanation = data.explanation || '';
    job.assumptions = data.assumptions || [];
    job.cacheHit = Boolean(data.cacheHit);
    await currentSnapshot(job.draftSnapshot);
    await phase('draft');
  }

  async function apply() {
    requireCapability('apply');
    validateEdits(job.draftSnapshot, job.selectedTargetIds, job.edits);
    await currentSnapshot(job.draftSnapshot);
    job.originalSnapshot ||= clone(job.draftSnapshot);
    const firstChangedIndex = Math.min(...job.edits.filter((edit) =>
      job.draftSnapshot.targets.find((target) => target.targetId === edit.targetId)?.source !== edit.content)
      .map((edit) => job.draftSnapshot.targets.findIndex((target) => target.targetId === edit.targetId)));
    // Reuse completed setup before the earliest edited cell. Changed cells and
    // downstream checks must run again; arbitrary dependencies are never inferred.
    for (const [id] of Object.entries(job.executionLedger || {})) {
      if (job.draftSnapshot.targets.findIndex((target) => target.targetId === id) >= firstChangedIndex) delete job.executionLedger[id];
    }
    // Keep the proposed source and originals before dispatch, even if the worker exits mid-write.
    await phase('applying');
    const result = await adapter().applyEdits(job.context, job.draftSnapshot, job.edits, { signal: controller.signal });
    const changed = result.changedTargetIds || [];
    const latest = new Map((job.appliedEdits || []).map((edit) => [edit.targetId, edit]));
    const actualEdits = result.appliedEdits || job.edits.filter((item) => changed.includes(item.targetId));
    for (const edit of actualEdits) {
      const original = job.originalSnapshot.targets.find((target) => target.targetId === edit.targetId);
      latest.set(edit.targetId, { ...edit, baseSourceHash: original.sourceHash });
    }
    job.appliedEdits = [...latest.values()];
    job.appliedTargetIds = [...latest.keys()];
    job.canRestore = latest.size > 0;
    if (result.snapshot) job.snapshot = result.snapshot;
    await persist();
    checkStopped();
    if (!result.success) {
      if (result.status === 'partial' && result.appliedEdits?.length) {
        job.snapshot = await adapter().readSnapshot(job.context);
        await phase('needs_attention', { reason: 'Some edits were applied. Review the recorded changes or restore the original source.' });
      }
      throw new Error(result.reason || 'The edit could not be fully verified.');
    }
    job.snapshot = result.snapshot || await adapter().readSnapshot(job.context);
    for (const edit of job.edits) {
      if (job.snapshot.targets.find((target) => target.targetId === edit.targetId)?.source !== edit.content) {
        throw new Error('Source readback did not match the proposed edit.');
      }
    }
    await phase('applied');
  }

  async function run(payload) {
    requireCapability('run');
    if (['unknown', 'running'].includes(job.execution?.status)) throw new Error('The previous execution is unresolved. Reconcile it before another run.');
    const ids = payload.targetIds;
    if (!Array.isArray(ids) || !ids.length) throw new Error('Select the source or notebook cells to run, including required dependencies.');
    await currentSnapshot();
    job.execution = { status: 'running', targetIds: ids, results: [], message: 'Running selected cells in notebook order.' };
    await phase('running');
    const result = await adapter().runChecks(job.context, job.snapshot, {
      targetIds: ids, timeoutMs: job.snapshot.kind === 'notebook' ? 20 * 60 * 1000 : 120000, signal: controller.signal,
      onExecution: async (execution) => {
        job.execution = { ...job.execution, ...execution };
        await persist();
      },
    });
    job.execution = result;
    job.executionLedger ||= {};
    for (const item of result.results || []) {
      if (item.status === 'completed' && !item.error) {
        const target = job.snapshot.targets.find((target) => target.targetId === item.targetId);
        if (target) job.executionLedger[item.targetId] = { sourceHash: target.sourceHash, kernelIdentity: job.snapshot.kernelIdentity };
      }
    }
    if (result.snapshot) job.snapshot = result.snapshot;
    else if (['completed', 'failed'].includes(result.status)) job.snapshot = await adapter().readSnapshot(job.context);
    await persist();
    checkStopped();
    if (!result.success) {
      if (result.status === 'failed') await phase('needs_attention');
      throw new Error(result.reason || 'Notebook execution failed or has an unknown outcome.');
    }
    await phase('completed');
  }

  async function save() {
    requireCapability('save');
    await currentSnapshot();
    job.pendingSaveId = makeId();
    await phase('saving');
    const result = await adapter().save(job.context, job.snapshot, { timeoutMs: 15000, saveId: job.pendingSaveId, signal: controller.signal });
    job.saveResult = result;
    if (result.snapshot) job.snapshot = result.snapshot;
    else if (result.success || result.status === 'partial') job.snapshot = await adapter().readSnapshot(job.context);
    if (!result.success) {
      if (result.status === 'unknown') job.recovery = { required: true, message: 'Check the pending save acknowledgement before another save.' };
      else job.pendingSaveId = null;
      throw new Error(result.reason || 'Notebook saving was not acknowledged.');
    }
    job.pendingSaveId = null;
    job.savedSnapshot = clone(job.snapshot);
    await phase(job.snapshot.kind === 'notebook' ? 'saved' : 'ready', { reason: job.snapshot.kind === 'notebook'
      ? 'Notebook saved. Review the outputs; the assignment has not been submitted.'
      : 'Source verified in the coding editor and ready for submission.' });
  }

  async function submit() {
    requireReady();
    if (!submission) throw new Error('Portal submission is unavailable.');
    if (job.pendingSubmissionId) throw new Error('The previous submission must be reconciled before continuing.');
    if (!job.execution?.success || job.execution.status !== 'completed') throw new Error('Run the current source successfully before submitting.');
    if (!job.saveResult?.success || !sameAssignmentSource(job.savedSnapshot, job.snapshot)) throw new Error('Save and verify the current source before submitting.');
    await currentSnapshot();
    job.pendingSubmissionId = makeId();
    await phase('submitting');
    const result = await submission.submit(job.context, job.snapshot, {
      submissionId: job.pendingSubmissionId, signal: controller.signal,
      onSubmission: async (record) => { job.submission = record; await persist(); },
      beforeDispatch: async () => {
        const current = await adapter().readSnapshot(job.context);
        checkStopped();
        if (!sameAssignmentSource(job.snapshot, current)) throw new Error('The source changed before submission. No further submit controls were clicked.');
      },
    });
    job.submission = result;
    if (['accepted', 'submitted', 'rejected'].includes(result.status)) job.pendingSubmissionId = null;
    else if (result.status === 'stopped') job.pendingSubmissionId = null;
    else if (result.status === 'unknown' || result.submission?.dispatched) {
      job.recovery = { required: true, message: 'The submission outcome needs reconciliation; it will not be replayed.' };
    } else job.pendingSubmissionId = null;
    await persist();
    checkStopped();
    if (!result.success) {
      if (result.status === 'rejected') await phase('needs_attention');
      throw new Error(result.reason || 'The portal has not acknowledged this submission.');
    }
    const after = await adapter().readSnapshot(job.context);
    if (!sameAssignmentSource(job.snapshot, after)) throw new Error('The source changed while submitting. Review the portal result.');
    job.snapshot = after;
    await phase(result.status, { reason: result.status === 'accepted'
      ? 'The portal accepted this solution.' : 'The portal acknowledged submission. Grading is pending.' });
  }

  async function restore() {
    requireCapability('restore');
    if (!job.canRestore || !job.originalSnapshot) throw new Error('This job has no applied edits to restore.');
    await phase('restoring');
    const result = await adapter().restoreEdits(job.context, job.originalSnapshot, job.appliedEdits, { signal: controller.signal });
    if (result.snapshot) job.snapshot = result.snapshot;
    else if (result.success || result.status === 'partial') job.snapshot = await adapter().readSnapshot(job.context);
    const observed = new Map((result.appliedEdits || []).map((edit) => [edit.targetId, edit.content]));
    const changed = new Set(result.changedTargetIds || []);
    job.appliedEdits = job.appliedEdits.flatMap((edit) => {
      const original = job.originalSnapshot.targets.find((target) => target.targetId === edit.targetId);
      const current = job.snapshot.targets.find((target) => target.targetId === edit.targetId);
      if (changed.has(edit.targetId) && current?.source === original?.source) return [];
      // A partial restore is still owned by this job. Retain its backup and
      // guard the next attempt against the exact text the adapter observed.
      return [{ ...edit, content: observed.get(edit.targetId) ?? edit.content }];
    });
    job.appliedTargetIds = job.appliedEdits.map((edit) => edit.targetId);
    job.canRestore = job.appliedEdits.length > 0;
    job.edits = [];
    job.execution = null;
    job.executionLedger = {};
    await persist();
    checkStopped();
    if (!result.success) {
      if (result.status === 'partial') await phase('needs_attention');
      throw new Error(result.reason || 'Some sources could not be restored without overwriting changes.');
    }
    if (job.canRestore) throw new Error('Restore did not retain every original source. The remaining backups were preserved.');
    await phase('restored', { reason: 'Original source restored. Existing kernel state and outputs were not rolled back.' });
  }

  async function recover(payload) {
    if (!job?.snapshot) throw new Error('There is no saved assignment job.');
    const previous = job.interruptedPhase || job.phase;
    const live = await adapter().readSnapshot(job.context);
    if (job.pendingSubmissionId) {
      if (!sameAssignmentSource(job.snapshot, live)) throw new Error('The source changed after submission. Inspect the portal result before continuing.');
      const record = job.submission?.submission || job.submission || { submissionId: job.pendingSubmissionId };
      const result = await submission?.poll(job.context, record);
      if (!result || !['accepted', 'submitted', 'rejected'].includes(result.status)) throw new Error(result?.reason || 'Submission is still unacknowledged. It will not be replayed.');
      job.submission = result;
      job.pendingSubmissionId = null;
      job.snapshot = live;
      job.recovery = { required: false };
      job.interruptedPhase = null;
      await phase(result.status === 'rejected' ? 'needs_attention' : result.status, { reason: result.reason });
      return;
    }
    if (job.pendingRequestId) {
      const data = await api.status(job.id, payload.apiKey, job.pendingRequestId);
      updateUsage(data);
      const request = data.requests?.find((item) => item.requestId === job.pendingRequestId);
      if (request?.status === 'ready' && request.result) {
        validateEdits(job.draftSnapshot, job.selectedTargetIds, request.result.edits);
        job.edits = request.result.edits;
        job.explanation = request.result.explanation;
        job.pendingRequestId = null;
      } else if (request && ['failed', 'cancelled', 'error'].includes(request.status)) {
        job.pendingRequestId = null;
        job.error = request.error?.message || request.error || 'The generation did not finish.';
      } else throw new Error('Generation is still pending or no longer retained by the backend. Wait, or inspect to start a new job.');
    }
    if (job.pendingSaveId) {
      if (!sameAssignmentSource(job.snapshot, live)) throw new Error('The source changed while saving. Inspect it before continuing.');
      const result = await adapter().pollSave?.(job.context, job.pendingSaveId);
      if (result?.status === 'failed') {
        job.saveResult = result;
        job.pendingSaveId = null;
        job.snapshot = live;
        job.recovery = { required: false };
        job.interruptedPhase = null;
        await phase('needs_attention', { reason: result.reason || 'The earlier save failed. Its outcome was recovered without repeating it.' });
        return;
      }
      if (!result?.success || live.dirty !== false) throw new Error(result?.reason || 'The save outcome remains unverified.');
      job.saveResult = result;
      job.pendingSaveId = null;
      job.snapshot = live;
      job.savedSnapshot = clone(live);
      job.recovery = { required: false };
      job.interruptedPhase = null;
      await phase('saved', { reason: 'The earlier save was acknowledged. It was not repeated.' });
      return;
    }
    if (previous === 'running' || ['dispatching', 'running', 'unknown'].includes(job.execution?.status)) {
      const pending = job.execution?.execution || job.execution;
      const result = pending?.runId && (pending?.requestId || job.snapshot.kind === 'code')
        ? await adapter().pollExecution?.(job.context, pending) : null;
      if (job.snapshot.kind === 'code' && ['completed', 'failed'].includes(result?.status) && sameAssignmentSource(job.snapshot, live)) {
        job.execution = result;
        job.snapshot = live;
        job.recovery = { required: false };
        job.interruptedPhase = null;
        await phase(result.success ? 'completed' : 'needs_attention', { reason: 'Recovered the earlier code run without repeating it.' });
        return;
      }
      if (result?.status === 'completed' && sameAssignmentSource(job.snapshot, live)) {
        const prior = (job.execution.results || []).filter((entry) => entry.targetId !== pending.targetId);
        const errors = result.errors || (result.success === false ? [{ message: result.reason }] : []);
        const entry = { targetId: pending.targetId, status: errors.length ? 'failed' : 'completed',
          output: (result.outputs || []).map((output) => output.text).join('\n'),
          error: errors.map((error) => error.message || error.text).join('\n') };
        job.execution = { ...result, status: errors.length ? 'failed' : 'completed', results: [...prior, entry] };
        job.snapshot = live;
        job.recovery = { required: false };
        job.interruptedPhase = null;
        await phase(errors.length ? 'needs_attention' : 'completed', {
          reason: 'Recovered the earlier cell result. Remaining cells were not started; choose the cells still needed.',
        });
        return;
      }
      job.execution = { ...job.execution, status: 'unknown' };
      throw new Error('A notebook run may have continued after interruption. Inspect its outputs and kernel state before starting a new job; it will not be replayed.');
    }
    if (sameAssignmentSource(job.snapshot, live)) {
      job.snapshot = live;
      job.recovery = { required: false };
      job.interruptedPhase = null;
      await phase(job.edits.length && sameAssignmentSource(job.draftSnapshot, live) ? 'draft' : 'inspected');
      return;
    }
    const baseline = job.draftSnapshot;
    const changed = new Map(job.edits.map((edit) => [edit.targetId, edit]));
    // Identity/context must still match; substitute only the expected source fields for comparison.
    const normalized = clone(live);
    if (baseline && baseline.targets.length === live.targets.length) {
      normalized.targets = live.targets.map((target, index) => {
        const original = baseline.targets[index];
        return changed.get(target.targetId)?.content === target.source && original.targetId === target.targetId
          ? { ...target, source: original.source, sourceHash: original.sourceHash } : target;
      });
      // contextHash contains source hashes; adapters still verify current identity on every subsequent write.
      normalized.contextHash = baseline.contextHash;
    }
    if (baseline && sameAssignmentSource(baseline, normalized) && job.edits.every((edit) =>
      live.targets.find((target) => target.targetId === edit.targetId)?.source === edit.content)) {
      job.snapshot = live;
      const latest = new Map((job.appliedEdits || []).map((edit) => [edit.targetId, edit]));
      for (const edit of job.edits) latest.set(edit.targetId, {
        ...edit, baseSourceHash: job.originalSnapshot?.targets.find((target) => target.targetId === edit.targetId)?.sourceHash || edit.baseSourceHash,
      });
      job.appliedEdits = [...latest.values()];
      job.appliedTargetIds = job.edits.map((edit) => edit.targetId);
      job.canRestore = Boolean(job.originalSnapshot);
      job.recovery = { required: false };
      job.interruptedPhase = null;
      await phase('applied', { reason: 'The proposed source is already present. The edit was not repeated.' });
      return;
    }
    throw new Error('The current source differs from both the saved original and proposed edits. Inspect again; no changes were made.');
  }

  async function automate(payload) {
    for (const cap of ['generate', 'apply', 'run', 'save']) requireCapability(cap);
    if (!payload.executeIds?.length) throw new Error('Select execution cells before automating.');
    let feedback;
    while (job.usage.logicalGenerations < 3) {
      await generate({ ...payload, feedback });
      await apply();
      const executeIds = payload.executeIds.filter((id) => {
        const previous = job.executionLedger?.[id];
        const target = job.snapshot.targets.find((target) => target.targetId === id);
        return !previous || previous.sourceHash !== target?.sourceHash ||
          JSON.stringify(previous.kernelIdentity) !== JSON.stringify(job.snapshot.kernelIdentity);
      });
      try { await run({ targetIds: executeIds }); } catch (error) {
        checkStopped();
        const execution = job.execution;
        if (!execution || execution.status !== 'failed' || !execution.results?.length) throw error;
        const next = JSON.stringify(execution.results);
        if (next === feedback) throw new Error('The same execution failure repeated. Review the diagnostic before spending another request.');
        feedback = next;
        if (job.usage.logicalGenerations >= 3) throw error;
        continue;
      }
      await save();
      return;
    }
  }

  async function solve(payload) {
    // A fresh Solve must not discard an unresolved write/run/submit checkpoint.
    if (job?.pendingSubmissionId || job?.pendingRequestId || job?.pendingSaveId || job?.recovery?.required && INTERRUPTED.has(job.interruptedPhase)) {
      throw new Error('Reconcile the interrupted assignment before starting another automatic solution.');
    }
    await inspect({ ...payload, waitForReady: true });
    for (const cap of ['generate', 'apply', 'run', 'save']) requireCapability(cap);
    const support = await submission?.inspect(job.context);
    if (!support?.available) throw Object.assign(new Error(support?.reason || 'The portal Submit control is unavailable.'), { code: 'UNSUPPORTED_WORKSPACE' });
    const editable = job.snapshot.targets.filter((target) => target.editable &&
      (job.snapshot.kind === 'code' || target.cellType === 'code'));
    // Keep setup/import cells in the allowed set so a runtime diagnostic can
    // repair a dependency without discarding the original job or its budget.
    const targetIds = editable.map((target) => target.targetId);
    const executeIds = job.snapshot.targets.filter((target) => job.snapshot.kind === 'code'
      ? target.editable : target.cellType === 'code' && (target.source.trim() || targetIds.includes(target.targetId)))
      .map((target) => target.targetId);
    if (!targetIds.length || targetIds.length > 30) throw new Error('Automatic solving supports 1–30 editable source cells in one assignment.');
    job.automatic = true;
    job.executeIds = executeIds;
    await persist();
    let feedback;
    const failures = new Set();
    const candidates = new Set();
    while (job.usage.logicalGenerations < 3) {
      await generate({ ...payload, targetIds, feedback, allowUnchanged: !feedback });
      const candidate = JSON.stringify(job.edits.map(({ targetId, content }) => ({ targetId, content })));
      if (candidates.has(candidate)) throw new Error('The solver repeated a failed candidate. Automatic repairs stopped.');
      candidates.add(candidate);
      await apply();
      const needed = executeIds.filter((id) => {
        const previous = job.executionLedger?.[id];
        const target = job.snapshot.targets.find((item) => item.targetId === id);
        if (job.snapshot.kind === 'notebook' && !target?.source.trim()) return false;
        return !previous || previous.sourceHash !== target?.sourceHash ||
          JSON.stringify(previous.kernelIdentity) !== JSON.stringify(job.snapshot.kernelIdentity);
      });
      try {
        if (needed.length) await run({ targetIds: needed });
        await save();
        await submit();
        return;
      } catch (error) {
        checkStopped();
        if (job.recovery?.required) throw error;
        const diagnostic = job.submission?.status === 'rejected'
          ? { stage: 'submission', feedback: job.submission.feedback || job.submission.reason }
          : job.execution?.status === 'failed' && job.execution.results?.length
            ? { stage: 'execution', results: job.execution.results } : null;
        if (!diagnostic || job.usage.logicalGenerations >= 3) throw error;
        const next = JSON.stringify(diagnostic).slice(0, 10000);
        if (failures.has(next)) throw new Error('The same failure repeated. Automatic repairs stopped to conserve API quota.');
        failures.add(next);
        feedback = next;
        job.submission = null;
      }
    }
  }

  return {
    get busy() { return busy; },
    async getState() { await load(); return view(); },
    async stop() {
      controller?.abort();
      if (!job) return view();
      if (['applying', 'running', 'saving', 'submitting', 'restoring'].includes(job.phase)) {
        job.interruptedPhase = job.phase;
        job.recovery = { required: true, message: 'Reconcile the page after this interrupted operation.' };
      }
      job.phase = busy ? 'stopping' : 'stopped';
      job.reason = 'Future steps stopped. Any already dispatched notebook execution may still be running.';
      await persist();
      if (job.pendingRequestId) {
        try { await api.cancel(job.id, activeKey); } catch { /* Recovery will reconcile a lost response. */ }
      }
      return view();
    },
    async action(name, payload = {}) {
      if (name === 'stop') return this.stop();
      if (busy || isOtherBusy()) throw new Error('Another quiz or assignment action is still active.');
      busy = true;
      controller = new AbortController();
      activeKey = payload.apiKey;
      emit();
      try {
        await load();
        const handlers = { inspect, generate, apply, run, save, submit, restore, recover, automate, solve };
        if (!handlers[name]) throw new Error('Unknown assignment action.');
        await handlers[name](payload);
      } catch (error) {
        if (job) {
          job.error = error.message;
          if (INTERRUPTED.has(job.phase) && ['applying', 'running', 'saving', 'submitting', 'restoring'].includes(job.phase)) {
            job.interruptedPhase = job.phase;
            job.recovery = { required: true, message: 'Verify the page after this interrupted operation.' };
          }
          const unresolved = Boolean(job.pendingRequestId || job.pendingSaveId || job.pendingSubmissionId || job.recovery?.required);
          const unavailable = error.code === 'UNSUPPORTED_WORKSPACE' ||
            ['generate', 'apply', 'run', 'save'].some((cap) => job.snapshot?.capabilities?.[cap] === false);
          const kind = [401, 403].includes(error.status) ? 'auth' : error.status === 429 ? 'quota' : unresolved ? 'unknown'
            : job.submission?.status === 'rejected' ? 'rejected' : job.execution?.status === 'failed' ? 'runtime'
              : unavailable ? 'unsupported' : 'unknown';
          job.failure = { kind, known: kind !== 'unknown' && !unresolved, status: error.status || null, message: error.message };
          job.phase = controller.signal.aborted ? 'stopped' : 'needs_attention';
          await persist();
        }
        throw error;
      } finally {
        busy = false;
        activeKey = undefined;
        controller = null;
        emit();
      }
      return view();
    },
  };
}
