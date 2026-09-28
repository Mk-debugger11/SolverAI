import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getAssignmentPageScope } from './assignmentPageScope';
import './AssignmentDashboard.css';

const ACTIVE_PHASES = new Set(['inspecting', 'observing', 'planning', 'generating', 'applying', 'running', 'testing', 'saving', 'submitting', 'verifying', 'restoring', 'recovering', 'stopping']);
const ACTIVE_BATCH_PHASES = new Set(['scanning', 'paging', 'opening', 'solving', 'verifying', 'closing', 'stopping']);
const PHASE_LABELS = {
  inspected: 'Workspace inspected', generating: 'Generating changes', draft: 'Draft ready',
  applying: 'Applying changes', applied: 'Changes applied', running: 'Running selected cells',
  completed: 'Execution completed', saving: 'Saving notebook', saved: 'Notebook saved',
  restoring: 'Restoring original source', restored: 'Original source restored', stopping: 'Stopping',
  stopped: 'Stopped', needs_attention: 'Needs attention', needs_reconciliation: 'Recovery needed',
  inspecting: 'Inspecting workspace', observing: 'Inspecting workspace', recovering: 'Checking recovery',
  planning: 'Planning assignment steps', testing: 'Running checks', submitting: 'Submitting assignment',
  verifying: 'Checking portal result', submitted: 'Submission acknowledged', accepted: 'Accepted by portal',
  ready: 'Ready for submission', failed: 'Assignment failed', skipped: 'Assignment skipped', unknown: 'Outcome unknown',
};
const BATCH_PHASE_LABELS = {
  scanning: 'Finding unfinished assignments', paging: 'Opening next assignment page', opening: 'Opening assignment', solving: 'Working on assignment',
  verifying: 'Checking portal result', closing: 'Closing assignment tab', completed: 'Batch finished',
  stopping: 'Stopping batch', stopped: 'Batch stopped', needs_attention: 'Batch needs attention',
  needs_reconciliation: 'Batch recovery needed',
};
const RESULT_LABELS = { accepted: 'Accepted', submitted: 'Submitted', rejected: 'Rejected', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown', completed: 'Completed', saved: 'Saved', stopped: 'Stopped' };

function readable(value) {
  if (typeof value === 'string') return value;
  return value?.message || value?.reason || value?.text || '';
}

function asList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function Icon({ name }) {
  const paths = {
    inspect: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5M7 10h6M10 7v6" /></>,
    notebook: <><path d="M5 3h14v18H5zM9 3v18M3 7h4M3 12h4M3 17h4M12 8h4M12 12h4" /></>,
    code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" /></>,
    arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  };
  return <svg className="assignment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.code}</svg>;
}

function SourceView({ source, label }) {
  const text = typeof source === 'string' ? source : '';
  return <div className="assignment-source">
    <div className="assignment-source-label"><span>{label}</span><span>{text ? text.split('\n').length : 0} lines</span></div>
    <pre tabIndex={0} aria-label={label}><code>{text || <span className="assignment-empty-source">Empty source</span>}</code></pre>
  </div>;
}

function BatchProgress({ batch, active, stopping, canRecover, onStop, onRecover }) {
  const items = asList(batch.items);
  const results = asList(batch.results);
  const resultKeys = new Set(results.map((result) => result.key));
  const rows = [...results, ...asList(batch.skipped).filter((item) => !resultKeys.has(item.key)).map((item) => ({ ...item, status: 'skipped' }))];
  const current = items.find((item) => item.key === batch.activeItemKey);
  const counts = rows.reduce((total, row) => ({ ...total, [row.status || 'unknown']: (total[row.status || 'unknown'] || 0) + 1 }), {});
  const recordedKeys = new Set(rows.map((row, index) => row.key || `result-${index}`));
  const scopeKeys = new Set([...recordedKeys, ...items.filter((item) => item.status === 'unfinished' || item.key === batch.activeItemKey).map((item) => item.key)]);
  const finished = recordedKeys.size;
  const total = scopeKeys.size;
  const emptyProgress = batch.error || batch.recovery?.required || batch.phase === 'needs_reconciliation'
    ? 'Assignment count could not be confirmed. Review the batch status below.'
    : batch.phase === 'completed' ? 'No unfinished assignments found in the scanned catalog.'
      : ['scanning', 'paging'].includes(batch.phase) ? 'Scanning the assignment catalog; counts are not available yet.'
        : 'No assignment outcomes have been recorded yet.';
  return <section className="assignment-batch" aria-label="Assignment batch progress">
    <div className="assignment-batch-heading"><div><span className="assignment-eyebrow">ASSIGNMENT QUEUE</span><h3>{BATCH_PHASE_LABELS[batch.phase] || 'Assignment batch'}</h3></div>
      {active && <button className="assignment-stop" disabled={stopping} onClick={onStop}><Icon name="stop" />Stop batch</button>}
    </div>
    <div className="assignment-batch-count"><span>{total ? `${finished} of ${total} assignments recorded` : emptyProgress}</span>{current && <strong>{current.title || 'Current assignment'}</strong>}</div>
    {total > 0 && <progress aria-label="Assignments with recorded outcomes" max={total} value={finished} />}
    {(readable(batch.error) || readable(batch.reason)) && <p className="assignment-note">{readable(batch.error) || readable(batch.reason)}</p>}
    {(batch.recovery?.required || batch.phase === 'needs_reconciliation') && <div className="assignment-notice is-warning"><p>{readable(batch.recovery) || 'Inspect the affected workspace and its portal result before starting another batch. An uncertain submission will not be repeated automatically.'}</p><button className="assignment-button" disabled={!canRecover} onClick={onRecover}>Reconcile batch</button><p>Reads the catalog and retained result. It does not repeat submission.</p></div>}
    {rows.length > 0 && <>
      <div className="assignment-result-counts">{Object.entries(counts).map(([status, count]) => <span key={status} className={`assignment-outcome is-${Object.hasOwn(RESULT_LABELS, status) ? status : 'unknown'}`}>{RESULT_LABELS[status] || 'Unknown'} <b>{count}</b></span>)}</div>
      <ol className="assignment-batch-results">{rows.map((result, index) => <li key={`${result.key || index}:${index}`}><div><strong>{result.title || `Assignment ${index + 1}`}</strong><span className={`assignment-outcome is-${Object.hasOwn(RESULT_LABELS, result.status) ? result.status : 'unknown'}`}>{RESULT_LABELS[result.status] || 'Unknown'}</span></div>{readable(result) && <p>{readable(result)}</p>}</li>)}</ol>
      <p className="assignment-note">Submitted means the portal acknowledged submission. Accepted is shown only when the portal reports acceptance.</p>
    </>}
  </section>;
}

/**
 * Assignment UI only: all inspection, writes, execution and durable state belong
 * to the background runner. onAction(action, payload) may return a promise.
 */
export default function AssignmentDashboard({ job = null, batch = null, activeTabUrl, busy = false, operationBusy = false, onAction, onBatchAction, settings = {}, onSettingsChange }) {
  const pageScope = getAssignmentPageScope(activeTabUrl);
  const onCatalog = pageScope.kind === 'catalog';
  const onWorkspace = pageScope.kind === 'workspace';
  const snapshot = job?.snapshot;
  const targets = Array.isArray(snapshot?.targets) ? snapshot.targets : [];
  const capabilities = snapshot?.capabilities || {};
  const isNotebook = snapshot?.kind === 'notebook' || snapshot?.kind === 'jupyter';
  const isCoding = snapshot?.kind === 'code' || snapshot?.kind === 'coding';
  const edits = Array.isArray(job?.edits) ? job.edits : [];
  const [targetIds, setTargetIds] = useState([]);
  const [executeIds, setExecuteIds] = useState([]);
  const [sourceTargetId, setSourceTargetId] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [previewSide, setPreviewSide] = useState('proposed');
  const [pendingAction, setPendingAction] = useState('');
  const [actionError, setActionError] = useState('');
  const requestVersion = useRef(0);
  const activeRequest = useRef(false);
  const targetKey = targets.map((target) => target.targetId).join('\u0000');
  const editKey = edits.map((edit) => edit.targetId).join('\u0000');
  const retainedTargetKey = (job?.selectedTargetIds || []).join('\u0000');
  const retainedExecuteKey = (job?.executeIds || []).join('\u0000');
  const phase = job?.phase || '';
  const active = ACTIVE_PHASES.has(phase);
  const batchActive = ACTIVE_BATCH_PHASES.has(batch?.phase);
  const singleActive = !batchActive && (active || operationBusy);
  const locked = busy || operationBusy || active || batchActive || Boolean(pendingAction);
  const recoveryRequired = Boolean(job?.recovery?.required || phase === 'needs_reconciliation');
  const batchRecoveryRequired = Boolean(batch?.recovery?.required || batch?.phase === 'needs_reconciliation');
  const warnings = [...asList(snapshot?.warnings), ...asList(job?.warning)].map(readable).filter(Boolean);
  const reasons = asList(snapshot?.reasons).map(readable).filter(Boolean);
  const attention = recoveryRequired || phase === 'needs_attention' || warnings.length > 0;
  const usage = job?.usage || {};
  const execution = job?.execution;
  const executionResults = Array.isArray(execution?.results) ? execution.results : [];
  const canRepair = execution?.status === 'failed' && executionResults.length > 0;
  const firstGeneration = !usage.logicalGenerations;
  const generationBudgetAvailable = (job?.budget?.maxGenerations == null || (usage.logicalGenerations ?? 0) < job.budget.maxGenerations) &&
    (job?.budget?.maxAttempts == null || (usage.providerAttempts ?? 0) < job.budget.maxAttempts);

  useEffect(() => {
    // New notebooks start unselected. A retained job may restore its edit list.
    setTargetIds(Array.isArray(job?.selectedTargetIds) ? job.selectedTargetIds : []);
    setExecuteIds([]);
    setSourceTargetId(job?.context?.sourceTargetId || job?.snapshot?.targets?.[0]?.targetId || '');
    setActionError('');
  }, [job?.id]);

  useEffect(() => {
    if (job?.selectedTargetIds?.length) setTargetIds(job.selectedTargetIds);
    if (job?.automatic && Array.isArray(job.executeIds)) setExecuteIds(job.executeIds);
  }, [job?.id, retainedTargetKey, retainedExecuteKey, job?.automatic]);

  useEffect(() => {
    const available = new Set(targets.map((target) => target.targetId));
    setTargetIds((current) => current.filter((id) => available.has(id)));
    setExecuteIds((current) => current.filter((id) => available.has(id)));
  }, [targetKey]);

  useEffect(() => {
    setPreviewId((current) => edits.some((edit) => edit.targetId === current) ? current : edits[0]?.targetId || '');
  }, [editKey]);

  const selectedTargets = targets.filter((target) => targetIds.includes(target.targetId) && target.editable === true);
  const selectedExecutions = targets.filter((target) => executeIds.includes(target.targetId) && target.cellType === 'code');
  const preview = edits.find((edit) => edit.targetId === previewId) || edits[0];
  const originalTargets = job?.draftSnapshot?.targets || snapshot?.targets || [];
  const previewTarget = preview && originalTargets.find((target) => target.targetId === preview.targetId);
  const capabilityNotes = useMemo(() => {
    const notes = [];
    if (isCoding && capabilities.apply !== true) notes.push('Coding preview only. Applying code is unavailable until the portal’s paste warning and supported editing path are verified.');
    for (const reason of reasons) if (!notes.includes(reason)) notes.push(reason);
    return notes;
  }, [isCoding, capabilities.apply, JSON.stringify(reasons)]);

  const canGenerate = Boolean(snapshot && capabilities.generate === true && selectedTargets.length && !locked &&
    !recoveryRequired && !warnings.length && (!attention || canRepair) && (firstGeneration || canRepair) && generationBudgetAvailable);
  const canApply = Boolean(edits.length && phase === 'draft' && capabilities.apply === true && !locked && !attention);
  const canRun = Boolean(capabilities.run === true && (isNotebook ? selectedExecutions.length : isCoding && targets.some((target) => target.editable)) && !locked && !attention);
  const canSave = Boolean((isNotebook || isCoding) && capabilities.save === true && !locked && !attention);
  const canRestore = Boolean(job?.canRestore && !locked && !recoveryRequired && !warnings.length);
  const canAutomate = Boolean(isNotebook && capabilities.generate === true && capabilities.apply === true &&
    capabilities.run === true && capabilities.save === true && selectedTargets.length && selectedExecutions.length && !locked && !attention && firstGeneration && generationBudgetAvailable);

  async function act(action, payload = {}, batchAction = false) {
    const handler = batchAction ? onBatchAction : onAction;
    if (typeof handler !== 'function' || (activeRequest.current && action !== 'stop')) return;
    const version = ++requestVersion.current;
    activeRequest.current = true;
    setPendingAction(batchAction ? `batch:${action}` : action);
    setActionError('');
    try {
      await handler(action, payload);
    } catch (error) {
      setActionError(error?.message || 'The action could not be completed.');
    } finally {
      if (requestVersion.current === version) {
        activeRequest.current = false;
        setPendingAction('');
      }
    }
  }

  function toggleId(update, id) {
    update((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  const generationPayload = () => ({
    ...settings,
    targetIds: selectedTargets.map((target) => target.targetId),
    ...(!firstGeneration && canRepair ? { feedback: JSON.stringify(executionResults) } : {}),
  });
  const runIds = (isNotebook ? selectedExecutions : targets.filter((target) => target.editable)).map((target) => target.targetId);
  const runtime = typeof snapshot?.runtime === 'string' ? snapshot.runtime : snapshot?.runtime?.label || snapshot?.runtime?.language;
  const sourceCandidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  const sourceCandidate = sourceCandidates.find((candidate) => candidate.targetId === sourceTargetId);

  return <section className="assignment-workbench" aria-label="Assignment workspace">
    <header className="assignment-header">
      <div><div className="assignment-eyebrow">SOLVERAI / WORKSPACE</div><h2>Assignments</h2><p>From instructions to portal results.</p></div>
      {onWorkspace && <button className="assignment-button assignment-inspect" disabled={locked} onClick={() => act('inspect')}>
        <Icon name="inspect" /><span>{snapshot ? 'Reinspect' : 'Inspect tab'}</span>
      </button>}
    </header>

    <section className="assignment-launch" aria-label="Solve assignments">
      <div className="assignment-launch-heading"><span className="assignment-step">{onCatalog ? 'COURSE' : 'AUTO'}</span><h3>{pageScope.label}</h3></div>
      <p className="assignment-scope-message">{pageScope.message}</p>
      {!onCatalog && <>
        <button className="assignment-button assignment-button-primary assignment-wide assignment-solve" disabled={!onWorkspace || locked || recoveryRequired || typeof onAction !== 'function'} onClick={() => act('solve', { ...settings })}>Solve this assignment<Icon name="arrow" /></button>
        {onWorkspace && <p className="assignment-note">Chooses supported sources and notebook cells, generates changes, runs checks, and submits when the portal supports it.</p>}
      </>}
      <button className={`assignment-button assignment-wide assignment-solve-batch ${onCatalog ? 'assignment-button-primary is-catalog-primary' : ''}`} disabled={!onCatalog || locked || recoveryRequired || batchRecoveryRequired || typeof onBatchAction !== 'function'} onClick={() => act('start', { ...settings }, true)}>Solve unfinished assignments<Icon name="arrow" /></button>
      <p className="assignment-note">{onCatalog ? 'Works through unfinished assignments within request and repair limits; unsupported work is reported.' : 'Open the course All Assignments catalog to start a batch.'}</p>
      <details className="assignment-settings"><summary>Shared assignment settings <span>{settings.model || 'Server default'}</span></summary>
        <div className="assignment-settings-fields">
          <label>Model<input type="text" value={settings.model || ''} placeholder="Use server default" disabled={locked} onChange={(event) => onSettingsChange?.({ ...settings, model: event.target.value })} spellCheck={false} /></label>
          <label>Output token limit<input type="number" min="1" step="1" value={settings.maxTokens ?? ''} placeholder="4096" disabled={locked} onChange={(event) => onSettingsChange?.({ ...settings, maxTokens: event.target.value === '' ? '' : Number(event.target.value) })} /></label>
        </div>
        <p className="assignment-note">Single, batch and manual generation share these settings and the API key in the main settings panel.</p>
      </details>
    </section>

    {batch && <BatchProgress batch={batch} active={batchActive} stopping={batch.phase === 'stopping' || pendingAction === 'batch:stop'} canRecover={!locked && typeof onBatchAction === 'function'} onStop={() => act('stop', {}, true)} onRecover={() => act('recover', {}, true)} />}

    {job && <div className={`assignment-status ${attention || job.error ? 'has-attention' : ''}`} role="status" aria-live="polite">
      <span className={`assignment-status-dot ${active || operationBusy ? 'is-active' : ''}`} />
      <div><strong>{PHASE_LABELS[phase] || (phase ? phase.replaceAll('_', ' ') : 'Ready')}</strong>
        {(readable(job.reason) || readable(job.error)) && <p>{readable(job.error) || readable(job.reason)}</p>}
      </div>
      {singleActive && <button className="assignment-stop" onClick={() => act('stop')} disabled={phase === 'stopping' || pendingAction === 'stop'}><Icon name="stop" />Stop</button>}
    </div>}

    {!job && singleActive && <div className="assignment-status" role="status"><span className="assignment-status-dot is-active" /><div><strong>Preparing assignment</strong></div><button className="assignment-stop" disabled={pendingAction === 'stop'} onClick={() => act('stop')}><Icon name="stop" />Stop</button></div>}
    {job?.submission && <section className="assignment-submission" aria-label="Portal submission result"><div className="assignment-section-heading"><h3>Portal result</h3><span className={`assignment-outcome is-${Object.hasOwn(RESULT_LABELS, job.submission.status) ? job.submission.status : 'unknown'}`}>{RESULT_LABELS[job.submission.status] || 'Unknown'}</span></div>{readable(job.submission) && <p className="assignment-note">{readable(job.submission)}</p>}{job.submission.feedback && <details><summary>Portal feedback</summary><pre>{typeof job.submission.feedback === 'string' ? job.submission.feedback : JSON.stringify(job.submission.feedback, null, 2)}</pre></details>}</section>}

    {busy && !singleActive && !batchActive && !pendingAction && <p className="assignment-note">Another operation is running. Assignment actions will be available when it finishes.</p>}
    {actionError && <div className="assignment-notice is-warning" role="alert">{actionError}</div>}
    {recoveryRequired && <div className="assignment-notice is-warning">
      <strong>Check the workspace before continuing</strong>
      <p>{readable(job.recovery) || 'A previous operation was interrupted. Reconcile the saved draft with the page before taking another action.'}</p>
      <button className="assignment-button" disabled={locked} onClick={() => act('recover')}>Check recovery</button>
    </div>}
    {warnings.length > 0 && <div className="assignment-notice is-warning" role="alert"><strong>Portal needs attention</strong>{warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}

    <details className="assignment-manual"><summary>Manual controls<span>Inspect sources, review edits and recover changes</span></summary>
    {!snapshot ? <div className="assignment-empty">
      <div className="assignment-empty-mark"><Icon name="code" /></div>
      <h3>{onCatalog ? 'Inspect an individual assignment' : 'Start with an assignment workspace'}</h3>
      <p>{onCatalog ? 'Open a coding assignment or notebook from the catalog, then use Inspect tab to see its instructions and sources.' : 'Open and inspect a coding workspace or a Jupyter notebook to see its instructions, sources and available actions.'}</p>
      <div className="assignment-empty-types"><span>PYTHON / MIPS / VERILOG</span><span>JUPYTER CELLS</span></div>
    </div> : <>
      <div className="assignment-context">
        <div className="assignment-workspace-label"><Icon name={isNotebook ? 'notebook' : 'code'} /><span>{isNotebook ? 'Jupyter notebook' : isCoding ? 'Coding workspace' : 'Workspace'}</span>{runtime && <span className="assignment-runtime">{runtime}</span>}</div>
        <h3>{snapshot.title || 'Current assignment'}</h3>
        {snapshot.problemId && <div className="assignment-context-id">{snapshot.problemId}</div>}
        <details className="assignment-statement"><summary>Assignment instructions</summary><pre>{snapshot.statement || 'No instructions were captured. Reinspect the assignment before generating code.'}</pre></details>
      </div>

      {capabilityNotes.length > 0 && <div className="assignment-notice"><strong>Available in this workspace</strong>{capabilityNotes.map((note, index) => <p key={index}>{note}</p>)}</div>}

      {isCoding && sourceCandidates.length > 0 && <section className="assignment-section assignment-source-picker">
        <h3>Identify the source editor</h3><p className="assignment-note">Review the model contents, then select the program source. Input, testbench and expected output may also appear here.</p>
        <label className="assignment-select-label">Editor model<select value={sourceTargetId} disabled={locked || recoveryRequired} onChange={(event) => setSourceTargetId(event.target.value)}>
          <option value="">Choose a model…</option>{sourceCandidates.map((candidate) => <option key={candidate.targetId} value={candidate.targetId}>{candidate.roleHint || candidate.languageId || 'Model'} · {candidate.targetId}{candidate.editable !== true ? ' (read-only or unverified)' : ''}</option>)}
        </select></label>
        {sourceCandidate && <SourceView source={sourceCandidate.source} label="Selected model · current source" />}
        <button className="assignment-button assignment-wide" disabled={!onWorkspace || locked || recoveryRequired || sourceCandidate?.editable !== true} onClick={() => act('inspect', { sourceTargetId })}>Use selected source</button>
      </section>}

      <section className="assignment-section" aria-labelledby="assignment-targets-title">
        <div className="assignment-section-heading"><span className="assignment-step">01</span><h3 id="assignment-targets-title">Choose targets</h3><span className="assignment-section-count">{targets.length} {isNotebook ? 'cells' : 'sources'}</span></div>
        <p className="assignment-note">{isNotebook ? 'Select cells to edit and cells to run separately. Run order follows the notebook.' : 'Choose the source editor. Input and expected-output editors are separate targets.'}</p>
        {targets.length ? <div className="assignment-targets">
          <div className={`assignment-target-columns ${isNotebook ? 'is-notebook' : ''}`}><span>Source</span><span>Edit</span>{isNotebook && <span>Run</span>}</div>
          {targets.map((target, index) => {
            const id = target.targetId;
            const editable = target.editable === true;
            const executable = isNotebook && target.cellType === 'code';
            const label = target.label || `${isNotebook ? 'Cell' : 'Source'} ${index + 1}`;
            return <div className="assignment-target" key={id}>
              <div className={`assignment-target-row ${isNotebook ? 'is-notebook' : ''}`}>
                <div className="assignment-target-name"><strong>{label}</strong><span>{target.cellType || (isCoding ? 'source' : '')}{!editable ? ' · protected' : ''}</span></div>
                <input type="checkbox" aria-label={`Edit ${label}`} checked={editable && targetIds.includes(id)} disabled={locked || !editable || attention || !firstGeneration} onChange={() => toggleId(setTargetIds, id)} />
                {isNotebook && <input type="checkbox" aria-label={`Run ${label}`} checked={executable && executeIds.includes(id)} disabled={locked || !executable || recoveryRequired || warnings.length > 0} onChange={() => toggleId(setExecuteIds, id)} />}
              </div>
              <details className="assignment-target-source"><summary>View source</summary><SourceView source={target.source} label={`${label} · current source`} /></details>
            </div>;
          })}
        </div> : <p className="assignment-note">No supported sources were found. Reinspect after opening an editable assignment.</p>}
      </section>

      <section className="assignment-section" aria-labelledby="assignment-generate-title">
        <div className="assignment-section-heading"><span className="assignment-step">02</span><h3 id="assignment-generate-title">Generate changes</h3><span className="assignment-section-count">{selectedTargets.length} selected</span></div>
        <button className="assignment-button assignment-button-primary assignment-wide" disabled={!canGenerate} onClick={() => act('generate', generationPayload())}>{!firstGeneration && canRepair ? 'Generate repair from results' : 'Generate selected edits'}<Icon name="arrow" /></button>
        {!selectedTargets.length && <p className="assignment-note">Choose at least one editable target above.</p>}
        {capabilities.generate !== true && <p className="assignment-note">Generation is unavailable for this workspace. Inspect its instructions and runtime first.</p>}
        {!firstGeneration && !canRepair && <p className="assignment-note">A candidate has already been generated. Apply this draft, or inspect again to start a new task. Repairs need fresh execution failures.</p>}
        {!generationBudgetAvailable && <p className="assignment-note">This job's generation or request budget has been reached.</p>}
      </section>

      <section className="assignment-section" aria-labelledby="assignment-preview-title">
        <div className="assignment-section-heading"><span className="assignment-step">03</span><h3 id="assignment-preview-title">Review the draft</h3><span className="assignment-section-count">{edits.length} changes</span></div>
        {preview ? <>
          <label className="assignment-select-label">Target<select value={preview.targetId} onChange={(event) => setPreviewId(event.target.value)}>{edits.map((edit) => <option key={edit.targetId} value={edit.targetId}>{originalTargets.find((target) => target.targetId === edit.targetId)?.label || edit.targetId}</option>)}</select></label>
          <div className="assignment-preview-tabs" aria-label="Source comparison"><button aria-pressed={previewSide === 'original'} onClick={() => setPreviewSide('original')}>Original</button><button aria-pressed={previewSide === 'proposed'} onClick={() => setPreviewSide('proposed')}>Proposed</button></div>
          <SourceView source={previewSide === 'original' ? previewTarget?.source : preview.content} label={previewSide === 'original' ? 'Source at generation' : 'Proposed replacement'} />
          <p className="assignment-note">Applies the {edits.length === 1 ? 'replacement' : `${edits.length} replacements`} shown in this draft. Changed source is checked again before writing.</p>
          <button className="assignment-button assignment-wide" disabled={!canApply} onClick={() => act('apply')}>Apply draft</button>
          {phase !== 'draft' && job.appliedTargetIds?.length > 0 && <p className="assignment-note">This draft has already been applied. Review execution results or restore the original source below.</p>}
        </> : <div className="assignment-preview-empty">Generated code appears here before it is applied.</div>}
        {capabilities.apply !== true && !isCoding && <p className="assignment-note">Applying changes is unavailable for this workspace.</p>}
      </section>

      {(isNotebook || isCoding) && <section className="assignment-section" aria-labelledby="assignment-execute-title">
        <div className="assignment-section-heading"><span className="assignment-step">04</span><h3 id="assignment-execute-title">{isNotebook ? 'Run and save' : 'Run and verify'}</h3>{isNotebook && <span className="assignment-section-count">{selectedExecutions.length} cells to run</span>}</div>
        <div className="assignment-button-row"><button className="assignment-button" disabled={!canRun} onClick={() => act('run', { targetIds: runIds })}>{isNotebook ? 'Run selected cells' : 'Run code checks'}</button><button className="assignment-button" disabled={!canSave} onClick={() => act('save')}>{isNotebook ? 'Save notebook' : 'Verify current source'}</button></div>
        {capabilities.run !== true && <p className="assignment-note">{isNotebook ? "Cell execution is unavailable until the notebook's runtime is identified." : 'Code execution is unavailable for this workspace.'}</p>}
        {capabilities.save !== true && <p className="assignment-note">{isNotebook ? 'Saving is unavailable for this notebook.' : 'Source verification is unavailable for this workspace.'}</p>}
        {isNotebook && <div className="assignment-automate"><button className="assignment-button assignment-button-primary assignment-wide" disabled={!canAutomate} onClick={() => act('automate', { ...generationPayload(), executeIds: runIds })}>Automate selected steps<Icon name="arrow" /></button>
          <p>Generates selected edits, applies them, runs selected cells in notebook order, then saves.</p><p>Select setup and training cells deliberately. Dependencies are not inferred, and submission stays manual.</p>
          {!firstGeneration && <p>Use the separate Apply, Run and Save controls for the current draft.</p>}
        </div>}
      </section>}

      {execution && <section className="assignment-section assignment-results" aria-labelledby="assignment-results-title"><div className="assignment-section-heading"><h3 id="assignment-results-title">Execution results</h3><span>{String(execution.status || 'Outcome not reported').replaceAll('_', ' ')}</span></div>
        {readable(execution) && <p className="assignment-note">{readable(execution)}</p>}
        {executionResults.map((result, index) => <details key={`${result.targetId || index}:${index}`}><summary>{targets.find((target) => target.targetId === result.targetId)?.label || result.targetId || `Result ${index + 1}`}<span>{String(result.status || 'unknown').replaceAll('_', ' ')}</span></summary>{result.output !== undefined && <pre>{typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)}</pre>}{result.error && <pre className="assignment-result-error">{readable(result.error)}</pre>}</details>)}
      </section>}
    </>}
    </details>

    {job && <footer className="assignment-footer">
      <dl className="assignment-usage"><div><dt>API attempts</dt><dd>{usage.providerAttempts ?? '—'}<small> / {job.budget?.maxAttempts ?? '—'}</small></dd></div><div><dt>Generations</dt><dd>{usage.logicalGenerations ?? '—'}<small> / {job.budget?.maxGenerations ?? '—'}</small></dd></div><div><dt>Tokens recorded</dt><dd>{Number.isFinite(usage.totalTokens) ? usage.totalTokens.toLocaleString() : '—'}</dd></div></dl>
      {usage.unknownUsage && <p className="assignment-note">Some requests have unreported usage; the token count is incomplete.</p>}
      <div className="assignment-footer-actions"><span>Portal results determine the outcome.</span><button className="assignment-text-button" disabled={!canRestore} onClick={() => act('restore')}>Restore original</button></div>
    </footer>}
  </section>;
}
