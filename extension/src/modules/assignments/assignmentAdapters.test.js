import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { detectAssignment, hashSource } from './assignmentDetector.js';
import { codeAdapter } from './codeAdapter.js';
import { notebookAdapter } from './notebookAdapter.js';

const notebookUrl = 'https://task.edison-jupyter.newtonschool.co/notebooks/Assignment.ipynb';

function surface(url, window = {}, { statement = 'Complete the declared functions.', frames = [], warnings = [] } = {}) {
  const location = new URL(url);
  const document = {
    title: 'Assignment', body: { innerText: statement },
    querySelector(selector) {
      if (selector.includes('[data-testid="problem-statement"]')) return { innerText: this.body.innerText };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'iframe[src]') return frames.map((src) => ({ src }));
      if (selector.includes('[role="dialog"]')) return warnings.map((innerText) => ({ innerText, getClientRects: () => [{}] }));
      return [];
    },
  };
  return vm.createContext({ window, document, location, performance: { timeOrigin: 10 },
    setTimeout, clearTimeout, console, URL, Date, crypto });
}

function installChrome(surfaces) {
  const calls = [];
  globalThis.chrome = { scripting: { async executeScript({ target, func, args = [] }) {
    calls.push(target);
    const selected = target.allFrames ? surfaces : surfaces.filter((item) => target.documentIds
      ? target.documentIds.includes(item.documentId) : (target.frameIds || [0]).includes(item.frameId));
    if (!selected.length) throw new Error('Document no longer exists');
    const results = [];
    for (const item of selected) {
      // Serializing the function catches accidental closures in injected code.
      const run = vm.runInContext(`(${func.toString()})`, item.context);
      results.push({ frameId: item.frameId, documentId: item.documentId, result: await run(...structuredClone(args)) });
    }
    return results;
  } } };
  return calls;
}

function cell(id, source, type = 'code', metadata = {}) {
  return {
    cell_id: id, cell_type: type, source, metadata, last_msg_id: null, input_prompt_number: null,
    output_area: { outputs: [] },
    get_text() { return this.source; },
    set_text(value) { this.source = value; },
    execute() { this.last_msg_id = `request-${id}`; this.input_prompt_number = '*'; this.output_area.outputs = []; },
  };
}

async function notebookFixture({ classicStatus } = {}) {
  const cells = [cell('instructions', '# Task', 'markdown'), cell('setup', 'x = 1'), cell('answer', 'result = None'),
    cell('tests', 'assert result == 2', 'code', { nbgrader: { grade: true } })];
  const listeners = [];
  const notebook = {
    notebook_path: 'Assignment.ipynb', notebook_name: 'Assignment.ipynb', dirty: false,
    metadata: { kernelspec: { language: 'python', display_name: 'Python 3' }, language_info: { version: '3.11.8' } },
    kernel: { id: 'kernel-1', name: 'python3', status: 'idle', is_connected: () => true }, session: { id: 'session-1' },
    events: { on(names, callback) { listeners.push({ names: names.split(' '), callback }); } },
    get_cells: () => cells,
    set_dirty(value) { this.dirty = value; },
    save_notebook() { this.dirty = false; return Promise.resolve({}); },
  };
  const top = surface('https://my.newtonschool.co/playground/newton-box/problem-1', {}, { frames: [notebookUrl] });
  const frame = surface(notebookUrl, { Jupyter: { notebook } });
  if (classicStatus !== undefined) {
    delete notebook.kernel.status;
    frame.document.querySelector = (selector) => selector === '#kernel_indicator_icon' ? {
      getClientRects: () => [{}], classList: { contains: (name) => name === `kernel_${classicStatus}_icon` },
    } : null;
  }
  const emit = (name) => listeners.filter((listener) => listener.names.includes(name)).forEach(({ callback }) => callback({ type: name }));
  const calls = installChrome([{ frameId: 0, documentId: 'outer-doc', context: top }, { frameId: 7, documentId: 'notebook-doc', context: frame }]);
  const context = await detectAssignment(4);
  const snapshot = await notebookAdapter.readSnapshot(context);
  return { notebook, cells, top, frame, context, snapshot, calls,
    emit,
    restart() { emit('kernel_restarting.Kernel'); emit('kernel_idle.Kernel'); },
    edit(targetId = 'answer', content = 'result = x + 1') {
      return { targetId, baseSourceHash: snapshot.targets.find((target) => target.targetId === targetId).sourceHash, content };
    },
  };
}

