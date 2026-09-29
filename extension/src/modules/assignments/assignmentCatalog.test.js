import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assignmentCatalog, assignmentCatalogPage, assignmentWorkspace } from './assignmentCatalog.js';

const catalogUrl = 'https://my.newtonschool.co/course/course-1/all_assignments';
function element(tag, attributes = {}, children = [], text = '') {
  const node = { tag, attributes, children, parentElement: null, text,
    getClientRects() { return this.hidden ? [] : [{}]; }, getAttribute(name) { return this.attributes[name] ?? null; },
    matches(selector) {
      return selector.split(',').some((part) => {
        const term = part.trim();
        if (term.startsWith('.')) return term.slice(1).split('.').every((name) => (this.attributes.class || '').split(' ').includes(name));
        const match = term.match(/^([a-z0-9]+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/);
        return Boolean(match && (!match[1] || match[1] === this.tag) &&
          (!match[2] || this.attributes[match[2]] !== undefined && (match[3] === undefined || this.attributes[match[2]] === match[3])));
      });
    },
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    contains(other) { return this === other || this.children.some((child) => child.contains(other)); },
    click() { this.clicked = (this.clicked || 0) + 1; this.onClick?.(); },
  };
  Object.defineProperties(node, {
    innerText: { get() { return [this.text, ...this.children.map((child) => child.innerText)].filter(Boolean).join('\n'); } },
    textContent: { get() { return this.text + this.children.map((child) => child.textContent).join(''); } },
  });
  children.forEach((child) => { child.parentElement = node; });
  return node;
}
function card(title, { status = 'dash.svg', href = `/playground/code/${title}`, xp = '0/100 XP' } = {}) {
  const titleNode = element('span', { 'data-testid': 'assignment-title' }, [], title);
  const children = [element('img', { src: `https://cdn.example/status/${status}` }), titleNode, element('span', {}, [], xp)];
  if (href) children.push(element('a', { href }, [], 'Open'));
  return element('div', { 'data-testid': 'assignment-card' }, children);
}
function surface(cards, url = catalogUrl) {
  const body = element('body', {}, cards);
  return vm.createContext({ location: new URL(url), document: { body, querySelectorAll: (selector) => body.querySelectorAll(selector) },
    URL, getComputedStyle: (node) => {
      let parent = node;
      while (parent && !parent.cursor) parent = parent.parentElement;
      return { cursor: parent?.cursor || 'auto', fontWeight: node.attributes['data-weight'] || '400' };
    } });
}
function scan(cards, url) { return vm.runInContext(`(${assignmentCatalogPage.toString()})`, surface(cards, url))(); }

test('catalog requires exact Newton host and course assignments route', () => {
  for (const url of ['https://example.com/course/id/all_assignments', 'https://my.newtonschool.co/course/id/assessment/q',
    'https://my.newtonschool.co/course/id/all_assignments/extra']) assert.equal(scan([card('one')], url).isCatalog, false);
});

test('tick and dash classify completion independently of XP', () => {
  const result = scan([card('done', { status: 'tick.svg', xp: '0/100 XP' }), card('unfinished', { xp: '100/100 XP' })]);
  assert.equal(result.complete, true);
  assert.deepEqual(Array.from(result.items, (item) => item.status), ['completed', 'unfinished']);
  assert.equal(result.items[1].kind, 'code');
});

test('unknown status, duplicate identity and missing cards cannot be treated as complete', () => {
  assert.equal(scan([card('unknown', { status: 'unrecognized.svg' })]).items[0].status, 'ambiguous');
  assert.equal(scan([card('same'), card('same')]).items.every((item) => item.ambiguous), true);
  assert.equal(scan([]).complete, false);
});

test('workspace routes are exact and unsupported links remain distinct', () => {
  assert.equal(assignmentWorkspace('https://my.newtonschool.co/playground/newton-box/p').kind, 'notebook');
  for (const url of ['https://my.newtonschool.co/playground/code/p/extra', 'https://example.com/playground/code/p',
    'https://my.newtonschool.co/playground/code']) assert.equal(assignmentWorkspace(url), null);
  assert.equal(scan([card('video', { href: '/course/course-1/video/x' })]).items[0].kind, 'unsupported');
});

test('no-href card click requires the same unique unfinished descriptor', () => {
  const node = card('no-href', { href: null });
  const context = surface([node]);
  const operation = vm.runInContext(`(${assignmentCatalogPage.toString()})`, context);
  const item = operation().items[0];
  assert.equal(item.kind, 'unresolved');
  assert.equal(operation('click', { catalogUrl, item }).success, true);
  assert.equal(node.clicked, 1);
  node.children[0].attributes.src = '/tick.svg';
  assert.equal(operation('click', { catalogUrl, item }).success, false);
  assert.equal(node.clicked, 1);
});

test('hashed cards can use one emphasized plain-text title without interpreting XP as status', () => {
  const node = element('div', {}, [element('img', { src: '/dash.svg' }),
    element('span', { 'data-weight': '600' }, [], 'Moore sequence detector'), element('span', { 'data-weight': '700' }, [], '100/100 XP')]);
  const result = scan([node]);
  assert.equal(result.complete, true);
  assert.equal(result.items[0].title, 'Moore sequence detector');
  assert.equal(result.items[0].status, 'unfinished');
});

// Mirrors the observed Newton div grid: one header, alternating nested group
// headings and row lists, and seven plain div columns. No selector test IDs.
function newtonRow(title, status = 'dash.svg') {
  const node = element('div', { class: 'row-style' }, [
    element('div', {}, [element('img', { src: `/assets/question-of-the-day/questionStatus/${status}` })]),
    element('div', {}, [element('div', {}, [element('div', {}, [element('div', {}, [], title)])])]),
    element('div', {}, [], 'Medium'),
    element('div', {}, [element('span', {}, [], '2x'), element('span', {}, [], '0/20 ')]),
    element('div', {}, [], 'CNN Blocks'),
    element('div', {}, [], '43(73%)'),
    element('div', {}, [element('button', {}, [], 'More actions')]),
  ]);
  node.cursor = 'pointer';
  return node;
}
function newtonGrid(groups) {
  const headers = ['Status', 'Questions', 'difficulty', 'XP Earned', 'TOPICS', 'SOLVED BY', 'ACTIONS'];
  return element('div', { class: 'grid-style' }, [element('div', { class: 'header-style' }, headers.map((value) => element('div', {}, [], value))),
    ...groups.flatMap(({ subject = 'DL Lab 1 - B', section, date = 'Release - 24 Sept 2026 Deadline - 29 Sept 2026 4:00 PM', rows }) => [
      element('div', { class: 'group-style' }, [element('div', {}, [element('div', {}, [element('svg')]),
        element('div', {}, [element('p', {}, [], subject), element('span', {}, [], section), element('span', {}, [element('div')], date)])])]),
      element('div', { class: 'rows-style' }, rows),
    ])]);
}

test('observed plain div grid maps Questions independently of topic, XP, and solved-by columns', () => {
  const done = newtonRow('Custom PyTorch CNN Block with Summary', 'tick.svg');
  const pending = newtonRow('Implementing a simple CNN for image classification');
  const grid = newtonGrid([{ section: 'Convolutional Neural Networks - Post Class', rows: [done, pending] }]);
  const context = surface([grid]);
  const operation = vm.runInContext(`(${assignmentCatalogPage.toString()})`, context);
  const result = operation();
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].status, 'completed');
  assert.equal(result.items[1].title, 'Implementing a simple CNN for image classification');
  assert.equal(result.items[1].status, 'unfinished');
  assert.equal(result.items[1].subject, 'DL Lab 1 - B');
  assert.equal(result.items[1].section, 'Convolutional Neural Networks - Post Class');
  assert.equal(result.items[1].date, 'Release - 24 Sept 2026 Deadline - 29 Sept 2026 4:00 PM');
  assert.equal(result.items.some((item) => item.ambiguous), false);
  assert.equal(operation('click', { catalogUrl, item: result.items[1] }).success, true);
  assert.equal(pending.clicked, 1);
  assert.equal(pending.children[6].children[0].clicked, undefined);
  assert.equal(done.clicked, undefined);
});

