export const unavailableCapabilities = () => ({ generate: false, apply: false, run: false, save: false, restore: false, submit: false });

// Serialized into the outer document. Keep volatile editor/output text out of
// the statement fingerprint so executing code does not invalidate the task.
export function readAssignmentPageData(expectedUrl, kind, frameUrl) {
  if (expectedUrl && (location.hostname !== 'my.newtonschool.co' || location.href !== expectedUrl)) return null;
  if (kind === 'notebook') {
    const expected = new URL(frameUrl);
    if (!Array.from(document.querySelectorAll('iframe[src]')).some((frame) => {
      const actual = new URL(frame.src);
      return actual.origin === expected.origin && actual.pathname === expected.pathname;
    })) return null;
  }
  let pane = document.querySelector('[data-testid="problem-statement"], .problem-statement, .question-description, .text-span-question-renderer');
  if (!pane) {
    const labels = Array.from(document.querySelectorAll('div, span, p, h2, h3'))
      .filter((node) => !node.children.length && /^QUESTION$/i.test(node.innerText?.trim() || ''));
    const candidates = labels.map((label) => {
      let node = label.parentElement;
      let last = null;
      while (node && node !== document.body) {
        if (node.querySelector('iframe, .monaco-editor, #notebook-container')) break;
        if ((node.innerText || '').trim().length > 100) { last = node; break; }
        node = node.parentElement;
      }
      return last;
    }).filter(Boolean);
    if (candidates.length === 1) pane = candidates[0];
  }
  const statement = pane?.innerText?.trim() || '';
  return { title: pane?.querySelector?.('h1, [data-testid="question-title"]')?.innerText?.trim() || document.title || '', statement };
}

export async function hashSource(source) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function injectionTarget(context) {
  if (!context?.tabId) throw new Error('An assignment tab is required.');
  return context.documentId
    ? { tabId: context.tabId, documentIds: [context.documentId] }
    : { tabId: context.tabId, frameIds: [context.frameId ?? 0] };
}

export async function revalidateAssignmentContext(context, { outerContextHash } = {}) {
  const results = await chrome.scripting.executeScript({
    target: context.outerDocumentId ? { tabId: context.tabId, documentIds: [context.outerDocumentId] } : { tabId: context.tabId, frameIds: [0] },
    world: 'MAIN', args: [context.url, context.kind, context.frameUrl],
    func: readAssignmentPageData,
  });
  const result = results[0]?.result;
  if (!result) throw new Error('The outer assignment or its notebook frame changed. Inspect it again.');
  if (outerContextHash && await hashSource(JSON.stringify(result)) !== outerContextHash) throw new Error('The assignment instructions changed. Inspect them again.');
  return result;
}

export async function finalizeSnapshot(context, data) {
  const targets = await Promise.all((data.targets || []).map(async (target) => ({
    ...target, sourceHash: await hashSource(target.source),
  })));
  const snapshot = {
    ...data, kind: context.kind, problemId: context.problemId, url: context.url,
    frameUrl: data.frameUrl || context.frameUrl, documentId: context.documentId,
    documentToken: data.documentToken || context.documentToken, targets,
    title: data.title ?? context.title ?? '', statement: data.statement ?? context.statement ?? '',
  };
  snapshot.outerContextHash = await hashSource(JSON.stringify({ title: snapshot.title, statement: snapshot.statement }));
  const contextMetadata = (metadata) => metadata && Object.fromEntries(Object.entries(metadata).filter(([key]) => !['execution', 'ExecuteTime'].includes(key)));
  snapshot.contextHash = await hashSource(JSON.stringify({
    kind: snapshot.kind, problemId: snapshot.problemId, url: snapshot.url,
    documentId: snapshot.documentId, documentToken: snapshot.documentToken,
    notebookIdentity: snapshot.notebookIdentity, runtime: snapshot.runtime,
    title: snapshot.title, statement: snapshot.statement,
    targets: targets.map(({ targetId, sourceHash, editable, cellType, index, metadata, editableRange }) =>
      ({ targetId, sourceHash, editable, cellType, index, metadata: contextMetadata(metadata), editableRange })),
  }));
  return snapshot;
}

export async function detectAssignment(tabId) {
  const unsupported = (reason, extra = {}) => ({
    ...extra, kind: 'unsupported', tabId, capabilities: unavailableCapabilities(), reasons: [reason],
  });
  if (!tabId || typeof chrome === 'undefined' || !chrome.scripting) return unsupported('Chrome scripting is unavailable.');
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'MAIN',
      func: () => ({
        url: location.href,
        documentToken: `${location.href}::${performance.timeOrigin}`,
        title: document.querySelector('h1')?.innerText?.trim() || document.title || '',
        statement: document.querySelector('[data-testid="problem-statement"], .problem-statement, .question-description')?.innerText || document.body?.innerText || '',
        frames: Array.from(document.querySelectorAll('iframe[src]'), (frame) => frame.src),
        classicNotebook: Boolean(window.Jupyter?.notebook?.get_cells),
      }),
    });
  } catch (error) {
    return unsupported(`Cannot inspect assignment documents: ${error.message}`);
  }
  const top = results.find((result) => result.frameId === 0);
  if (!top?.result) return unsupported('The assignment document could not be read.');
  const page = top.result;
  const pageUrl = new URL(page.url);
  if (pageUrl.hostname !== 'my.newtonschool.co' || pageUrl.protocol !== 'https:') return unsupported('The assignment must be on the verified Newton portal host.');
  const match = pageUrl.pathname.match(/^\/playground\/(code|newton-box)\/([^/]+)\/?$/);
  if (!match) return unsupported('This page is not a supported coding or notebook assignment.', { url: page.url });
  const common = {
    tabId, problemId: match[2], url: page.url, title: page.title, statement: page.statement, outerDocumentId: top.documentId,
    capabilities: unavailableCapabilities(), reasons: [],
  };
  if (match[1] === 'code') return {
    ...common, kind: 'code', frameId: 0, documentId: top.documentId,
    documentToken: page.documentToken, frameUrl: page.url,
    reasons: [],
  };

  const frameUrls = page.frames.filter((url) => {
    try { return /^https:$/.test(new URL(url).protocol) && /(^|\.)edison-jupyter\.newtonschool\.co$/.test(new URL(url).hostname); }
    catch { return false; }
  });
  const frames = results.filter(({ frameId, result }) => frameId !== 0 && result?.classicNotebook && frameUrls.some((url) => {
    const requested = new URL(url);
    const actual = new URL(result.url);
    return requested.origin === actual.origin && requested.pathname === actual.pathname;
  }));
  if (frames.length !== 1) return unsupported(
    frames.length ? 'Several notebook frames match this assignment; select a verified frame before continuing.' :
      'The assignment notebook frame is inaccessible or does not expose classic Jupyter. Check the frame permission and wait for it to load.', common,
  );
  const frame = frames[0];
  return { ...common, kind: 'notebook', frameId: frame.frameId, documentId: frame.documentId,
    documentToken: frame.result.documentToken, frameUrl: frame.result.url };
}
