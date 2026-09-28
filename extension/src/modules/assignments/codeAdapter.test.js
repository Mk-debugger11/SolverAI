import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { codeAdapter } from './codeAdapter.js';

async function fixture({ language = 'python', runtime = 'Python 3.11', registry = true, sourceRole = 'source', sameLanguageOther = false } = {}) {
  const warnings = [];
  const statuses = [];
  const edits = [];
  const nodes = [];
  const visible = (text = '') => ({ innerText: text, textContent: text, getClientRects: () => [{}], getAttribute: () => null });
  function model(id, source, mode, role, readOnly = false) {
    const input = { readOnly, getAttribute: (name) => name === 'aria-readonly' ? String(readOnly) : null };
    const node = { ...visible(), children: [],
      getAttribute: (name) => ({ 'data-editor-role': role, 'data-model-uri': id, 'data-mode-id': mode }[name] ?? null),
      querySelector: () => input,
    };
    nodes.push(node);
    const value = { source, version: 1, mode, readOnly, node, uri: { toString: () => id },
      getValue() { return this.source; }, getLanguageId() { return this.mode; }, getVersionId() { return this.version; },
      getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 }),
      isAttachedToEditor: () => true, pushStackElement() { edits.push('undo'); },
      pushEditOperations(_selection, changes) { edits.push('model'); this.set(changes[0].text); },
      set(text) { this.source = text; this.version++; },
    };
    value.editor = { getModel: () => value, getDomNode: () => node, getOption: () => value.readOnly,
      pushUndoStop() { edits.push('undo'); }, executeEdits(origin, changes) {
        edits.push(origin); value.set(changes[0].text); value.afterEdit?.(); return true;
      } };
    return value;
  }
  const source = model('file:///source', 'starter', language, sourceRole);
  const stdin = model('file:///stdin', '2', sameLanguageOther ? language : 'plaintext', 'input');
  const output = model('file:///stdout', 'old output', 'plaintext', 'output', true);
  const error = model('file:///stderr', '', 'plaintext', 'error', true);
  const expected = model('file:///expected', '4', 'plaintext', 'expected', true);
  const models = [stdin, output, source, expected, error];
  const run = { ...visible('Run'), disabled: false, isConnected: true, clicks: 0,
    click() { this.clicks++; this.disabled = true; } };
  const buttons = [run, { ...visible('Submit'), click() { throw new Error('Submit must not be called by this adapter'); } }];
  const selector = { selectedOptions: [{ textContent: runtime }] };
  const statement = { innerText: 'Read a number and print twice its value.' };
  const document = {
    title: 'Double the input', body: { innerText: `QUESTION\nRead a number and print twice its value.\n${runtime}` },
    querySelector(query) {
      if (query.includes('runtime-selector')) return selector;
      if (query.includes('problem-statement')) return statement;
      return null;
    },
    querySelectorAll(query) {
      if (query === '.monaco-editor') return nodes;
      if (query.startsWith('button,')) return buttons;
      if (query.includes('[role="dialog"]')) return warnings;
      if (query.includes('run-status')) return statuses;
      return [];
    },
  };
  const monaco = { editor: { getModels: () => models, EditorOption: { readOnly: 91 },
    ...(registry ? { getEditors: () => models.map((model) => model.editor) } : {}) } };
  const page = vm.createContext({ window: { monaco }, document,
    location: new URL('https://my.newtonschool.co/playground/code/task'), performance: { timeOrigin: 10 },
    URL, Date, crypto, TextEncoder, queueMicrotask,
    setTimeout: (callback, ms) => setTimeout(callback, ms === 100 ? 0 : ms), clearTimeout,
  });
  const context = { kind: 'code', problemId: 'task', documentId: 'doc', outerDocumentId: 'doc', tabId: 1,
    url: 'https://my.newtonschool.co/playground/code/task', documentToken: 'https://my.newtonschool.co/playground/code/task::10' };
  const calls = [];
  const chrome = { scripting: { async executeScript({ func, args = [] }) {
    calls.push(func.name);
    chrome.beforeInjection?.(func.name);
    const execute = vm.runInContext(`(${func.toString()})`, page);
    return [{ documentId: 'doc', frameId: 0, result: await execute(...structuredClone(args)) }];
  } } };
  globalThis.chrome = chrome;
  const snapshot = await codeAdapter.readSnapshot(context);
  return { context, snapshot, source, stdin, output, error, expected, run, buttons, models, nodes, edits, warnings, statuses, selector, statement, page, chrome, calls,
    warning(text = 'Pasting code requires attention') { warnings.push(visible(text)); },
    complete(text = '4', errorText = '') { output.set(text); error.set(errorText); run.disabled = false; },
    edit(content = 'print(int(input()) * 2)') { return { targetId: source.uri.toString(), baseSourceHash: snapshot.targets.find((target) => target.editable).sourceHash, content }; },
  };
}

