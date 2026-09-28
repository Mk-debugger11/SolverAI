import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./quizDom.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');

// Execute the page scripts against local fixtures, never a browser tab.
function page(document, window = {}, globals = {}) {
  let scriptCalls = 0;
  const context = vm.createContext({
    document,
    window,
    console,
    setTimeout(callback) { callback(); },
    ...globals,
    chrome: {
      scripting: {
        async executeScript({ func, args = [] }) {
          scriptCalls++;
          return [{ result: await func(...args) }];
        },
      },
    },
  });
  vm.runInContext(source, context);
  return { context, scriptCalls: () => scriptCalls };
}

function textElement(text) {
  return {
    innerText: text,
    textContent: text,
    children: [],
    querySelectorAll: () => [],
    cloneNode: () => textElement(text),
  };
}

function quizFixture({ allowExpensiveReads = false } = {}) {
  const reads = { html: 0, style: 0 };
  const heading = { ...textElement('What is six times seven?'), id: 'question-1' };
  const labels = ['42', '84'].map(textElement);
  const container = {
    id: 'question-container',
    contains: (node) => radios.includes(node),
    querySelector: () => heading,
    get outerHTML() {
      reads.html++;
      assert.ok(allowExpensiveReads, 'lightweight extraction must not serialize a container');
      return '<section>quiz</section>';
    },
  };
  const radios = labels.map((label, index) => ({
    id: `option-${index}`,
    name: 'question-1',
    value: String(index),
    checked: index === 1,
    parentElement: container,
    closest: () => label,
  }));
  const document = {
    body: {},
    documentElement: {
      get outerHTML() {
        reads.html++;
        assert.ok(allowExpensiveReads, 'lightweight extraction must not serialize the document');
        return '<html>quiz</html>';
      },
    },
    querySelectorAll: (selector) => selector === 'input[type="radio"]' ? radios :
      selector.includes('text-span-question-renderer') ? [heading] : [],
  };
  const window = {
    getComputedStyle() {
      reads.style++;
      assert.ok(allowExpensiveReads, 'lightweight extraction must not read decorative styles');
      return { backgroundColor: 'rgb(97, 56, 211)', borderColor: '' };
    },
  };
  return { ...page(document, window), reads };
}

test('lightweight extraction skips HTML and style reads while preserving solver data', async () => {
  const fixture = quizFixture();
  const result = await fixture.context.extractQuizQuestionsFromPage(7, true);
  assert.equal(result.fullHtml, '');
  assert.equal(result.onlyRadioContainersHtml, '');
  assert.equal(result.totalQuestionsFound, 1);
  const question = result.questions[0];
  assert.equal(question.questionText, 'What is six times seven?');
  assert.equal(question.answerType, 'mcq');
  assert.equal(JSON.stringify(question.llmPayload), JSON.stringify({
    q: 'What is six times seven?', o: { A: '42', B: '84' },
  }));
  assert.equal(question.options[0].isSelected, false);
  assert.equal(question.options[1].isSelected, true);
  assert.equal(question.options[1].targetDescriptor.id, 'option-1');
  assert.deepEqual(fixture.reads, { html: 0, style: 0 });
});

test('full extraction retains HTML and decorative selection detection', async () => {
  const fixture = quizFixture({ allowExpensiveReads: true });
  const result = await fixture.context.extractQuizQuestionsFromPage(7);
  assert.equal(result.fullHtml, '<html>quiz</html>');
  assert.ok(result.onlyRadioContainersHtml.includes('<section>quiz</section>'));
  assert.equal(result.questions[0].options[0].isSelected, true);
  assert.equal(fixture.reads.html, 2);
  assert.ok(fixture.reads.style > 0);
});

function navigationFixture(counterText) {
  const counter = textElement(counterText);
  const buttons = ['Next', 'Submit Quiz'].map(textElement);
  return page({
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'div, span, p' ? [counter] : buttons,
  });
}

