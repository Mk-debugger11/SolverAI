export async function openCourseAssignmentCatalog(courseUrl, openerTabId, savedCatalogTabId, tabs = chrome.tabs) {
  const catalogUrl = new URL(courseUrl);
  catalogUrl.pathname = catalogUrl.pathname.replace(/\/details\/?$/, '/all_assignments');
  catalogUrl.search = '';
  catalogUrl.hash = '';

  if (Number.isInteger(savedCatalogTabId)) {
    try {
      const savedTab = await tabs.get(savedCatalogTabId);
      const savedUrl = new URL(savedTab.url);
      if (savedUrl.origin === catalogUrl.origin && savedUrl.pathname.replace(/\/$/, '') === catalogUrl.pathname) return savedTab.id;
    } catch { /* The saved tab was closed or navigated away. */ }
  }

  const catalogTab = await tabs.create({ url: catalogUrl.href, active: false, openerTabId });
  for (let attempt = 0; attempt < 100; attempt++) {
    const loaded = await tabs.get(catalogTab.id);
    if (loaded.status === 'complete') return loaded.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('The course assignment catalog did not finish loading in its new tab.');
}