for (const [language, runtime] of [['python', 'Python 3.11'], ['mips', 'MIPS (Mars 4.5)'], ['verilog', 'Verilog (Icarus 13.0)'], ['cpp', 'C++ (GCC 13)'], ['java', 'Java (OpenJDK 21)']]) {
  test(`selects the declared ${language} source without confusing I/O editors`, async () => {
    const f = await fixture({ language, runtime });
    assert.equal(f.snapshot.sourceTargetId, 'file:///source');
    assert.equal(f.snapshot.runtime.language, language);
    assert.equal(f.snapshot.runtime.label, runtime);
    assert.equal(f.snapshot.capabilities.apply, true);
    assert.equal(f.snapshot.capabilities.run, true);
    assert.equal(f.snapshot.targets.filter((target) => target.editable).length, 1);
    assert.ok(!f.snapshot.targets.some((target) => target.roleHint === 'output' || target.roleHint === 'error'));
    assert.equal(f.snapshot.targets.find((target) => target.roleHint === 'input').source, '2');
  });
}

test('a unique verified language model can be selected without a source-role attribute', async () => {
  const f = await fixture({ sourceRole: '', sameLanguageOther: true });
  assert.equal(f.snapshot.sourceTargetId, 'file:///source');
  assert.equal(f.snapshot.capabilities.apply, true);
});

test('MIPS plaintext source is recognized by a unique observed assembly starter shape', async () => {
  const f = await fixture({ language: 'plaintext', runtime: 'MIPS (Mars 4.5)', sourceRole: '' });
  f.source.set('.data\neven: .asciiz "even"\n.text\n.globl main\nmain:\n# Your code here');
  const snapshot = await codeAdapter.readSnapshot(f.context);
  assert.equal(snapshot.sourceTargetId, 'file:///source');
  assert.equal(snapshot.capabilities.apply, true);
  f.source.set('2');
  assert.equal((await codeAdapter.readSnapshot(f.context)).sourceTargetId, null);
});

test('two unlabeled writable language models require an explicit source choice', async () => {
  const f = await fixture({ sourceRole: '' });
  f.stdin.mode = 'python';
  f.stdin.node.getAttribute = () => null;
  const ambiguous = await codeAdapter.readSnapshot(f.context);
  assert.equal(ambiguous.capabilities.generate, false);
  assert.equal(ambiguous.sourceTargetId, null);
  const selected = await codeAdapter.readSnapshot({ ...f.context, sourceTargetId: 'file:///source' });
  assert.equal(selected.capabilities.apply, true);
});

test('native editor edits preserve stdin, test data and undo boundaries', async () => {
  const f = await fixture();
  const edit = f.edit();
  const result = await codeAdapter.applyEdits(f.context, f.snapshot, [edit]);
  assert.equal(result.success, true);
  assert.equal(f.source.source, edit.content);
  assert.equal(f.stdin.source, '2');
  assert.equal(f.expected.source, '4');
  assert.deepEqual(f.edits, ['undo', 'SolverAI', 'undo']);
  assert.deepEqual(Array.from(result.appliedEdits, (entry) => entry.content), [edit.content]);
  const restored = await codeAdapter.restoreEdits(f.context, f.snapshot, [edit]);
  assert.equal(restored.success, true);
  assert.equal(f.source.source, 'starter');
});

test('builds without getEditors use only an associated writable native model', async () => {
  const f = await fixture({ registry: false });
  assert.equal(f.snapshot.capabilities.apply, true);
  assert.equal((await codeAdapter.applyEdits(f.context, f.snapshot, [f.edit()])).success, true);
  assert.deepEqual(f.edits, ['undo', 'model', 'undo']);
  f.source.node.querySelector = () => ({ readOnly: true, getAttribute: () => 'true' });
  const locked = await codeAdapter.readSnapshot(f.context);
  assert.equal(locked.capabilities.apply, false);
});

test('source/hash/runtime/dependency changes prevent all edits', async () => {
  for (const change of ['source', 'hash', 'runtime', 'input']) {
    const f = await fixture();
    const edit = f.edit();
    if (change === 'source') f.source.set('manual work');
    if (change === 'hash') edit.baseSourceHash = 'bad';
    if (change === 'runtime') f.selector.selectedOptions[0].textContent = 'Python 2.7';
    if (change === 'input') f.stdin.set('different test');
    const result = await codeAdapter.applyEdits(f.context, f.snapshot, [edit]);
    assert.equal(result.success, false);
    assert.equal(f.edits.length, 0);
  }
});

test('visible warnings block editing and are never dismissed', async () => {
  const f = await fixture();
  f.warning();
  const result = await codeAdapter.applyEdits(f.context, f.snapshot, [f.edit()]);
  assert.equal(result.success, false);
  assert.equal(f.edits.length, 0);
  assert.equal(f.warnings.length, 1);
});

test('a warning raised by the native edit stops the operation and records actual changed source', async () => {
  const f = await fixture();
  f.source.afterEdit = () => f.warning();
  const result = await codeAdapter.applyEdits(f.context, f.snapshot, [f.edit()]);
  assert.equal(result.status, 'partial');
  assert.equal(result.appliedEdits[0].content, f.source.source);
  assert.equal(f.run.clicks, 0);
});