test('detector rejects lookalike hosts and ambiguous notebook frames', async () => {
  installChrome([{ frameId: 0, documentId: 'top', context: surface('https://example.com/playground/code/task') }]);
  assert.equal((await detectAssignment(4)).kind, 'unsupported');
  assert.ok((await detectAssignment(4)).reasons[0]);
  const f = await notebookFixture();
  installChrome([{ frameId: 0, documentId: 'outer-doc', context: f.top },
    { frameId: 7, documentId: 'a', context: f.frame }, { frameId: 8, documentId: 'b', context: f.frame }]);
  assert.equal((await detectAssignment(4)).kind, 'unsupported');
});

test('classic Jupyter without kernel.status uses its initial indicator and subsequent status events', async () => {
  const f = await notebookFixture({ classicStatus: 'idle' });
  assert.equal(f.notebook.kernel.status, undefined);
  assert.equal(f.snapshot.kernelStatus, 'idle');
  assert.equal(f.snapshot.capabilities.run, true);
  const started = await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'classic' });
  assert.equal(started.status, 'running');
  f.emit('kernel_busy.Kernel');
  f.cells[2].input_prompt_number = 1;
  assert.equal((await notebookAdapter.pollExecution(f.context, started.execution)).status, 'running');
  f.emit('kernel_idle.Kernel');
  assert.equal((await notebookAdapter.pollExecution(f.context, started.execution)).status, 'completed');
  assert.equal((await notebookAdapter.save(f.context, f.snapshot)).status, 'saved');
});

test('classic unknown, busy and disconnected states do not dispatch or save', async () => {
  const f = await notebookFixture({ classicStatus: 'unknown' });
  let dispatches = 0;
  let saves = 0;
  f.cells[2].execute = () => { dispatches++; };
  f.notebook.save_notebook = () => { saves++; return Promise.resolve(); };
  assert.equal(f.snapshot.kernelStatus, 'unknown');
  assert.equal(f.snapshot.capabilities.run, false);
  assert.equal((await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'unknown' })).success, false);
  assert.equal((await notebookAdapter.save(f.context, f.snapshot)).success, false);
  f.emit('kernel_busy.Kernel');
  assert.equal((await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'busy' })).status, 'needs_attention');
  f.emit('kernel_idle.Kernel');
  f.emit('kernel_disconnected.Kernel');
  assert.equal((await notebookAdapter.readSnapshot(f.context)).kernelStatus, 'unknown');
  assert.equal((await notebookAdapter.save(f.context, f.snapshot)).success, false);
  assert.equal(dispatches, 0);
  assert.equal(saves, 0);
});

test('notebook snapshots use exact SHA256 source and ignore execution in contextHash', async () => {
  const f = await notebookFixture();
  assert.equal(f.context.frameId, 7);
  assert.equal(f.snapshot.targets[2].sourceHash, await hashSource('result = None'));
  f.cells[1].input_prompt_number = 8;
  f.cells[1].output_area.outputs = [{ output_type: 'stream', text: 'old output' }];
  const again = await notebookAdapter.readSnapshot(f.context);
  assert.equal(again.contextHash, f.snapshot.contextHash);
  assert.equal(again.targets[0].editable, false);
  assert.equal(again.targets[3].editable, false);
  assert.deepEqual(again.runtime, f.snapshot.runtime);
});