// A small tree fixture supplies the DOM operations used by extraction. It models
// Newton's observed question/answer hierarchy without accessing a live page.
class ElementFixture {
  constructor(tag, attributes = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attributes };
    this.children = [];
    this.parentElement = null;
    this.text = text;
    this.visibility = 'visible';
  }

  get parentNode() { return this.parentElement; }
  replaceChild(replacement, previous) {
    const index = this.children.indexOf(previous);
    assert.ok(index >= 0);
    replacement.parentElement = this;
    previous.parentElement = null;
    this.children[index] = replacement;
  }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get innerText() { return this.text + this.children.map((child) => child.innerText).join(''); }
  get textContent() { return this.innerText; }
  get outerHTML() { return `<${this.tagName.toLowerCase()}>${this.innerText}</${this.tagName.toLowerCase()}>`; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  getClientRects() { return this.hasAttribute('hidden') ? [] : [{}]; }
  remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  cloneNode() {
    const copy = new this.constructor(this.tagName, this.attributes, this.text);
    copy.append(...this.children.map((child) => child.cloneNode()));
    return copy;
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      let rest = part.trim();
      if (rest === ':disabled') return Boolean(this.disabled || this.closest('fieldset[disabled]'));
      if (rest === 'input:not([type])') return this.tagName === 'INPUT' && !this.hasAttribute('type');
      const tag = rest.match(/^[\w-]+/);
      if (tag) {
        if (tag[0].toUpperCase() !== this.tagName) return false;
        rest = rest.slice(tag[0].length);
      }
      while (rest) {
        const classMatch = rest.match(/^\.([\w-]+)/);
        if (classMatch) {
          if (!this.className.split(/\s+/).includes(classMatch[1])) return false;
          rest = rest.slice(classMatch[0].length);
          continue;
        }
        const attribute = rest.match(/^\[([\w-]+)(?:(\*?=)"([^"]*)"(?:\s+i)?)?\]/);
        if (!attribute) return false;
        const value = this.getAttribute(attribute[1]);
        if (value === null || (attribute[2] === '=' && value !== attribute[3]) ||
            (attribute[2] === '*=' && !value.includes(attribute[3]))) return false;
        rest = rest.slice(attribute[0].length);
      }
      return true;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  compareDocumentPosition(other) {
    if (this === other) return 0;
    let root = this;
    while (root.parentElement) root = root.parentElement;
    const flatten = (node) => [node, ...node.children.flatMap(flatten)];
    const nodes = flatten(root);
    return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2;
  }
}

class InputFixture extends ElementFixture {
  constructor(tag = 'input', attributes = {}) {
    super(tag, attributes);
    this._value = attributes.value || '';
    this.checked = false;
    this.disabled = Object.hasOwn(attributes, 'disabled');
    this.readOnly = Object.hasOwn(attributes, 'readonly');
    this.nativeWrites = 0;
    this.events = [];
    this.validity = { valid: true };
  }
  get type() { return this.getAttribute('type') || 'text'; }
  get name() { return this.getAttribute('name') || ''; }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  get inputMode() { return this.getAttribute('inputmode') || ''; }
  get autocomplete() { return this.getAttribute('autocomplete') || ''; }
  get maxLength() { return this.hasAttribute('maxlength') ? Number(this.getAttribute('maxlength')) : -1; }
  get labels() { return [this.closest('label')].filter(Boolean); }
  get value() { return this._value; }
  set value(value) { this.nativeWrites++; this._value = String(value); }
  focus() { this.events.push('focus'); this.onFocus?.(); }
  blur() { this.events.push('blur'); }
  dispatchEvent(event) { this.events.push(event.type); this.onEvent?.(event); return true; }
}

function numericalFixture({ attributes = {}, withMcqs = false, withInput = true } = {}) {
  const body = new ElementFixture('body');
  const documentElement = new ElementFixture('html').append(body);
  const block = new ElementFixture('div', { class: 'sc-8f773ddd-5 eypNrF' });
  const heading = new ElementFixture('div', { class: 'text-span-question-renderer' }, 'How many bits are in one byte?');
  const headingWrapper = new ElementFixture('div', { class: 'sc-3e5adff9-2 khXJqZ' }).append(heading);
  const input = new InputFixture('input', {
    type: 'text', placeholder: 'Enter your answer here', maxlength: '255',
    id: '8ff84741-712c-43a9-b8a0-bc7830b12427', 'data-puzzle-answer': '',
    class: 'sc-8f773ddd-3 enmBNF', ...attributes,
  });
  const inputWrapper = new ElementFixture('div', { class: 'sc-10b94b5a-10 PDmYw' });
  if (withInput) inputWrapper.append(input);
  const answerWrapper = new ElementFixture('div', { class: 'sc-10b94b5a-5 tKCRC' }).append(
    new ElementFixture('div', { class: 'sc-10b94b5a-8 ckjZSs' }).append(
      inputWrapper, new ElementFixture('div', { class: 'sc-10b94b5a-9 fKLksu' }, 'Check Answer'),
    ),
  );
  block.append(headingWrapper, answerWrapper);
  body.append(block);
  if (withMcqs) {
    for (let question = 2; question <= 4; question++) {
      const mcq = new ElementFixture('div', { class: 'sc-8f773ddd-5 eypNrF' });
      mcq.append(new ElementFixture('div', { class: 'text-span-question-renderer', id: `question-${question}` }, `MCQ ${question}`));
      for (const letter of ['A', 'B', 'C', 'D']) {
        mcq.append(new ElementFixture('label').append(
          new InputFixture('input', { type: 'radio', name: `q${question}`, id: `q${question}-${letter}` }),
          new ElementFixture('span', {}, letter), new ElementFixture('span', {}, `Choice ${letter}`),
        ));
      }
      body.append(mcq);
    }
  }
  const document = {
    body, documentElement,
    querySelectorAll: (selector) => documentElement.querySelectorAll(selector),
    querySelector: (selector) => documentElement.querySelector(selector),
  };
  const window = {
    location: new URL('https://my.newtonschool.co/course/demo/assessment/revision?show_revision=1'),
    getComputedStyle: (element) => ({ visibility: element.visibility, backgroundColor: '', borderColor: '' }),
  };
  const app = page(document, window, {
    HTMLInputElement: InputFixture,
    Event,
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
  });
  return {
    ...app, body, block, heading, input, inputWrapper, window,
    extract: () => app.context.extractQuizQuestionsFromPage(7, true),
    fill: (descriptor, answer) => app.context.fillQuizNumericAnswerOnPage(7, descriptor, answer),
  };
}

test('the observed Newton revision layout extracts numeric Q1 before three MCQs', async () => {
  const fixture = numericalFixture({ withMcqs: true });
  const { questions } = await fixture.extract();
  assert.equal(questions.length, 4);
  assert.equal(questions.map((q) => q.answerType).join(','), 'numeric,mcq,mcq,mcq');
  assert.equal(questions.map((q) => q.questionIndex).join(','), '1,2,3,4');
  assert.equal(questions[0].questionId, fixture.input.id);
  assert.equal(questions[0].inputValue, '');
  assert.equal(JSON.stringify(questions[0].llmPayload), JSON.stringify({ q: fixture.heading.innerText, answerType: 'numeric' }));
  assert.equal(questions[0].options.length, 0);
  assert.equal(questions[1].options[0].text, 'Choice A');
});

test('completed review without an editable input is not a numeric question', async () => {
  const fixture = numericalFixture({ withInput: false });
  assert.equal((await fixture.extract()).questions.length, 0);
});

for (const [name, change] of [
  ['disabled', (f) => { f.input.disabled = true; }],
  ['readonly', (f) => { f.input.readOnly = true; }],
  ['hidden ancestor', (f) => { f.inputWrapper.attributes.hidden = ''; }],
  ['invisible', (f) => { f.input.visibility = 'hidden'; }],
  ['search input', (f) => { f.input.attributes.type = 'search'; }],
  ['login input', (f) => { f.input.attributes.autocomplete = 'username'; }],
  ['textarea', (f) => { f.input.tagName = 'TEXTAREA'; }],
  ['missing question heading', (f) => { f.heading.remove(); }],
  ['outside question block', (f) => { f.input.remove(); f.body.append(f.input); }],
  ['multiple answer fields', (f) => { f.inputWrapper.append(new InputFixture('input', { type: 'number' })); }],
]) {
  test(`numerical extraction excludes ${name}`, async () => {
    const fixture = numericalFixture();
    change(fixture);
    assert.equal((await fixture.extract()).questions.length, 0);
  });
}

for (const attributes of [
  { type: 'number' },
  { type: 'text', inputmode: 'decimal' },
  { type: 'text', placeholder: 'Enter your answer here' },
]) {
  test(`numeric field recognition without puzzle marker: ${JSON.stringify(attributes)}`, async () => {
    const fixture = numericalFixture({ attributes });
    delete fixture.input.attributes['data-puzzle-answer'];
    assert.equal((await fixture.extract()).questions[0].answerType, 'numeric');
  });
}

for (const answer of ['0', '-12.75', '.5', '6.02e23', '-1E-6']) {
  test(`numerical fill accepts ${answer} and emits input/change/blur`, async () => {
    const fixture = numericalFixture();
    const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
    const result = await fixture.fill(descriptor, answer);
    assert.equal(result.success, true, result.failureReason);
    assert.equal(fixture.input.value, answer);
    assert.deepEqual(fixture.input.events, ['focus', 'input', 'change', 'blur']);
    assert.equal(fixture.input.nativeWrites, 1);
  });
}

for (const answer of ['', '8 bits', '1/2', '1 + 2', 'Infinity', '1e309', 'NaN', {}, null]) {
  test(`invalid numerical answer is rejected before page scripts: ${JSON.stringify(answer)}`, async () => {
    const fixture = numericalFixture();
    const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
    const before = fixture.scriptCalls();
    assert.equal((await fixture.fill(descriptor, answer)).success, false);
    assert.equal(fixture.input.nativeWrites, 0);
    assert.equal(fixture.scriptCalls(), before);
  });
}

test('the native setter bypasses React-style instance value tracking', async () => {
  const fixture = numericalFixture();
  let trackedWrites = 0;
  Object.defineProperty(fixture.input, 'value', {
    get() { return this._value; },
    set(value) { trackedWrites++; this._value = value; },
  });
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '8')).success, true);
  assert.equal(trackedWrites, 0);
  assert.equal(fixture.input.nativeWrites, 1);
});

