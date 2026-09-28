const NEWTON_ORIGIN = 'https://my.newtonschool.co';
const CATALOG_PATH = /^\/course\/[^/]+\/all_assignments\/?$/;

export function assignmentWorkspace(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== NEWTON_ORIGIN || parsed.username || parsed.password) return null;
    const match = parsed.pathname.match(/^\/playground\/(code|newton-box)\/([^/]+)\/?$/);
    return match ? { kind: match[1] === 'code' ? 'code' : 'notebook', problemId: match[2], url: parsed.href } : null;
  } catch { return null; }
}

// Keep discovery and click matching in the same serialized function so no
// selector or classification differs between the snapshot and native click.
export function assignmentCatalogPage(operation = 'scan', expected = null) {
  const currentUrl = location.href;
  const isCatalog = location.origin === 'https://my.newtonschool.co' && /^\/course\/[^/]+\/all_assignments\/?$/.test(location.pathname);
  if (!isCatalog) return { isCatalog: false, currentUrl, items: [], complete: false, reason: 'Open the Newton course All Assignments page.' };
  const visible = (element) => Boolean(element?.getClientRects().length);
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const statusName = (image) => {
    try {
      const name = new URL(image.getAttribute('src') || '', location.href).pathname.split('/').pop();
      return name === 'tick.svg' ? 'completed' : name === 'dash.svg' ? 'unfinished' : null;
    } catch { return null; }
  };
  const titleSelector = '[data-testid="assignment-title"], [data-assignment-title], h2, h3, h4, .sc-ccf6239c-5.gHysLX';
  const titleNodes = (root) => {
    const marked = Array.from(root.querySelectorAll(titleSelector)).filter((element) => visible(element) && clean(element.innerText || element.textContent));
    if (marked.length) return marked;
    // Newton sometimes renders titles as styled spans. Accept only a unique
    // emphasized leaf; XP, dates and numeric counters cannot become a title.
    return Array.from(root.querySelectorAll('b, strong, span, p')).filter((element) => {
      const value = clean(element.innerText || element.textContent);
      return visible(element) && !element.children.length && value.length >= 8 && /[a-z]/i.test(value) &&
        !/\bXP\b|^\d|^(?:due|assigned|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(value) &&
        (element.matches('b, strong') || Number.parseInt(getComputedStyle(element).fontWeight, 10) >= 600);
    });
  };
  const cardSelector = '[data-testid="assignment-card"], [data-testid="assignment-item"], [data-assignment-id], .sc-ccf6239c-3.kxmaFX';
  const statusImages = Array.from(document.querySelectorAll('img[src]')).filter((image) => visible(image) && statusName(image));
  const statusCache = new WeakMap();
  const rowStatusImages = (root) => {
    if (!statusCache.has(root)) statusCache.set(root, statusImages.filter((image) => root.contains(image)));
    return statusCache.get(root);
  };
  const isXp = (value) => /^\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?(?:\s*XP)?$/i.test(value) || /^\d+(?:\.\d+)?\s*XP$/i.test(value);
  const isDate = (value) => /^(?:\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b.*|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b.*|\d{1,4}[/-]\d{1,2}[/-]\d{1,4})$/i.test(value);
  const columnHeaders = (row) => {
    const columnCount = row.children.length;
    if (columnCount < 2) return null;
    let branch = row;
    for (let depth = 0; branch?.parentElement && depth < 5; depth++, branch = branch.parentElement) {
      const candidates = Array.from(branch.parentElement.children).flatMap((sibling) => [sibling, ...Array.from(sibling.children)]);
      const matches = candidates.filter((candidate) => !candidate.contains(row) && visible(candidate) &&
        candidate.children.length === columnCount && rowStatusImages(candidate).length === 0).map((candidate) =>
        Array.from(candidate.children).map((column) => clean(column.innerText || column.textContent).toLowerCase()));
      const headers = matches.filter((labels) => labels.filter((label) => /^(?:questions?|assignment(?: name)?)$/.test(label)).length === 1);
      if (headers.length === 1) return headers[0];
      if (headers.length > 1 && headers.every((labels) => JSON.stringify(labels) === JSON.stringify(headers[0]))) return headers[0];
    }
    return null;
  };
  const readRowFields = (row) => {
    const allColumns = Array.from(row.children).map((node) => ({ node, text: visible(node) ? clean(node.innerText || node.textContent) : '' }));
    const headers = columnHeaders(row);
    if (headers) {
      const titleIndex = headers.findIndex((label) => /^(?:questions?|assignment(?: name)?)$/.test(label));
      const subjectIndex = headers.findIndex((label) => /^(?:subject|course)$/.test(label));
      const dateIndex = headers.findIndex((label) => /^(?:date|due date|deadline|assigned on|assigned date)$/.test(label));
      return { titleNode: allColumns[titleIndex].node, title: allColumns[titleIndex].text,
        subject: allColumns[subjectIndex]?.text || '', date: allColumns[dateIndex]?.text || '', headerMapped: true,
        hasXp: allColumns.some((column) => isXp(column.text)) };
    }
    const columns = allColumns.filter((column) => column.text);
    const dates = columns.filter((column) => isDate(column.text));
    const subjects = columns.filter((column) => /^[A-Z]{2,6}\s*-\s*[A-Z]$/.test(column.text));
    const titles = columns.filter((column) => !isXp(column.text) && !isDate(column.text) && !subjects.includes(column) &&
      !/^\d+$/.test(column.text) && !/^(?:completed|unfinished|not started|open|view|assignment)$/i.test(column.text));
    return { titleNode: titles.length === 1 ? titles[0].node : null, title: titles.length === 1 ? titles[0].text : '',
      subject: subjects.length === 1 ? subjects[0].text : '', date: dates.length === 1 ? dates[0].text : '',
      hasXp: columns.some((column) => isXp(column.text)) };
  };
  const fieldsCache = new WeakMap();
  const rowFields = (row) => {
    if (!fieldsCache.has(row)) fieldsCache.set(row, readRowFields(row));
    return fieldsCache.get(row);
  };
  const rowSection = (row) => {
    let branch = row;
    for (let depth = 0; branch?.parentElement && branch.parentElement !== document.body && depth < 5; depth++, branch = branch.parentElement) {
      const siblings = Array.from(branch.parentElement.children);
      for (let index = siblings.indexOf(branch) - 1; index >= 0; index--) {
        const sibling = siblings[index];
        if (!visible(sibling) || rowStatusImages(sibling).length) continue;
        const descendants = Array.from(sibling.querySelectorAll('p, span, div, b, strong, h1, h2, h3, h4'));
        const nodes = [sibling, ...descendants].filter((node) => visible(node) &&
          !Array.from(node.children).some((child) => clean(child.innerText || child.textContent)));
        const values = nodes.map((node) => clean(node.innerText || node.textContent)).filter(Boolean);
        if (values.some((value) => /^(?:questions?|topics?|status|XP(?: earned)?|difficulty|solved by|actions)$/i.test(value))) continue;
        const dateText = (value) => isDate(value) || /(?:release|deadline)\s*[-:]/i.test(value);
        const dates = values.filter(dateText);
        const labels = values.filter((value) => !dateText(value) && !isXp(value) && !/^\d|^(?:assignments?|all assignments|view all|filter|search|next|previous)$/i.test(value));
        const subjects = nodes.filter((node) => node.matches('p')).map((node) => clean(node.innerText || node.textContent)).filter((value) => labels.includes(value));
        const subject = subjects.length === 1 ? subjects[0] : '';
        const sections = labels.filter((value) => value !== subject);
        if (sections.length === 1 && sections[0].length <= 200 || !sections.length && subject) {
          return { section: sections[0] || subject, subject, date: dates.join(' | ') };
        }
      }
    }
    return { section: '', subject: '', date: '' };
  };
  const rowRoots = new Map();
  for (const image of statusImages) {
    let parent = image.parentElement;
    for (let depth = 0; parent && parent !== document.body && depth < 10; depth++, parent = parent.parentElement) {
      if (rowStatusImages(parent).length !== 1) break;
      const fields = rowFields(parent);
      if (!fields.title) continue;
      const repeated = Array.from(parent.parentElement?.children || []).filter((sibling) =>
        visible(sibling) && rowStatusImages(sibling).length === 1 && rowFields(sibling).title).length > 1;
      const semantic = parent.matches('tr, [role="row"]');
      const titleClickable = getComputedStyle(fields.titleNode).cursor === 'pointer';
      if (semantic || repeated || fields.headerMapped || fields.hasXp && titleClickable) { rowRoots.set(parent, fields); break; }
    }
  }
  const roots = new Set(Array.from(document.querySelectorAll(cardSelector)).filter(visible));
  rowRoots.forEach((_fields, row) => roots.add(row));
  for (const image of statusImages) {
    if ([...rowRoots.keys()].some((row) => row.contains(image))) continue;
    let parent = image.parentElement;
    for (let depth = 0; parent && parent !== document.body && depth < 8; depth++, parent = parent.parentElement) {
      if (Array.from(parent.querySelectorAll('img[src]')).filter(statusName).length !== 1) break;
      const titles = titleNodes(parent);
      if (titles.length === 1) { roots.add(parent); break; }
    }
  }
  // Prefer a recognized card wrapper over a nested icon/title discovery root.
  const cards = [...roots].filter((root) => ![...roots].some((other) => other !== root && other.matches(cardSelector) && other.contains(root)));
  const entries = cards.map((card) => {
    const titles = titleNodes(card);
    const fields = rowRoots.get(card);
    const section = fields ? rowSection(card) : { section: '', date: '' };
    const title = fields?.title || (titles.length === 1 ? clean(titles[0].innerText || titles[0].textContent) : '');
    const subject = fields?.subject || section.subject || clean(card.querySelector('[data-testid="assignment-subject"], .sc-ccf6239c-6.cykAEe')?.textContent);
    const date = fields?.date || section.date || clean(card.querySelector('[data-testid="assignment-date"], .sc-ccf6239c-7.fKIbyq')?.textContent);
    const statuses = Array.from(card.querySelectorAll('img[src]')).filter(visible).map(statusName).filter(Boolean);
    const status = statuses.length === 1 ? statuses[0] : 'ambiguous';
    const anchors = [ ...(card.matches('a[href]') ? [card] : []), ...Array.from(card.querySelectorAll('a[href]')) ];
    const rawUrls = anchors.map((element) => element.getAttribute('href')).concat([card.getAttribute('data-href')]).filter(Boolean);
    const urls = [...new Set(rawUrls.map((href) => { try { return new URL(href, location.href).href; } catch { return ''; } }).filter(Boolean))];
    const url = urls.length === 1 ? urls[0] : null;
    let kind = 'unresolved';
    if (url) {
      const parsed = new URL(url);
      const route = parsed.origin === location.origin && parsed.pathname.match(/^\/playground\/(code|newton-box)\/([^/]+)\/?$/);
      kind = route ? (route[1] === 'code' ? 'code' : 'notebook') : 'unsupported';
    }
    const rowClickable = card.matches('a[href], button, [role="button"]') || getComputedStyle(card).cursor === 'pointer';
    const titleClickable = fields?.titleNode && getComputedStyle(fields.titleNode).cursor === 'pointer';
    const structuralRow = fields && (fields.headerMapped || fields.hasXp || card.matches('tr, [role="row"]'));
    const clickTarget = rowClickable || !fields || card.matches(cardSelector) ? card : titleClickable || structuralRow ? fields.titleNode : null;
    const clickable = Boolean(clickTarget) && (rowClickable || titleClickable || structuralRow || card.matches(cardSelector));
    const ambiguous = !title || urls.length > 1 || status === 'ambiguous' || (!url && !clickable);
    const descriptor = { title, subject, date, ...(section.section ? { section: section.section } : {}) };
    const key = url || JSON.stringify(descriptor);
    return { card, clickTarget, item: { key, title, subject, date, section: section.section, status, kind, url, descriptor, ambiguous,
      reason: kind === 'unsupported' ? 'This card links to an unsupported workspace.' : ambiguous ? 'The card title, status or navigation target is ambiguous.' : null } };
  });
  const counts = new Map();
  entries.forEach(({ item }) => counts.set(item.key, (counts.get(item.key) || 0) + 1));
  entries.forEach(({ item }) => { if (counts.get(item.key) > 1) item.ambiguous = true; });
  const loadMore = Array.from(document.querySelectorAll('button, [role="button"]')).filter((element) => visible(element) &&
    !element.disabled && element.getAttribute('aria-disabled') !== 'true' && /^load more(?: assignments)?$/i.test(clean(element.innerText || element.textContent)));
  const nextPages = Array.from(document.querySelectorAll('button, a[href], [role="button"]')).filter((element) => visible(element) &&
    !element.disabled && element.getAttribute('aria-disabled') !== 'true' &&
    (/^(?:next|next page)$/i.test(clean(element.innerText || element.textContent)) ||
      /^(?:next|next page)$/i.test(element.getAttribute('aria-label') || '') || element.getAttribute('data-testid') === 'pagination-next'));
  const pageFingerprint = JSON.stringify(entries.map(({ item }) => item.key));
  if (operation === 'load-more') {
    if (loadMore.length !== 1 || expected?.catalogUrl !== currentUrl) return { success: false, reason: 'A unique Load more control is unavailable.' };
    loadMore[0].click();
    return { success: true };
  }
  if (operation === 'next-page') {
    if (nextPages.length !== 1 || expected?.catalogUrl !== currentUrl || expected?.pageFingerprint !== pageFingerprint) {
      return { success: false, reason: 'The current catalog page or its Next control is ambiguous.' };
    }
    nextPages[0].click();
    return { success: true };
  }
  if (operation === 'click') {
    if (expected?.catalogUrl !== currentUrl) return { success: false, reason: 'The catalog URL changed before opening the card.' };
    const matches = entries.filter(({ item }) => item.key === expected.item?.key &&
      JSON.stringify(item.descriptor) === JSON.stringify(expected.item.descriptor));
    if (matches.length !== 1 || matches[0].item.ambiguous || matches[0].item.status !== 'unfinished') {
      return { success: false, reason: 'The assignment card changed, completed, or is no longer unique.' };
    }
    const { card, item, clickTarget } = matches[0];
    const target = item.url ? card.querySelector('a[href]') || card : clickTarget;
    if (card.disabled || card.getAttribute('aria-disabled') === 'true' || target.disabled || target.getAttribute('aria-disabled') === 'true') return { success: false, reason: 'The assignment card is disabled.' };
    target.click();
    return { success: true, key: item.key };
  }
  const knownStatusCount = Array.from(document.querySelectorAll('img[src]')).filter((image) => visible(image) && statusName(image)).length;
  const coveredStatusCount = cards.reduce((sum, card) => sum + Array.from(card.querySelectorAll('img[src]')).filter((image) => visible(image) && statusName(image)).length, 0);
  const emptyConfirmed = Array.from(document.querySelectorAll('[data-testid="assignments-empty"], [role="status"]'))
    .some((element) => visible(element) && /^(?:no assignments(?: found| available)?|all assignments completed)$/i.test(clean(element.innerText || element.textContent)));
  const complete = entries.length <= 500 && knownStatusCount === coveredStatusCount && (entries.length > 0 || emptyConfirmed);
  return { isCatalog, currentUrl, items: entries.map(({ item }) => item), complete, pageFingerprint,
    hasLoadMore: loadMore.length === 1, hasNextPage: nextPages.length > 0,
    scope: 'Loaded assignment cards, with observed Load more and Next page controls followed automatically.',
    reason: complete ? null : 'Some assignment cards could not be identified completely. Load the catalog and inspect its titles and status icons.' };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopped = (signal) => { if (signal?.aborted) throw new Error('Assignment batch stopped.'); };
async function waitLoaded(tabId, signal, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  do {
    stopped(signal);
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await pause(150);
  } while (Date.now() < deadline);
  throw new Error('The assignment page did not finish loading.');
}
async function page(tabId, operation, expected) {
  const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN',
    func: assignmentCatalogPage, args: [operation, expected] });
  return results[0]?.result;
}
async function scan(tabId, { refresh = false, expand = false, signal, timeoutMs = 15000 } = {}) {
  stopped(signal);
  if (refresh) {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url || 'about:blank');
    if (url.origin !== NEWTON_ORIGIN || !CATALOG_PATH.test(url.pathname)) throw new Error('The catalog tab navigated to another page.');
    stopped(signal);
    await chrome.tabs.reload(tabId);
    await waitLoaded(tabId, signal);
  }
  const deadline = Date.now() + timeoutMs;
  let result;
  let expansions = 0;
  let previousCount = -1;
  do {
    stopped(signal);
    result = await page(tabId, 'scan', null);
    if (!result?.isCatalog) return result;
    if (result.complete && (!expand || !result.hasLoadMore)) return result;
    if (result.complete && expand && result.hasLoadMore && result.items.length > previousCount && expansions < 20) {
      previousCount = result.items.length;
      const clicked = await page(tabId, 'load-more', { catalogUrl: result.currentUrl });
      if (!clicked?.success) return { ...result, complete: false, reason: clicked?.reason || 'Loading more assignments failed.' };
      expansions++;
    }
    await pause(150);
  } while (Date.now() < deadline);
  return { ...result, complete: false, reason: result?.reason || 'The catalog did not finish loading all requested cards within the time limit.' };
}