test('all notebook edits preflight before writing and protected cells stay unchanged', async () => {
  const f = await notebookFixture();
  const result = await notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit(), f.edit('tests', 'pass')]);
  assert.equal(result.success, false);
  assert.equal(f.cells[2].source, 'result = None');
  assert.equal(f.cells[3].source, 'assert result == 2');
});

for (const [name, mutate] of [
  ['manual target edit', (f) => { f.cells[2].source = 'manual = 9'; }],
  ['dependency edit', (f) => { f.cells[1].source = 'x = 9'; }],
  ['reordered cells', (f) => { [f.cells[1], f.cells[2]] = [f.cells[2], f.cells[1]]; }],
  ['runtime change', (f) => { f.notebook.metadata.kernelspec.display_name = 'Python 2'; }],
  ['kernel restart', (f) => f.restart()],
]) {
  test(`guarded edits reject ${name}`, async () => {
    const f = await notebookFixture();
    mutate(f);
    const result = await notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit()]);
    assert.equal(result.status, 'conflict');
    assert.equal(result.changedTargetIds.length, 0);
  });
}

test('outer SPA navigation blocks mutation in a reused notebook frame', async () => {
  const f = await notebookFixture();
  f.top.location = new URL('https://my.newtonschool.co/playground/newton-box/other-problem');
  await assert.rejects(notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit()]), /outer assignment/);
  assert.equal(f.cells[2].source, 'result = None');
});

test('instruction changes at the same outer URL are refreshed on read and block stale writes', async () => {
  const f = await notebookFixture();
  f.top.document.body.innerText = 'A changed assignment instruction';
  const fresh = await notebookAdapter.readSnapshot(f.context);
  assert.equal(fresh.statement, 'A changed assignment instruction');
  await assert.rejects(notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit()]), /instructions changed/);
  assert.equal(f.cells[2].source, 'result = None');
});

test('partial writes are reported exactly and restore refuses later manual edits', async () => {
  const f = await notebookFixture();
  f.cells[2].set_text = function () { this.source = 'partial'; throw new Error('editor failed'); };
  const applied = await notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit('setup', 'x = 2'), f.edit()]);
  assert.equal(applied.status, 'partial');
  assert.equal(applied.changedTargetIds.join(','), 'setup,answer');
  assert.equal(applied.appliedEdits[1].content, 'partial');
  f.cells[2].set_text = function (content) { this.source = content; };
  f.cells[1].source = 'x = user_change';
  const conflict = await notebookAdapter.restoreEdits(f.context, f.snapshot, applied.appliedEdits);
  assert.equal(conflict.status, 'conflict');
  assert.equal(f.cells[1].source, 'x = user_change');
  f.cells[1].source = 'x = 2';
  const restored = await notebookAdapter.restoreEdits(f.context, f.snapshot, applied.appliedEdits);
  assert.equal(restored.success, true);
  assert.equal(f.cells[1].source, 'x = 1');
  assert.equal(f.cells[2].source, 'result = None');
});

test('execution IDs deduplicate starts and only fresh cell completion succeeds', async () => {
  const f = await notebookFixture();
  let dispatches = 0;
  f.cells[2].execute = function () { dispatches++; this.last_msg_id = 'new-request'; this.input_prompt_number = '*'; this.output_area.outputs = []; };
  const start = await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'job:1' });
  await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'job:1' });
  assert.equal(dispatches, 1);
  assert.equal((await notebookAdapter.pollExecution(f.context, start.execution)).status, 'running');
  f.cells[2].input_prompt_number = 1;
  f.cells[2].output_area.outputs = [{ output_type: 'stream', text: '2\n' }];
  const complete = await notebookAdapter.pollExecution(f.context, start.execution);
  assert.equal(complete.status, 'completed');
  assert.equal(complete.success, true);
  assert.equal(complete.checksPassed, null);
  assert.equal(complete.outputs[0].text, '2\n');
});