test('later manual text is not attributed to the native edit or overwritten on restore', async () => {
  const f = await fixture();
  const edit = f.edit();
  f.source.afterEdit = () => queueMicrotask(() => f.source.set('manual text after insertion'));
  const result = await codeAdapter.applyEdits(f.context, f.snapshot, [edit]);
  assert.equal(result.status, 'partial');
  assert.equal(result.appliedEdits[0].content, edit.content);
  assert.equal(f.source.source, 'manual text after insertion');
  assert.equal((await codeAdapter.restoreEdits(f.context, f.snapshot, result.appliedEdits)).success, false);
  assert.equal(f.source.source, 'manual text after insertion');
});

test('run IDs deduplicate clicks and only fresh run output completes', async () => {
  const f = await fixture();
  const started = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' });
  assert.equal(started.status, 'running');
  assert.equal((await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' })).deduplicated, true);
  assert.equal(f.run.clicks, 1);
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'running');
  f.complete();
  const result = await codeAdapter.pollExecution(f.context, started.execution);
  assert.equal(result.status, 'completed');
  assert.equal(result.success, true);
  assert.equal(result.results[0].output, '4');
  assert.equal(result.checksPassed, null);
});

test('old successful output and old accepted status cannot pass a new run', async () => {
  const f = await fixture();
  f.statuses.push({ innerText: 'Accepted', getClientRects: () => [{}], getAttribute: () => null });
  const started = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' });
  f.run.disabled = false;
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'running');
  f.complete();
  const fresh = await codeAdapter.pollExecution(f.context, started.execution);
  assert.equal(fresh.success, true);
  assert.equal(fresh.checksPassed, null);
});

test('fresh compiler/runtime error is reported as failed with bounded visible feedback', async () => {
  const f = await fixture();
  const started = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' });
  f.complete('', 'SyntaxError: invalid syntax');
  const result = await codeAdapter.pollExecution(f.context, started.execution);
  assert.equal(result.status, 'failed');
  assert.equal(result.success, false);
  assert.match(result.results[0].error, /SyntaxError/);
});

test('stale errors stay unknown until refreshed, while benign result alerts do not block recovery', async () => {
  const f = await fixture();
  f.error.set('old compiler error');
  const started = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' });
  f.output.set('4'); f.run.disabled = false;
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'unknown');
  f.error.set('');
  f.warnings.push({ innerText: 'Run successful', getClientRects: () => [{}], getAttribute: (name) => name === 'role' ? 'alert' : null });
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'completed');
});

test('a transient warning requires attention but a later explicit poll can reconcile the original run', async () => {
  const f = await fixture();
  const started = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' });
  f.warning(); f.complete();
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'unknown');
  f.warnings.length = 0;
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'completed');
  assert.equal(f.run.clicks, 1);
});

test('manual source changes and visible warnings invalidate pending run outcomes', async () => {
  const f = await fixture();
  const started = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1' });
  f.source.set('manual replacement'); f.complete();
  assert.equal((await codeAdapter.pollExecution(f.context, started.execution)).status, 'unknown');
  const another = await fixture();
  const run = await codeAdapter.startExecution(another.context, another.snapshot, { runId: 'run1' });
  another.warning(); another.complete();
  assert.equal((await codeAdapter.pollExecution(another.context, run.execution)).status, 'unknown');
});

test('cancellation before dispatch, including during outer validation, prevents a Run click', async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.chrome.beforeInjection = (name) => { if (name === 'readAssignmentPageData') controller.abort(); };
  const result = await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'run1', signal: controller.signal });
  assert.equal(result.status, 'stopped');
  assert.equal(f.run.clicks, 0);
});

test('runChecks preserves an attributable pending run after Stop and permits later polling', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const result = await codeAdapter.runChecks(f.context, f.snapshot, { signal: controller.signal,
    onExecution: (execution) => { if (execution.status === 'running') controller.abort(); } });
  assert.equal(result.status, 'unknown');
  assert.equal(f.run.clicks, 1);
  assert.equal((await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'new-run' })).status, 'unknown');
  f.complete();
  assert.equal((await codeAdapter.pollExecution(f.context, result.execution)).status, 'completed');
});

test('Run fails closed with multiple controls and ready does not claim server persistence', async () => {
  const f = await fixture();
  const ready = await codeAdapter.save(f.context, f.snapshot);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.saved, false);
  f.buttons.push({ innerText: 'Run', getClientRects: () => [{}], getAttribute: () => null, click() { throw new Error('Must not click an ambiguous Run'); } });
  assert.equal((await codeAdapter.readSnapshot(f.context)).capabilities.run, false);
  assert.equal((await codeAdapter.startExecution(f.context, f.snapshot, { runId: 'ambiguous' })).status, 'unsupported');
  assert.equal(f.run.clicks, 0);
  f.statement.innerText = '';
  assert.equal((await codeAdapter.readSnapshot(f.context)).capabilities.generate, false);
});