for (const [name, change] of [
  ['question text', (f) => { f.heading.text = 'A different question'; }],
  ['question identity', (f) => { f.heading.attributes['data-question-id'] = 'different'; }],
  ['field identity', (f) => { f.input.attributes.id = 'different'; }],
  ['user-entered value', (f) => { f.input._value = '9'; }],
  ['page URL', (f) => { f.window.location = new URL('https://my.newtonschool.co/course/demo/assessment/other'); }],
]) {
  test(`a delayed answer does not overwrite changed ${name}`, async () => {
    const fixture = numericalFixture();
    const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
    change(fixture);
    assert.equal((await fixture.fill(descriptor, '8')).success, false);
    assert.equal(fixture.input.nativeWrites, 0);
  });
}

test('React reverting the answer is a failure and is not overwritten again', async () => {
  const fixture = numericalFixture();
  fixture.input.onEvent = (event) => { if (event.type === 'input') fixture.input._value = ''; };
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '8')).success, false);
  assert.equal(fixture.input.value, '');
  assert.equal(fixture.input.nativeWrites, 1);
});

test('a question changed by focus handlers is not written', async () => {
  const fixture = numericalFixture();
  fixture.input.onFocus = () => { fixture.heading.text = 'New question'; };
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '8')).success, false);
  assert.equal(fixture.input.nativeWrites, 0);
});