test('an error after the displayed output limit is still a failed execution', async () => {
  const f = await notebookFixture();
  const start = await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'late-error' });
  f.cells[2].input_prompt_number = 1;
  f.cells[2].output_area.outputs = [
    ...Array.from({ length: 101 }, () => ({ output_type: 'display_data', data: { 'text/plain': 'progress' } })),
    { output_type: 'error', ename: 'AssertionError', evalue: 'check failed', traceback: ['check failed'] },
  ];
  const result = await notebookAdapter.pollExecution(f.context, start.execution);
  assert.equal(result.success, false);
  assert.equal(result.outcome, 'runtime_error');
  assert.equal(result.errors[0].message, 'check failed');
});

test('old successful outputs and kernel restart never become a passing run', async () => {
  const f = await notebookFixture();
  f.cells[2].output_area.outputs = [{ output_type: 'stream', text: 'All tests passed' }];
  f.cells[2].execute = function () { this.last_msg_id = 'new-request'; this.input_prompt_number = '*'; };
  const start = await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'job:2' });
  f.cells[2].input_prompt_number = 1;
  assert.equal((await notebookAdapter.pollExecution(f.context, start.execution)).status, 'unknown');
  f.restart();
  assert.equal((await notebookAdapter.pollExecution(f.context, start.execution)).status, 'unknown');
});

test('run preflight rejects undeclared later cells before executing the first one', async () => {
  const f = await notebookFixture();
  let dispatches = 0;
  f.cells[1].execute = () => { dispatches++; };
  const result = await notebookAdapter.runChecks(f.context, f.snapshot, { targetIds: ['setup', 'unknown'] });
  assert.equal(result.success, false);
  assert.equal(dispatches, 0);
});

test('Stop after execution checkpoint prevents dispatch', async () => {
  const f = await notebookFixture();
  let dispatches = 0;
  f.cells[1].execute = () => { dispatches++; };
  const controller = new AbortController();
  const result = await notebookAdapter.runChecks(f.context, f.snapshot, {
    targetIds: ['setup'], signal: controller.signal, onExecution: () => controller.abort(),
  });
  assert.equal(result.status, 'stopped');
  assert.equal(dispatches, 0);
});

test('unknown execution blocks another start until the request is reconciled', async () => {
  const f = await notebookFixture();
  const result = await notebookAdapter.runChecks(f.context, f.snapshot, { targetIds: ['setup'], timeoutMs: 1 });
  assert.equal(result.status, 'unknown');
  assert.equal((await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'answer', runId: 'second' })).status, 'unknown');
  f.cells[1].input_prompt_number = 1;
  assert.equal((await notebookAdapter.pollExecution(f.context, result.execution)).status, 'completed');
});

test('a verified kernel restart permits a new explicitly requested execution after reinspection', async () => {
  const f = await notebookFixture();
  const old = await notebookAdapter.startExecution(f.context, f.snapshot, { targetId: 'setup', runId: 'old-kernel' });
  f.restart();
  f.cells[1].input_prompt_number = null;
  const fresh = await notebookAdapter.readSnapshot(f.context);
  assert.equal((await notebookAdapter.pollExecution(f.context, old.execution)).status, 'unknown');
  const started = await notebookAdapter.startExecution(f.context, fresh, { targetId: 'answer', runId: 'new-kernel' });
  assert.equal(started.status, 'running');
});

test('runChecks follows cell order, records completion checkpoints, and reports a fresh error', async () => {
  const f = await notebookFixture();
  const order = [];
  const checkpoints = [];
  const result = await notebookAdapter.runChecks(f.context, f.snapshot, {
    targetIds: ['answer', 'setup'],
    onExecution(record) {
      checkpoints.push(record);
      if (record.status !== 'running') return;
      order.push(record.targetId);
      const target = f.cells.find((candidate) => candidate.cell_id === record.targetId);
      target.input_prompt_number = order.length;
      if (record.targetId === 'answer') target.output_area.outputs = [{ output_type: 'error', ename: 'AssertionError', evalue: 'wrong result', traceback: ['AssertionError: wrong result'] }];
    },
  });
  assert.deepEqual(order, ['setup', 'answer']);
  assert.equal(result.status, 'failed');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[1].error, 'wrong result');
  assert.equal(checkpoints.at(-1).results.length, 2);
});