test('same plain title in different actual group headings has distinct stable identity', () => {
  const grid = newtonGrid([
    { section: 'CN_LAB_DHCP_SectionA', rows: [newtonRow('Dual-LAN DHCP')] },
    { section: 'CN_LAB_DHCP_SectionB', rows: [newtonRow('Dual-LAN DHCP')] },
  ]);
  const result = scan([grid]);
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].key, result.items[1].key);
  assert.equal(result.items.some((item) => item.ambiguous), false);
});

test('Questions mapping supports short and numeric-leading plain titles while duplicate rows remain blocked', () => {
  const rows = [newtonRow('DFS'), newtonRow('2D CNN'), newtonRow('DFS')];
  const grid = newtonGrid([{ section: 'Lab', rows }]);
  const result = scan([grid]);
  assert.deepEqual(Array.from(result.items, (item) => item.title), ['DFS', '2D CNN', 'DFS']);
  assert.equal(result.items[0].ambiguous, true);
  assert.equal(result.items[1].ambiguous, false);
  assert.equal(result.items[2].ambiguous, true);
});

test('plain row status and disabled changes are rechecked before native click', () => {
  const row = newtonRow('DFS');
  const context = surface([newtonGrid([{ section: 'Lab', rows: [row] }])]);
  const operation = vm.runInContext(`(${assignmentCatalogPage.toString()})`, context);
  const item = operation().items[0];
  row.attributes['aria-disabled'] = 'true';
  assert.equal(operation('click', { catalogUrl, item }).success, false);
  delete row.attributes['aria-disabled'];
  row.children[0].children[0].attributes.src = '/assets/question-of-the-day/questionStatus/tick.svg';
  assert.equal(operation('click', { catalogUrl, item }).success, false);
  assert.equal(row.clicked, undefined);
});