test('a question changed after input events cannot report success', async () => {
  const fixture = numericalFixture();
  fixture.input.onEvent = () => { fixture.heading.text = 'New question'; };
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '8')).success, false);
});

test('native number inputs receive a browser-compatible numeric spelling', async () => {
  const fixture = numericalFixture({ attributes: { type: 'number' } });
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '+.5')).success, true);
  assert.equal(fixture.input.value, '0.5');
});

test('answers exceeding maxlength are rejected without writing', async () => {
  const fixture = numericalFixture({ attributes: { maxlength: '2' } });
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '123')).success, false);
  assert.equal(fixture.input.nativeWrites, 0);
});

test('browser validation failure cannot report a successful fill', async () => {
  const fixture = numericalFixture();
  fixture.input.validity.valid = false;
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '8')).success, false);
});

test('verification resolves an input replaced during the React update', async () => {
  const fixture = numericalFixture();
  let replacement;
  fixture.input.onEvent = (event) => {
    if (event.type !== 'change') return;
    replacement = new InputFixture('input', fixture.input.attributes);
    replacement._value = fixture.input.value;
    fixture.input.remove();
    fixture.inputWrapper.append(replacement);
  };
  const descriptor = (await fixture.extract()).questions[0].targetDescriptor;
  assert.equal((await fixture.fill(descriptor, '8')).success, true);
  assert.equal(replacement.value, '8');
  assert.equal(replacement.nativeWrites, 0);
});