async function nextPage(tabId, { signal, expectedUrl, timeoutMs = 15000 } = {}) {
  stopped(signal);
  const before = await scan(tabId, { expand: true, signal, timeoutMs });
  if (!before?.complete || expectedUrl && before.currentUrl !== expectedUrl) {
    return { success: false, reason: 'The catalog page changed before pagination.' };
  }
  stopped(signal);
  const clicked = await page(tabId, 'next-page', { catalogUrl: before.currentUrl, pageFingerprint: before.pageFingerprint });
  if (!clicked?.success) return clicked || { success: false, reason: 'The Next control returned no result.' };
  const deadline = Date.now() + timeoutMs;
  do {
    stopped(signal);
    let current;
    try { current = await page(tabId, 'scan', null); } catch { /* A native navigation can replace the document while reading. */ }
    if (current?.isCatalog && current.complete && current.pageFingerprint !== before.pageFingerprint) {
      if (new URL(current.currentUrl).pathname !== new URL(before.currentUrl).pathname) {
        return { success: false, reason: 'Next navigated outside this course assignment catalog.' };
      }
      const expanded = await scan(tabId, { expand: true, signal, timeoutMs });
      return expanded?.complete ? { success: true, catalog: expanded } : { success: false, reason: expanded?.reason };
    }
    await pause(150);
  } while (Date.now() < deadline);
  return { success: false, reason: 'Next did not produce a new stable assignment page. No card was reopened.' };
}

