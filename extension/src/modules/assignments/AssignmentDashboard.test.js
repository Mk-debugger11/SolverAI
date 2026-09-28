import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

// Compile the JSX and renderer together so these checks use the real React
// component without requiring a browser or touching a portal tab.
const bundle = buildSync({
  stdin: {
    resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import Dashboard from './AssignmentDashboard.jsx';
      export function render(props) {
        return renderToStaticMarkup(React.createElement(Dashboard, { onAction() {}, activeTabUrl: 'https://my.newtonschool.co/playground/code/p1', ...props }));
      }
    `,
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  loader: { '.css': 'empty' }, logLevel: 'silent',
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url), compiled, compiled.exports,
);
const { render } = compiled.exports;

function draftJob() {
  const snapshot = {
    kind: 'notebook', title: 'Notebook exercise', statement: 'Complete the function.',
    runtime: { language: 'python', label: 'Python 3' },
    targets: [{ targetId: 'cell-1', label: 'Cell 1', cellType: 'code', editable: true, source: 'pass\n' }],
    capabilities: { generate: true, apply: true, run: true, save: true, restore: true },
    warnings: [], reasons: [],
  };
  return {
    id: 'job-1', phase: 'draft', snapshot, draftSnapshot: snapshot,
    edits: [{ targetId: 'cell-1', content: 'if x < 2:\n\tprint("0")\n' }],
    usage: { logicalGenerations: 1, providerAttempts: 1, totalTokens: 0 },
    budget: { maxAttempts: 6, maxGenerations: 3 }, recovery: { required: false },
  };
}

test('notebook source preview preserves whitespace and execution starts unselected', () => {
  const html = render({ job: draftJob() });
  assert.ok(html.includes('if x &lt; 2:\n\tprint(&quot;0&quot;)\n'));
  assert.doesNotMatch(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<button[^>]*disabled[^>]*>Run selected cells<\/button>/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Apply draft<\/button>/);
});

test('coding with an unverified insertion path exposes the preview without enabled Apply', () => {
  const job = draftJob();
  job.snapshot = { ...job.snapshot, kind: 'code', capabilities: { generate: true, apply: false, run: false, save: false } };
  const html = render({ job });
  assert.match(html, /Coding preview only/);
  assert.match(html, /<button[^>]*disabled[^>]*>Apply draft<\/button>/);
  assert.doesNotMatch(html, /Run selected cells/);
  assert.ok(html.includes('Proposed replacement'));
});

test('an applied draft cannot be applied a second time from its controls', () => {
  const html = render({ job: { ...draftJob(), phase: 'applied', appliedTargetIds: ['cell-1'], canRestore: true } });
  assert.match(html, /<button[^>]*disabled[^>]*>Apply draft<\/button>/);
  assert.match(html, /already been applied/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Restore original<\/button>/);
});

test('recovery blocks Apply and surfaces an explicit reconciliation action', () => {
  const html = render({ job: { ...draftJob(), phase: 'needs_reconciliation', recovery: { required: true, message: 'Check the retained job.' } } });
  assert.match(html, /Check recovery/);
  assert.match(html, /Check the retained job/);
  assert.match(html, /<button[^>]*disabled[^>]*>Apply draft<\/button>/);
});

test('unknown usage stays distinguishable from zero reported tokens', () => {
  const job = draftJob();
  job.usage.unknownUsage = 1;
  const html = render({ job });
  assert.match(html, /Tokens recorded<\/dt><dd>0<\/dd>/);
  assert.match(html, /token count is incomplete/);
});

test('running jobs retain Stop while other assignment actions are disabled', () => {
  const html = render({ job: { ...draftJob(), phase: 'running' }, busy: true });
  assert.match(html, /class="assignment-stop"/);
  assert.doesNotMatch(html, /class="assignment-stop"[^>]*disabled/);
  assert.match(html, /<button[^>]*disabled[^>]*>Apply draft<\/button>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Save notebook<\/button>/);
});

test('a workspace offers single solve before inspection and explains where batch solving starts', () => {
  const html = render({ onBatchAction() {}, settings: { model: 'test-model', maxTokens: 2048 } });
  assert.match(html, /Solve this assignment/);
  assert.match(html, /Solve unfinished assignments/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Solve this assignment/);
  assert.match(html, /<button[^>]*disabled[^>]*>Solve unfinished assignments/);
  assert.match(html, /Open the course All Assignments catalog to start a batch/);
  assert.match(html, /Shared assignment settings/);
  assert.match(html, /value="test-model"/);
  assert.match(html, /<details class="assignment-manual"><summary>Manual controls/);
});

test('batch results preserve distinct portal outcomes and count a skip only once', () => {
  const results = [
    { key: 'a', title: 'Exercise A', status: 'accepted' },
    { key: 'b', title: 'Exercise B', status: 'submitted', reason: 'Grading is pending.' },
    { key: 'c', title: 'Exercise C', status: 'failed', reason: 'Runtime check failed.' },
    { key: 'd', title: 'Exercise D', status: 'skipped', reason: 'Unsupported runtime.' },
    { key: 'e', title: 'Exercise E', status: 'unknown', reason: 'Portal result was not observed.' },
  ];
  const html = render({ batch: { phase: 'completed', items: results, results, skipped: [results[3]] }, onBatchAction() {} });
  assert.match(html, /5 of 5 assignments recorded/);
  assert.match(html, /max="5" value="5"/);
  for (const status of ['Accepted', 'Submitted', 'Failed', 'Skipped', 'Unknown']) {
    assert.ok(html.includes(`${status} <b>1</b>`));
  }
  assert.equal((html.match(/Exercise D/g) || []).length, 1);
  assert.match(html, /Grading is pending/);
  assert.match(html, /Accepted is shown only when the portal reports acceptance/);
  assert.doesNotMatch(html, /all assignments (?:solved|succeeded)/i);
});

test('active batches retain their own Stop and lock single/manual actions', () => {
  const html = render({
    job: { ...draftJob(), phase: 'running' }, busy: true, onBatchAction() {},
    batch: { phase: 'solving', items: [{ key: 'a', title: 'Current notebook' }], activeItemKey: 'a', results: [] },
  });
  assert.match(html, /Current notebook/);
  assert.match(html, /Stop batch/);
  assert.doesNotMatch(html, /class="assignment-stop"[^>]*disabled/);
  assert.equal((html.match(/class="assignment-stop"/g) || []).length, 1);
  assert.match(html, /<button[^>]*disabled[^>]*>Solve this assignment/);
  assert.match(html, /<button[^>]*disabled[^>]*>Solve unfinished assignments/);
  assert.match(html, /<button[^>]*disabled[^>]*>Apply draft/);
});

test('submission is an active stoppable phase and acceptance is a separate final state', () => {
  const submitting = render({ job: { ...draftJob(), phase: 'submitting' }, busy: true });
  assert.match(submitting, /Submitting assignment/);
  assert.match(submitting, /class="assignment-stop"/);
  const submitted = render({ job: { ...draftJob(), phase: 'submitted' } });
  assert.match(submitted, /Submission acknowledged/);
  assert.doesNotMatch(submitted, /Accepted by portal/);
  const accepted = render({ job: { ...draftJob(), phase: 'accepted' } });
  assert.match(accepted, /Accepted by portal/);
});

test('batch recovery explains uncertainty without representing it as acceptance', () => {
  const html = render({ batch: {
    phase: 'needs_reconciliation', results: [{ key: 'a', title: 'Exercise A', status: 'unknown' }],
    recovery: { required: true, message: 'Inspect the pending submission before restarting.' },
  }, onBatchAction() {} });
  assert.match(html, /Batch recovery needed/);
  assert.match(html, /Inspect the pending submission before restarting/);
  assert.match(html, /Unknown <b>1<\/b>/);
  assert.doesNotMatch(html, /Accepted <b>/);
  assert.match(html, /<button[^>]*disabled[^>]*>Solve unfinished assignments/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Reconcile batch/);
  assert.match(html, /It does not repeat submission/);
});

test('single solve remains stoppable between individual execution phases', () => {
  const html = render({ job: { ...draftJob(), phase: 'ready' }, busy: true, operationBusy: true });
  assert.match(html, /Ready for submission/);
  assert.match(html, /class="assignment-stop"/);
  assert.doesNotMatch(html, /class="assignment-stop"[^>]*disabled/);
});

test('submission feedback preserves pending grading without claiming acceptance', () => {
  const html = render({ job: { ...draftJob(), phase: 'submitted', submission: {
    status: 'submitted', reason: 'Portal acknowledged the upload; grading is pending.', feedback: 'Queued\nPlease wait.',
  } } });
  assert.match(html, /aria-label="Portal submission result"/);
  assert.match(html, /grading is pending/);
  assert.match(html, /Queued\nPlease wait/);
  assert.doesNotMatch(html, /Accepted by portal/);
});

test('batch progress excludes cards completed before the batch and keeps outcomes after rescanning', () => {
  const html = render({ onBatchAction() {}, batch: {
    phase: 'solving', activeItemKey: 'remaining',
    items: [
      { key: 'old', title: 'Previously completed', status: 'completed' },
      { key: 'new', title: 'Completed by this batch', status: 'completed' },
      { key: 'remaining', title: 'Remaining work', status: 'unfinished' },
    ],
    results: [{ key: 'new', title: 'Completed by this batch', status: 'accepted' }],
  } });
  assert.match(html, /1 of 2 assignments recorded/);
  assert.match(html, /max="2" value="1"/);
  assert.doesNotMatch(html, /1 of 3 assignments/);
});

test('the catalog promotes batch solving and does not offer the single assignment detector', () => {
  const html = render({ activeTabUrl: 'https://my.newtonschool.co/course/course-1/all_assignments?page=2', onBatchAction() {} });
  assert.match(html, /All Assignments catalog/);
  assert.match(html, /<button class="[^"]*assignment-button-primary[^"]*is-catalog-primary"[^>]*>Solve unfinished assignments/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>Solve unfinished assignments/);
  assert.doesNotMatch(html, /<button[^>]*>Solve this assignment/);
  assert.doesNotMatch(html, /<button class="[^"]*assignment-inspect/);
  assert.match(html, /Open a coding assignment or notebook from the catalog/);
});

test('unknown and other pages offer navigation guidance instead of enabled assignment actions', () => {
  for (const activeTabUrl of [undefined, 'https://example.com', 'https://my.newtonschool.co/course/course-1']) {
    const html = render({ activeTabUrl, onBatchAction() {} });
    assert.match(html, /<button[^>]*disabled[^>]*>Solve this assignment/);
    assert.match(html, /<button[^>]*disabled[^>]*>Solve unfinished assignments/);
    assert.doesNotMatch(html, /<button class="[^"]*assignment-inspect/);
    assert.match(html, /All Assignments catalog/);
  }
});

test('an empty failed or unfinished scan never claims the catalog has no unfinished assignments', () => {
  for (const batch of [
    { phase: 'needs_attention', error: 'The catalog could not be inspected.' },
    { phase: 'scanning' }, { phase: 'paging' }, { phase: 'stopped' },
    { phase: 'completed', error: 'A retained scan error.' },
  ]) {
    const html = render({ batch: { items: [], results: [], ...batch } });
    assert.doesNotMatch(html, /No unfinished assignments/);
  }
  assert.match(render({ batch: { phase: 'scanning', items: [], results: [] } }), /counts are not available yet/);
  assert.match(render({ batch: { phase: 'needs_attention', error: 'Scan failed', items: [] } }), /count could not be confirmed/);
});

test('only a completed successful empty scan reports no unfinished assignments', () => {
  const html = render({ batch: { phase: 'completed', items: [], results: [] } });
  assert.match(html, /No unfinished assignments found in the scanned catalog/);
});