for (const counter of ['QUESTION 1/20', 'Question 1 of 20']) {
  test(`navigation reads ${counter}`, async () => {
    const { context } = navigationFixture(counter);
    const result = await context.getQuizNavigationInfo(7);
    assert.equal(result.currentNum, 1);
    assert.equal(result.totalNum, 20);
    assert.equal(result.hasNext, true);
    assert.equal(result.hasSubmit, true);
  });
}

test('question transition polling recognizes an of counter immediately', async () => {
  const fixture = navigationFixture('Question 2 of 20');
  await fixture.context.waitForNextQuestionToRender(7, 'Previous question', 1, 450);
  assert.equal(fixture.scriptCalls(), 1);
});

for (const [path, isCatalog] of [
  ['/course/course-id/all_assessments', true],
  ['/course/course-id/all_assessments/?page=2', true],
  ['/course/course-id/assessment/quiz-id', false],
  ['/course/course-id/details?next=all_assessments', false],
]) {
  test(`catalog route detection: ${path}`, async () => {
    const { context } = page({
      querySelector: () => null,
      querySelectorAll: () => [],
    }, { location: new URL(path, 'https://my.newtonschool.co') });
    const result = await context.detectAssessmentsCatalog(7);
    assert.equal(result.isCatalog, isCatalog);
    assert.equal(result.error, undefined);
  });
}

test('question images retain their URL when canvas access is unavailable, and excessive images fail explicitly', async () => {
  const fixture = numericalFixture();
  fixture.context.document.createElement = () => { throw new Error('Canvas access blocked'); };
  const addImage = (src) => {
    const image = new ElementFixture('img', { src });
    image.getBoundingClientRect = () => ({ width: 300, height: 200 });
    fixture.block.append(image);
  };
  addImage('https://example.test/graph.png');
  let data = await fixture.extract();
  assert.equal(data.questions[0].llmPayload.images[0], 'https://example.test/graph.png');
  for (let index = 0; index < 3; index++) addImage(`https://example.test/graph-${index}.png`);
  data = await fixture.extract();
  assert.match(data.questions[0].imageExtractionError, /more than three images/);
});

test('canonical choice letters never remove an unrelated leading math variable', async () => {
  const fixture = numericalFixture({ withMcqs: true });
  const choice = fixture.body.children[1].children[1];
  choice.children[1].text = 'X';
  choice.children[2].text = ' @ theta';
  const data = await fixture.extract();
  assert.equal(data.questions[1].options[0].optionLetter, 'A');
  assert.equal(data.questions[1].options[0].text, 'X @ theta');
});

test('standalone MathML is retained as readable text without modifying the original question', async () => {
  const fixture = numericalFixture();
  const math = new ElementFixture('math', { alttext: 'x squared' }, 'x2');
  fixture.heading.append(math);
  fixture.context.document.createTextNode = (value) => new ElementFixture('text', {}, value);
  const data = await fixture.extract();
  assert.match(data.questions[0].questionText, /x squared/);
  assert.equal(fixture.heading.querySelector('math'), math);
});