async function open(tabId, item, { signal, ownershipId, onOwnedTab = async () => {} } = {}) {
  stopped(signal);
  const current = await scan(tabId, { signal });
  const exact = current?.items?.filter((candidate) => candidate.key === item.key &&
    JSON.stringify(candidate.descriptor) === JSON.stringify(item.descriptor));
  if (!current?.isCatalog || !current.complete || exact?.length !== 1 || exact[0].status !== 'unfinished' || exact[0].ambiguous) {
    return { success: false, reason: 'The assignment card changed before opening.' };
  }
  const remember = async (tab, role, url) => {
    const owned = { tabId: tab.id, ownershipId, role, url, openerTabId: tab.openerTabId ?? null };
    await onOwnedTab(owned);
    return owned;
  };
  if (item.url) {
    if (!assignmentWorkspace(item.url)) return { success: false, status: 'unsupported', reason: 'Unsupported assignment link.' };
    stopped(signal);
    const workspace = await chrome.tabs.create({ url: item.url, active: false, openerTabId: tabId });
    await remember(workspace, 'workspace', item.url);
    await waitLoaded(workspace.id, signal);
    const final = await chrome.tabs.get(workspace.id);
    if (!assignmentWorkspace(final.url) || new URL(final.url).pathname !== new URL(item.url).pathname) {
      return { success: false, reason: 'The workspace navigated to a different assignment.' };
    }
    if (final.url !== item.url) await remember(final, 'workspace', final.url);
    return { success: true, workspaceTabId: workspace.id };
  }
  // No href: click only in a private catalog copy. A workspace popup must be
  // attributed to that exact opener; unrelated user tabs are never candidates.
  stopped(signal);
  const helper = await chrome.tabs.create({ url: current.currentUrl, active: false, openerTabId: tabId });
  await remember(helper, 'catalog-helper', current.currentUrl);
  await waitLoaded(helper.id, signal);
  let helperCatalog = await scan(helper.id, { expand: true, signal });
  const visited = new Set();
  for (let count = 0; count < 50 && helperCatalog?.complete && !helperCatalog.items.some((candidate) => candidate.key === item.key); count++) {
    if (!helperCatalog.hasNextPage || visited.has(helperCatalog.pageFingerprint)) break;
    visited.add(helperCatalog.pageFingerprint);
    const advanced = await nextPage(helper.id, { signal, expectedUrl: helperCatalog.currentUrl });
    if (!advanced?.success) return advanced;
    helperCatalog = advanced.catalog;
  }
  if (!helperCatalog?.complete || !helperCatalog.items.some((candidate) => candidate.key === item.key)) {
    return { success: false, reason: helperCatalog?.reason || 'The exact assignment card was not found in the catalog copy.' };
  }
  if (helperCatalog.currentUrl !== current.currentUrl) await remember(await chrome.tabs.get(helper.id), 'catalog-helper', helperCatalog.currentUrl);
  const created = new Map();
  const listener = (tab) => { if (tab.openerTabId === helper.id) created.set(tab.id, tab); };
  chrome.tabs.onCreated.addListener(listener);
  try {
    stopped(signal);
    const clicked = await page(helper.id, 'click', { catalogUrl: helperCatalog.currentUrl, item });
    if (!clicked?.success) return clicked || { success: false, reason: 'The catalog card click returned no result.' };
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      stopped(signal);
      const helperNow = await chrome.tabs.get(helper.id);
      const sameTab = assignmentWorkspace(helperNow.url);
      if (sameTab && !created.size) {
        await remember(helperNow, 'workspace', helperNow.url);
        await waitLoaded(helper.id, signal);
        return { success: true, workspaceTabId: helper.id };
      }
      if (created.size > 1) return { success: false, reason: 'The card opened multiple tabs; its workspace is ambiguous.' };
      if (created.size === 1) {
        const spawned = await chrome.tabs.get([...created.keys()][0]);
        if (spawned.status === 'complete' && spawned.url && spawned.url !== 'about:blank') {
          let url;
          try { url = new URL(spawned.url); } catch { return { success: false, reason: 'The opened tab has no recognized URL.' }; }
          if (url.origin !== NEWTON_ORIGIN) return { success: false, reason: 'The opened tab is outside the supported Newton portal.' };
          await remember(spawned, 'workspace', spawned.url);
          const workspace = assignmentWorkspace(spawned.url);
          return workspace ? { success: true, workspaceTabId: spawned.id } :
            { success: false, status: 'unsupported', reason: 'The card opened an unsupported assignment workspace.' };
        }
      }
      await pause(150);
    }
    return { success: false, reason: 'No workspace tab could be attributed to this assignment card.' };
  } finally { chrome.tabs.onCreated.removeListener(listener); }
}

async function closeOwnedTab(owned, ownershipId) {
  if (!owned || owned.ownershipId !== ownershipId || !Number.isInteger(owned.tabId)) {
    return { success: false, reason: 'Tab ownership could not be verified.' };
  }
  let tab;
  try { tab = await chrome.tabs.get(owned.tabId); } catch { return { success: true, alreadyClosed: true }; }
  if (tab.url !== owned.url || (owned.openerTabId !== null && tab.openerTabId !== owned.openerTabId)) {
    return { success: false, reason: 'The owned tab was navigated or reassigned; it was left open.' };
  }
  await chrome.tabs.remove(owned.tabId);
  return { success: true };
}

export const assignmentCatalog = { scan, open, nextPage, closeOwnedTab };
