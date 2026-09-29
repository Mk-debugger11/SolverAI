// This chooses popup actions only. The worker still verifies the live document
// and editor before it reads, writes, executes or submits anything.
export function getAssignmentPageScope(value) {
  if (!value) return {
    kind: 'unknown', label: 'Active tab unavailable',
    message: 'Open a Newton assignment or its All Assignments catalog, then reopen the extension.',
  };
  let url;
  try { url = new URL(value); } catch {
    return { kind: 'unknown', label: 'Page not identified', message: 'Open a Newton assignment or its All Assignments catalog.' };
  }
  if (url.origin !== 'https://my.newtonschool.co' || url.username || url.password) return {
    kind: 'external', label: 'Open Newton to continue',
    message: 'Assignment actions are available on the Newton portal. Open a coding assignment, notebook or All Assignments catalog.',
  };
  if (/^\/course\/[^/]+\/all_assignments\/?$/.test(url.pathname)) return {
    kind: 'catalog', label: 'All Assignments catalog',
    message: 'Solve the unfinished assignments in this course. Open an individual assignment to inspect its sources.',
  };
  if (/^\/playground\/(code|newton-box)\/[^/]+\/?$/.test(url.pathname)) return {
    kind: 'workspace', label: url.pathname.startsWith('/playground/newton-box/') ? 'Notebook assignment' : 'Coding assignment',
    message: 'Solve or inspect the assignment open in this tab.',
  };
  if (/\/assessment\b|\/test\b|\/quiz\b/i.test(url.pathname)) return {
    kind: 'quiz', label: 'Quiz detected',
    message: 'This tab is an MCQ or Numerical Quiz. Switch to the Quizzes tab to auto-solve it.',
  };
  return {
    kind: 'portal', label: 'Choose an assignment',
    message: 'Open a coding assignment or notebook for a single solve, or the course All Assignments catalog for a batch.',
  };
}

export function assertAssignmentPageAction(url, action) {
  const scope = getAssignmentPageScope(url);
  if (action === 'start' && scope.kind !== 'catalog') {
    throw new Error('Open the course All Assignments catalog before starting an assignment batch.');
  }
  if (['inspect', 'solve'].includes(action) && scope.kind !== 'workspace') {
    throw new Error(scope.kind === 'catalog'
      ? 'This tab is the assignment catalog. Use Solve unfinished assignments, or open an individual assignment to inspect it.'
      : scope.message);
  }
  return scope;
}