test('catalog records additional pagination instead of claiming all pages were scanned', () => {
  const next = element('button', { 'aria-label': 'Next page' }, [], 'Next');
  assert.equal(scan([card('one'), next]).hasNextPage, true);
});

function browserFixture(cards) {
  const tabs = new Map([[1, { id: 1, url: catalogUrl, status: 'complete' }]]);
  const listeners = new Set();
  const removed = [];
  let id = 10;
  const contexts = new Map([[1, surface(cards)]]);
  const create = (properties) => {
    const tab = { id: ++id, status: 'complete', ...properties };
    tabs.set(tab.id, tab);
    if (tab.url === catalogUrl) contexts.set(tab.id, surface(cards));
    for (const listener of listeners) listener(tab);
    return tab;
  };
  globalThis.chrome = {
    tabs: { create: async (properties) => create(properties), get: async (tabId) => {
      if (!tabs.has(tabId)) throw new Error('closed');
      return { ...tabs.get(tabId) };
    }, reload: async () => {}, remove: async (tabId) => { removed.push(tabId); tabs.delete(tabId); },
    onCreated: { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener) } },
    scripting: { executeScript: async ({ target, func, args }) => {
      const run = vm.runInContext(`(${func.toString()})`, contexts.get(target.tabId));
      return [{ result: run(...args) }];
    } },
  };
  return { tabs, create, removed, listeners, contexts };
}

test('batch scan scrolls the catalog to load more assignment rows', async () => {
  const cards = [card('first'), element('span', {}, [], '0/2 Solved')];
  const fixture = browserFixture(cards);
  const context = fixture.contexts.get(1);
  const scroller = context.document.body;
  context.document.scrollingElement = scroller;
  scroller.clientHeight = 400;
  scroller.scrollHeight = 1000;
  let position = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => position,
    set: (value) => {
      position = value;
      if (position >= 600 && !cards.some((node) => node.querySelector?.('[data-testid="assignment-title"]')?.textContent === 'second')) {
        const added = card('second');
        added.parentElement = scroller;
        cards.unshift(added);
        scroller.scrollHeight = 1400;
      }
    },
  });
  const result = await assignmentCatalog.scan(1, { expand: true, timeoutMs: 3000 });
  assert.equal(result.complete, true);
  assert.deepEqual(result.items.map((item) => item.title), ['first', 'second']);
  assert.ok(position >= 600);
});

