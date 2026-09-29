import { assignmentCatalog } from './assignmentCatalog.js';

export const ASSIGNMENT_BATCH_STORAGE_KEY = 'assignment_batch_v1';
const RETENTION_MS = 24 * 60 * 60 * 1000;
const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const terminal = new Set(['completed', 'stopped']);

/** Owns one sequential catalog pass. Credentials exist only in the active call. */
export function createBatchAssignmentRunner({ storage, catalog = assignmentCatalog, singleRunner,
  notify = () => {}, isOtherBusy = () => false, now = Date.now, makeId = () => crypto.randomUUID(),
  getTab = (tabId) => chrome.tabs.get(tabId) }) {
  let batch = null;
  let loaded = false;
  let loading;
  let busy = false;
  let controller;
  let ownsSingleAction = false;
  let writes = Promise.resolve();
  const view = () => ({ batch: copy(batch), busy });
  const emit = () => notify(view());

  async function persist() {
    if (!storage?.set) throw new Error('Durable storage is required for assignment batches.');
    batch.updatedAt = now();
    batch.expiresAt = now() + RETENTION_MS;
    const value = copy(batch);
    if (new TextEncoder().encode(JSON.stringify(value)).length > 512 * 1024) throw new Error('The catalog exceeds the batch recovery limit.');
    writes = writes.catch(() => {}).then(() => storage.set({ [ASSIGNMENT_BATCH_STORAGE_KEY]: value }));
    await writes;
    emit();
  }
  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      batch = (await storage?.get?.(ASSIGNMENT_BATCH_STORAGE_KEY))?.[ASSIGNMENT_BATCH_STORAGE_KEY] || null;
      if (batch && (batch.version !== 1 || batch.expiresAt <= now() && !batch.pendingEffect && !batch.recovery?.required)) {
        await storage.remove(ASSIGNMENT_BATCH_STORAGE_KEY);
        batch = null;
      }
      if (batch && (!terminal.has(batch.phase) || batch.pendingEffect)) {
        batch.interruptedPhase = batch.phase;
        batch.phase = 'needs_reconciliation';
        batch.recovery = { required: true, message: 'Recheck the catalog and the current assignment before continuing. No uncertain action will be replayed.' };
      }
      loaded = true;
    })();
    try { await loading; } finally { loading = null; }
  }
  function checkStopped() {
    if (controller?.signal.aborted) throw new Error('Assignment batch stopped.');
  }
  async function phase(value, extra = {}) {
    Object.assign(batch, extra, { phase: value });
    await persist();
    checkStopped();
  }
  function validateCatalog(scan) {
    if (!scan?.isCatalog || scan.complete === false) throw new Error(scan?.reason || 'Open the Newton course All Assignments catalog.');
    if (!Array.isArray(scan.items) || scan.items.length > 500) throw new Error('The catalog could not be captured completely within this batch scope.');
    if (batch.catalogUrl && scan.currentUrl !== batch.catalogUrl && !(batch.pendingEffect === 'next_page' &&
      new URL(scan.currentUrl).pathname === new URL(batch.catalogUrl).pathname)) throw new Error('The catalog page changed. Return to the original course before continuing.');
    const keys = scan.items.map((item) => item.key);
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length || scan.items.some((item) => item.status === 'ambiguous' || item.ambiguous)) {
      throw new Error('Some assignment cards have ambiguous identity or completion status. Review the catalog before continuing.');
    }
    return scan;
  }
  async function scanCatalog(refresh = false) {
    const snapshot = await catalog.scan(batch.catalogTabId, { refresh, expand: true, signal: controller.signal });
    if (!batch.catalogUrl && snapshot?.isCatalog && snapshot.currentUrl) batch.catalogUrl = snapshot.currentUrl;
    const scan = validateCatalog(snapshot);
    checkStopped();
    batch.catalogUrl = scan.currentUrl;
    batch.scope = scan.scope || 'Loaded assignment cards and observed pagination';
    const collected = new Map(batch.items.map((item) => [item.key, item]));
    scan.items.forEach((item) => collected.set(item.key, copy(item)));
    if (collected.size > 500) throw new Error('This batch reached its 500-assignment limit.');
    batch.items = [...collected.values()];
    return scan;
  }
  function outcome(result) {
    const job = result?.job || result;
    const submission = job?.submission;
    if (job?.recovery?.required || !submission?.success) return null;
    if (submission.status === 'accepted' || submission.status === 'submitted') return submission.status;
    return null;
  }
  function recordResult(value) {
    const index = batch.results.findIndex((item) => item.key === value.key);
    if (index === -1) batch.results.push(value);
    else batch.results[index] = value;
  }
  function recordInterruption(error) {
    if (!batch.activeItemKey) return;
    const previous = batch.results.find((item) => item.key === batch.activeItemKey);
    if (previous && ['accepted', 'submitted', 'skipped', 'failed'].includes(previous.status)) return;
    recordResult({ key: batch.activeItemKey, title: batch.items.find((item) => item.key === batch.activeItemKey)?.title || '',
      status: batch.pendingEffect ? 'unknown' : 'failed', reason: error.message });
  }
  async function closeOwned() {
    for (const owned of [...batch.ownedTabs]) {
      checkStopped();
      await phase('closing', { pendingEffect: 'close_tab', closingTabId: owned.tabId });
      const result = await catalog.closeOwnedTab(owned, batch.id);
      if (result?.success === false) throw new Error(result.reason || 'An owned tab could not be safely closed.');
      batch.ownedTabs = batch.ownedTabs.filter((item) => item.tabId !== owned.tabId);
      batch.closingTabId = null;
      batch.pendingEffect = null;
      await persist();
    }
  }
  async function reconcile() {
    await phase('scanning');
    // Reloading a same-URL paginated SPA would discard its current page. Read
    // the live page first; submission acknowledgement is independently checked.
    const scan = await scanCatalog(false);
    if (batch.activeItemKey && ['solve', 'verify'].includes(batch.pendingEffect)) {
      const current = scan.items.find((item) => item.key === batch.activeItemKey);
      let recorded = batch.results.find((item) => item.key === batch.activeItemKey && ['accepted', 'submitted'].includes(item.status));
      if (!recorded && batch.workspaceTabId && singleRunner.getState) {
        const state = await singleRunner.getState();
        const acknowledged = state?.job?.context?.tabId === batch.workspaceTabId && outcome(state);
        if (acknowledged) {
          recorded = { key: batch.activeItemKey, title: current?.title || '', status: acknowledged,
            singleJobId: state.job.id, reason: 'Recovered the matching assignment submission acknowledgement.' };
          recordResult(recorded);
        }
      }
      if (current?.status !== 'completed' && !recorded) {
        throw new Error('The interrupted assignment has no verified completion. Reconcile its saved single-assignment job; this batch will not replay an uncertain solve or submission.');
      }
      if (!recorded) recordResult({ key: current.key, title: current.title, status: 'accepted', reason: 'Verified completed in the catalog after recovery.' });
    } else if (batch.pendingEffect === 'open') {
      // Opening a card never starts a solver. Navigation can be reconciled by
      // leaving the card unfinished and disposing only of our recorded tabs.
      batch.results = batch.results.filter((item) => item.key !== batch.activeItemKey || item.status !== 'unknown');
    } else if (batch.pendingEffect === 'next_page' && batch.paginationFrom) {
      const fingerprint = scan.pageFingerprint || JSON.stringify(scan.items.map((item) => item.key));
      batch.visitedPages ||= [];
      if (fingerprint !== batch.paginationFrom.fingerprint) {
        if (batch.visitedPages.includes(fingerprint)) throw new Error('The interrupted pagination returned to a previously handled page.');
        if (!batch.visitedPages.includes(batch.paginationFrom.fingerprint)) batch.visitedPages.push(batch.paginationFrom.fingerprint);
      }
      batch.paginationFrom = null;
    }
    batch.pendingEffect = null;
    batch.activeItemKey = null;
    batch.workspaceTabId = null;
    batch.recovery = { required: false };
    batch.error = null;
    batch.completedKeys = batch.results.filter((item) => item.status === 'accepted').map((item) => item.key);
    await persist();
    await closeOwned();
  }
  async function bindReplacementCatalog(tabId) {
    if (!Number.isInteger(tabId) || tabId === batch.catalogTabId) return;
    try {
      await getTab(batch.catalogTabId);
      throw new Error('The saved batch catalog tab is still open. Return to it to reconcile this batch.');
    } catch (error) {
      if (!/No tab with id|closed|not found/i.test(error.message || '')) throw error;
    }
    const scan = await catalog.scan(tabId, { expand: true, signal: controller.signal });
    if (!scan?.isCatalog || !scan.complete) throw new Error(scan?.reason || 'Open the course All Assignments catalog before reconciling.');
    if (batch.catalogUrl) {
      if (new URL(scan.currentUrl).pathname !== new URL(batch.catalogUrl).pathname) {
        throw new Error('Open the All Assignments catalog for the same course as the saved batch.');
      }
    } else if (batch.pendingEffect || batch.results.length || batch.ownedTabs.length) {
      throw new Error('The saved batch lacks a verified course identity. Its uncertain work needs manual review.');
    }
    batch.catalogTabId = tabId;
    batch.catalogUrl = scan.currentUrl;
    await persist();
  }
  async function run(payload) {
    while (true) {
      await phase('scanning');
      const scan = await scanCatalog();
      const handled = new Set(batch.results.map((item) => item.key));
      for (const item of scan.items) {
        if (item.status === 'unfinished' && item.kind === 'unsupported' && !handled.has(item.key)) {
          const skipped = { key: item.key, title: item.title, status: 'skipped', reason: item.reason || 'Unsupported assignment workspace.' };
          recordResult(skipped);
          batch.skipped.push(skipped);
          handled.add(item.key);
        }
      }
      const next = scan.items.find((item) => item.status === 'unfinished' && item.kind !== 'unsupported' && !handled.has(item.key));
      if (!next) {
        if (scan.hasNextPage) {
          batch.visitedPages ||= [];
          const fingerprint = scan.pageFingerprint || JSON.stringify(scan.items.map((item) => item.key));
          if (batch.visitedPages.includes(fingerprint)) throw new Error('Catalog pagination returned to an already handled page.');
          if (batch.visitedPages.length >= 49) throw new Error('The batch reached its 50-page catalog limit.');
          await phase('paging', { pendingEffect: 'next_page', activeItemKey: null,
            paginationFrom: { fingerprint, url: scan.currentUrl } });
          const advanced = await catalog.nextPage(batch.catalogTabId, { signal: controller.signal, expectedUrl: batch.catalogUrl });
          if (!advanced?.success || !advanced.catalog?.complete) throw new Error(advanced?.reason || 'The next catalog page could not be verified.');
          validateCatalog(advanced.catalog);
          const nextFingerprint = advanced.catalog.pageFingerprint || JSON.stringify(advanced.catalog.items.map((item) => item.key));
          if (nextFingerprint === fingerprint || batch.visitedPages.includes(nextFingerprint)) throw new Error('Next did not produce a new assignment page.');
          batch.visitedPages.push(fingerprint);
          batch.catalogUrl = advanced.catalog.currentUrl;
          batch.pendingEffect = null;
          batch.paginationFrom = null;
          await persist();
          continue;
        }
        await phase('completed', { pendingEffect: null, activeItemKey: null, reason: 'Finished the supported unfinished assignments in the loaded catalog scope.' });
        return;
      }
      await phase('opening', { activeItemKey: next.key, pendingEffect: 'open', reason: null, error: null });
      const opened = await catalog.open(batch.catalogTabId, next, {
        signal: controller.signal, ownershipId: batch.id,
        onOwnedTab: async (owned) => {
          const index = batch.ownedTabs.findIndex((item) => item.tabId === owned.tabId);
          if (index === -1) batch.ownedTabs.push(copy(owned));
          else batch.ownedTabs[index] = copy(owned);
          await persist();
        },
      });
      if (opened?.status === 'unsupported') {
        const skipped = { key: next.key, title: next.title, status: 'skipped', reason: opened.reason };
        recordResult(skipped);
        batch.skipped.push(skipped);
        batch.pendingEffect = null;
        await persist();
        await closeOwned();
        batch.activeItemKey = null;
        batch.workspaceTabId = null;
        await persist();
        continue;
      }
      if (!opened?.success || !Number.isInteger(opened.workspaceTabId)) throw new Error(opened?.reason || 'The assignment workspace could not be identified.');
      batch.workspaceTabId = opened.workspaceTabId;
      await phase('solving', { pendingEffect: 'solve' });
      let result;
      let solveError;
      ownsSingleAction = true;
      try {
        result = await singleRunner.action('solve', { tabId: opened.workspaceTabId,
          apiKey: payload.apiKey, model: payload.model, maxTokens: payload.maxTokens });
      } catch (error) {
        solveError = error;
        result = await singleRunner.getState();
      } finally { ownsSingleAction = false; }
      const status = outcome(result);
      if (!status) {
        const job = result?.job;
        const failure = job?.failure;
        const known = job?.context?.tabId === opened.workspaceTabId && failure?.known &&
          !job.recovery?.required && !job.pendingRequestId && !job.pendingSaveId && !job.pendingSubmissionId &&
          ![401, 403, 429].includes(solveError?.status) && ['unsupported', 'compile', 'runtime', 'checks', 'rejected'].includes(failure.kind);
        if (!known) throw solveError || new Error(job?.error || job?.reason || 'The assignment has no acknowledged submission. Review its single-assignment job before continuing.');
        const failed = { key: next.key, title: next.title, status: failure.kind === 'unsupported' ? 'skipped' : 'failed',
          reason: failure.message || job.error || 'The assignment failed its verified checks.', workspaceTabId: opened.workspaceTabId, singleJobId: job.id };
        recordResult(failed);
        if (failed.status === 'skipped') batch.skipped.push(failed);
        else {
          // Preserve an unsuccessful candidate for review, especially an unsaved
          // notebook. These owned tabs are no longer candidates for auto-close.
          batch.retainedTabs ||= [];
          batch.retainedTabs.push(...batch.ownedTabs.filter((owned) => owned.tabId === opened.workspaceTabId));
          batch.ownedTabs = batch.ownedTabs.filter((owned) => owned.tabId !== opened.workspaceTabId);
        }
        batch.pendingEffect = null;
        await persist();
        checkStopped();
        await closeOwned();
        batch.activeItemKey = null;
        batch.workspaceTabId = null;
        await persist();
        continue;
      }
      // Acknowledged submissions are recorded before any cancellation boundary.
      recordResult({ key: next.key, title: next.title, status,
        singleJobId: result?.job?.id || null, reason: status === 'submitted' ? 'Submission acknowledged; grading is pending.' : 'Portal acceptance confirmed.' });
      batch.pendingEffect = 'verify';
      await persist();
      checkStopped();
      await phase('verifying');
      // Native reload can reset same-URL SPA pagination. Acknowledged submissions
      // are already durable; verify against the live card without resetting it.
      const verified = await scanCatalog(false);
      const current = verified.items.find((item) => item.key === next.key);
      const itemResult = batch.results.find((item) => item.key === next.key);
      if (current?.status === 'completed') {
        itemResult.status = 'accepted';
        itemResult.reason = 'Completion verified by the catalog status icon.';
      }
      batch.completedKeys = batch.results.filter((item) => item.status === 'accepted').map((item) => item.key);
      batch.pendingEffect = null;
      await persist();
      await closeOwned();
      batch.activeItemKey = null;
      batch.workspaceTabId = null;
      await persist();
    }
  }

  return {
    get busy() { return busy; },
    async getState() { await load(); return view(); },
    async stop() {
      controller?.abort();
      if (ownsSingleAction) await singleRunner.stop();
      await load();
      if (!batch) return view();
      batch.phase = busy ? 'stopping' : 'stopped';
      batch.reason = 'Future batch steps stopped. An already dispatched assignment action may still need reconciliation.';
      if (batch.pendingEffect) batch.recovery = { required: true, message: batch.reason };
      await persist();
      return view();
    },
    async recover(payload = {}) {
      if (busy || isOtherBusy() || singleRunner.busy) throw new Error('Another quiz or assignment job is active.');
      busy = true;
      controller = new AbortController();
      try {
        await load();
        if (!batch) return view();
        await bindReplacementCatalog(payload.tabId);
        await reconcile();
        await phase('stopped', { reason: 'Batch reconciled. Start continues the remaining assignment cards.' });
      } catch (error) {
        if (batch) {
          recordInterruption(error);
          batch.phase = 'needs_reconciliation';
          batch.error = error.message;
          batch.recovery = { required: true, message: error.message };
          await persist();
        }
        throw error;
      } finally { busy = false; controller = null; emit(); }
      return view();
    },
    async start(payload = {}) {
      if (busy || isOtherBusy() || singleRunner.busy) throw new Error('Another quiz or assignment job is active.');
      busy = true;
      controller = new AbortController();
      emit();
      try {
        await load();
        if (!Number.isInteger(payload.tabId)) throw new Error('A catalog tab is required.');
        if (batch?.recovery?.required || batch?.pendingEffect) {
          await bindReplacementCatalog(payload.tabId);
          await reconcile();
        } else if (batch && payload.tabId === batch.catalogTabId) {
          // Keep acknowledged but ungraded submissions across subsequent starts.
          // They must not turn back into fresh solves merely because a tick lags.
          const current = await catalog.scan(payload.tabId, { signal: controller.signal });
          if (!current?.isCatalog || !current.complete) throw new Error(current?.reason || 'The catalog is not ready.');
          if (batch.catalogUrl && new URL(current.currentUrl).pathname !== new URL(batch.catalogUrl).pathname) {
            throw new Error('Start this course in a different catalog tab to keep the previous course results separate.');
          }
          batch.catalogUrl = current.currentUrl;
          batch.visitedPages = [];
          await reconcile();
        } else {
          batch = { version: 1, id: makeId(), catalogTabId: payload.tabId, catalogUrl: null, phase: 'scanning',
            items: [], results: [], skipped: [], completedKeys: [], ownedTabs: [], activeItemKey: null,
            pendingEffect: null, recovery: { required: false }, createdAt: now() };
          await persist();
        }
        checkStopped();
        await run(payload);
      } catch (error) {
        if (batch) {
          recordInterruption(error);
          batch.error = error.message;
          batch.phase = controller.signal.aborted ? 'stopped' : 'needs_attention';
          if (batch.pendingEffect) batch.recovery = { required: true, message: error.message };
          await persist();
        }
        throw error;
      } finally {
        busy = false;
        controller = null;
        emit();
      }
      return view();
    },
  };
}