test('execution timestamp metadata does not conflict with source context', async () => {
  const f = await notebookFixture();
  f.cells[1].metadata.execution = { completed: 'now' };
  f.cells[1].metadata.ExecuteTime = { start_time: 'now' };
  const fresh = await notebookAdapter.readSnapshot(f.context);
  assert.equal(fresh.contextHash, f.snapshot.contextHash);
  assert.equal((await notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit()])).success, true);
});

test('save requires acknowledgement and clean state; timeout can be reconciled without replay', async () => {
  const f = await notebookFixture();
  await notebookAdapter.applyEdits(f.context, f.snapshot, [f.edit()]);
  const fresh = await notebookAdapter.readSnapshot(f.context);
  let completeSave;
  let saves = 0;
  f.notebook.save_notebook = () => { saves++; return new Promise((resolve) => { completeSave = resolve; }); };
  const result = await notebookAdapter.save(f.context, fresh, { timeoutMs: 1, saveId: 'save-job-1' });
  assert.equal(result.status, 'unknown');
  await notebookAdapter.save(f.context, fresh, { timeoutMs: 1, saveId: 'save-job-1' });
  assert.equal(saves, 1);
  f.notebook.dirty = false;
  completeSave({});
  await Promise.resolve();
  assert.equal((await notebookAdapter.pollSave(f.context, 'save-job-1')).status, 'saved');
});

test('save failure and dirty-after-acknowledgement are explicit', async () => {
  const f = await notebookFixture();
  f.notebook.save_notebook = () => Promise.reject(new Error('offline'));
  assert.equal((await notebookAdapter.save(f.context, f.snapshot, { saveId: 'fail' })).status, 'failed');
  f.notebook.dirty = true;
  f.notebook.save_notebook = () => Promise.resolve({});
  assert.equal((await notebookAdapter.save(f.context, f.snapshot, { saveId: 'dirty' })).status, 'unknown');
});

test('code adapter requires source selection and explicit runtime, and never inserts', async () => {
  const model = (uri, source) => ({ uri: { toString: () => uri }, getValue: () => source, getLanguageId: () => 'verilog' });
  const models = [model('file:///stdin', '1011'), model('file:///source.v', 'module solution; endmodule')];
  const top = surface('https://my.newtonschool.co/playground/code/code-1', {
    monaco: { editor: { getModels: () => models } },
  }, { statement: 'QUESTION\nBuild a detector.\nVerilog (Icarus 13.0)' });
  installChrome([{ frameId: 0, documentId: 'code-doc', context: top }]);
  const context = await detectAssignment(4);
  const unresolved = await codeAdapter.readSnapshot(context);
  assert.equal(unresolved.capabilities.generate, false);
  assert.equal(unresolved.candidates[1].editable, true);
  assert.equal(unresolved.candidates[1].readOnly, null);
  assert.equal(unresolved.candidates[1].editabilityVerified, false);
  const selected = await codeAdapter.readSnapshot({ ...context, sourceTargetId: 'file:///source.v' });
  assert.equal(selected.capabilities.generate, true);
  assert.equal(selected.targets.filter((target) => target.editable).length, 1);
  assert.equal(selected.runtime.label, 'Verilog (Icarus 13.0)');
  assert.equal(selected.capabilities.apply, false);
  assert.equal((await codeAdapter.applyEdits(context, selected, [])).status, 'unsupported');
  top.document.body.innerText = 'QUESTION\nBuild a detector. No runtime is shown.';
  assert.equal((await codeAdapter.readSnapshot({ ...context, sourceTargetId: 'file:///source.v' })).capabilities.generate, false);
});