test('batch scan reports a partial catalog when the displayed total never loads', async () => {
  const fixture = browserFixture([card('first'), element('span', {}, [], '0/3 Solved')]);
  const context = fixture.contexts.get(1);
  const scroller = context.document.body;
  context.document.scrollingElement = scroller;
  scroller.clientHeight = 400;
  scroller.scrollHeight = 600;
  scroller.scrollTop = 0;
  const result = await assignmentCatalog.scan(1, { expand: true, timeoutMs: 3000 });
  assert.equal(result.complete, false);
  assert.match(result.reason, /Only 1 of 3 assignments loaded/);
});

test('direct links only own their created tab and refuse to close navigated tabs', async () => {
  const f = browserFixture([card('one')]);
  const item = (await assignmentCatalog.scan(1)).items[0];
  const owned = [];
  const opened = await assignmentCatalog.open(1, item, { ownershipId: 'batch', onOwnedTab: (tab) => owned.push(tab) });
  assert.equal(opened.workspaceTabId, owned[0].tabId);
  assert.equal((await assignmentCatalog.closeOwnedTab(owned[0], 'other')).success, false);
  f.tabs.get(opened.workspaceTabId).url = 'https://example.com/user-page';
  assert.equal((await assignmentCatalog.closeOwnedTab(owned[0], 'batch')).success, false);
  assert.deepEqual(f.removed, []);
});

test('no-href popup provenance ignores unrelated tabs created during the click', async () => {
  const node = card('popup', { href: null });
  const f = browserFixture([node]);
  node.onClick = () => {
    f.create({ url: 'https://my.newtonschool.co/playground/code/unrelated', openerTabId: 1 });
    f.create({ url: 'https://my.newtonschool.co/playground/newton-box/popup', openerTabId: 11 });
  };
  const item = (await assignmentCatalog.scan(1)).items[0];
  const owned = [];
  const opened = await assignmentCatalog.open(1, item, { ownershipId: 'batch', onOwnedTab: (tab) => owned.push(tab) });
  assert.equal(opened.success, true);
  assert.equal(opened.workspaceTabId, 13);
  assert.deepEqual(owned.map((tab) => tab.tabId), [11, 13]);
  assert.equal(f.listeners.size, 0);
  for (const tab of owned) await assignmentCatalog.closeOwnedTab(tab, 'batch');
  assert.deepEqual(f.removed, [11, 13]);
  assert.equal(f.tabs.has(12), true);
});

test('catalog refresh waits for rendered cards and bounded load-more appends', async () => {
  const first = card('one');
  const more = element('button', {}, [], 'Load more assignments');
  const cards = [first, more];
  browserFixture(cards);
  more.onClick = () => {
    const added = card('two');
    added.parentElement = more.parentElement;
    cards.splice(1, 1, added);
  };
  const result = await assignmentCatalog.scan(1, { refresh: true, expand: true, timeoutMs: 500 });
  assert.equal(result.complete, true);
  assert.equal(result.items.length, 2);
  assert.equal(more.clicked, 1);
});

test('native Next requires one enabled control and a new stable card fingerprint', async () => {
  const first = card('one');
  const next = element('button', { 'aria-label': 'Next page' }, [], 'Next');
  const cards = [first, next];
  browserFixture(cards);
  next.onClick = () => {
    const second = card('two');
    second.parentElement = next.parentElement;
    cards.splice(0, 2, second);
  };
  const result = await assignmentCatalog.nextPage(1, { expectedUrl: catalogUrl, timeoutMs: 300 });
  assert.equal(result.success, true);
  assert.equal(result.catalog.items[0].title, 'two');
  assert.equal(next.clicked, 1);
});

test('ambiguous Next controls are never clicked', async () => {
  const a = element('button', {}, [], 'Next');
  const b = element('button', {}, [], 'Next page');
  browserFixture([card('one'), a, b]);
  const result = await assignmentCatalog.nextPage(1, { expectedUrl: catalogUrl, timeoutMs: 100 });
  assert.equal(result.success, false);
  assert.equal(a.clicked, undefined);
  assert.equal(b.clicked, undefined);
});
