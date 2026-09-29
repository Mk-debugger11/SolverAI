import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatLlmPayload, normalizeNumericAnswer } from '../llm/llmService.js';

const source = fs.readFileSync(new URL('./quizAutomation.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];\s*/gm, '')
  .replace('export async function', 'async function');

function question(number) {
  return {
    questionId: `question-${number}`,
    groupName: `group-${number}`,
    questionText: `Question text ${number}`,
    options: [
      { optionLetter: 'A', text: 'First', targetDescriptor: { value: 'D' } },
      { optionLetter: 'B', text: 'Second', targetDescriptor: { value: 'A' } },
    ],
  };
}

function numericQuestion(number) {
  return {
    questionId: `numeric-${number}`,
    questionText: `Calculate value ${number}`,
    answerType: 'numeric',
    options: [],
    inputValue: '',
    targetDescriptor: { kind: 'numeric', id: `input-${number}`, questionId: `numeric-${number}`, inputValue: '' },
  };
}

function quiz({ count = 2, unknownCounters = false, ...overrides } = {}) {
  let page = 0;
  let extractionCount = 0;
  const questions = overrides.questions ?? Array.from({ length: count }, (_, index) => question(index + 1));
  count = questions.length;
  const calls = { solves: [], clicks: [], fills: [], submissions: 0, next: 0 };
  const records = [];
  const statuses = [];
  const progress = [];
  const isRunningRef = { current: true };
  let completion;
  const context = vm.createContext({
    console: { error() {} },
    performance,
    setTimeout(fn, delay) { overrides.delay?.({ delay, isRunningRef }); fn(); },
    formatLlmPayload,
    normalizeNumericAnswer,
    async handleStartOrInstructionsPage() {
      return overrides.startPage?.() ?? { handled: false };
    },
    async extractQuizQuestionsFromPage() {
      extractionCount++;
      return overrides.extract?.({ page, extractionCount, questions, isRunningRef })
        ?? { questions: [questions[page]] };
    },
    async getQuizNavigationInfo() {
      return overrides.navigation?.({ page, count }) ?? {
        currentNum: unknownCounters ? null : page + 1,
        totalNum: unknownCounters ? null : count,
        hasNext: page < count - 1,
        hasSubmit: true,
      };
    },
    async solveMcq(payload) {
      calls.solves.push(payload);
      return await overrides.solve?.({ page, payload, isRunningRef })
        ?? { answer: 'B', cacheHit: true, usage: { total_tokens: 10 } };
    },
    async clickQuizOptionOnPage(...args) {
      calls.clicks.push(args);
      return overrides.click?.({ page, isRunningRef }) ?? { success: true };
    },
    async fillQuizNumericAnswerOnPage(...args) {
      calls.fills.push(args);
      const result = overrides.fill?.({ page, isRunningRef }) ?? { success: true };
      if (result.success) {
        questions[page].inputValue = args[2];
        questions[page].targetDescriptor.inputValue = args[2];
      }
      return result;
    },
    async clickNextQuestionOnPage() {
      calls.next++;
      if (!overrides.stuck) page++;
      return true;
    },
    async waitForNextQuestionToRender() { return true; },
    async clickSubmitQuizOnPage() {
      calls.submissions++;
      return overrides.submit?.() ?? { success: true, confirmed: true };
    },
  });
  const run = vm.runInContext(`${source}\nrunFullQuizAutomation`, context);
  return {
    calls, records, statuses, progress, isRunningRef,
    get completion() { return completion; },
    async run(options = {}) {
      await run({
        tabId: 7,
        autoSubmitAtEnd: true,
        stepDelayMs: 0,
        isRunningRef,
        onStatus: (value) => statuses.push(value),
        onProgress: (value) => progress.push(value),
        onQuestionSolved: (value) => records.push(value),
        onComplete: (value) => { completion = value; },
        ...options,
      });
    },
  };
}

test('selects visible option keys with fresh descriptors and preserves cache metadata', async () => {
  const app = quiz();
  await app.run();
  assert.equal(app.completion.success, true);
  assert.equal(app.completion.solvedCount, 2);
  assert.equal(app.calls.next, 1);
  assert.equal(app.calls.submissions, 1);
  assert.equal(app.calls.clicks[0][1].optionLetter, 'B');
  assert.equal(app.calls.clicks[0][1].value, 'A');
  assert.equal(app.records[0].cacheHit, true);
  assert.equal(app.records[0].usage.total_tokens, 10);
  assert.ok(app.statuses.some((status) => status.text.includes('cached answer')));
});

test('unknown counters continue beyond eight questions until the visible end', async () => {
  const app = quiz({ count: 10, unknownCounters: true });
  await app.run();
  assert.equal(app.calls.solves.length, 10);
  assert.equal(app.calls.next, 9);
  assert.equal(app.completion.success, true);
  assert.equal(app.progress[0].total, null);
  assert.equal(app.progress.at(-1).total, 10);
});

test('stop while waiting for AI prevents selection and submission', async () => {
  const app = quiz({ solve({ isRunningRef }) { isRunningRef.current = false; return { answer: 'B' }; } });
  await app.run();
  assert.equal(app.calls.clicks.length, 0);
  assert.equal(app.calls.submissions, 0);
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.cancelled, true);
});

test('changed question or choices while waiting prevents a stale answer click', async () => {
  for (const change of ['question', 'options']) {
    const app = quiz({
      extract({ extractionCount, questions }) {
        if (extractionCount !== 2) return null;
        const fresh = structuredClone(questions[0]);
        if (change === 'question') fresh.questionId = 'different-question';
        else fresh.options.reverse().forEach((option, index) => { option.optionLetter = index ? 'B' : 'A'; });
        return { questions: [fresh] };
      },
    });
    await app.run();
    assert.equal(app.calls.clicks.length, 0);
    assert.equal(app.completion.success, false);
    assert.match(app.completion.error, /question or options changed/);
  }
});

test('failed selection after a successful answer is a failed run', async () => {
  const app = quiz({ click: ({ page }) => ({ success: page === 0, failureReason: 'Input unavailable' }) });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.solvedCount, 1);
  assert.match(app.completion.error, /Input unavailable/);
  assert.equal(app.calls.submissions, 0);
});

test('stop after one answer does not report successful partial completion', async () => {
  const app = quiz({ click({ isRunningRef }) { isRunningRef.current = false; return { success: true }; } });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.cancelled, true);
  assert.equal(app.completion.solvedCount, 1);
  assert.equal(app.calls.submissions, 0);
});

test('provider status is preserved so batch callers stop on exhausted rate limits', async () => {
  const app = quiz({ solve() { throw Object.assign(new Error('Try later'), { status: 429 }); } });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.errorStatus, 429);
  assert.equal(app.calls.clicks.length, 0);
});

test('invalid answer keys are rejected before selection', async () => {
  const app = quiz({ solve() { return { answer: 'C' }; } });
  await app.run();
  assert.equal(app.calls.clicks.length, 0);
  assert.equal(app.completion.success, false);
});

test('submission failure is not reported as successful completion', async () => {
  const app = quiz({ count: 1, submit() { return { success: false, reason: 'Button not found' }; } });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.match(app.completion.error, /Button not found/);
});

test('stop during the final submission delay prevents submission', async () => {
  const app = quiz({ count: 1, delay({ delay, isRunningRef }) { if (delay === 600) isRunningRef.current = false; } });
  await app.run();
  assert.equal(app.calls.submissions, 0);
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.cancelled, true);
});

test('finishing with auto-submit off is successful without submitting', async () => {
  const app = quiz({ count: 1 });
  await app.run({ autoSubmitAtEnd: false });
  assert.equal(app.calls.submissions, 0);
  assert.equal(app.completion.success, true);
  assert.equal(app.completion.cancelled, false);
});

test('an unchanged page after Next does not consume another AI request', async () => {
  const app = quiz({ stuck: true });
  await app.run();
  assert.equal(app.calls.solves.length, 1);
  assert.equal(app.completion.success, false);
  assert.match(app.completion.error, /Next did not advance/);
});

test('an unavailable Next button midway through a known quiz does not trigger submission', async () => {
  const app = quiz({ navigation: () => ({ currentNum: 1, totalNum: 2, hasNext: false, hasSubmit: true }) });
  await app.run();
  assert.equal(app.calls.submissions, 0);
  assert.equal(app.completion.success, false);
});

test('invalid tab still delivers a completion callback', async () => {
  const app = quiz();
  await app.run({ tabId: null });
  assert.equal(app.completion.success, false);
  assert.match(app.completion.error, /No active Chrome tab/);
});

test('mixed numeric and MCQ quizzes fill or select the matching control', async () => {
  const app = quiz({
    questions: [numericQuestion(1), question(2), numericQuestion(3)],
    solve({ page }) { return { answer: ['0', 'B', '-1.5e-3'][page], cacheHit: true }; },
  });
  await app.run();
  assert.equal(app.completion.success, true);
  assert.equal(app.completion.solvedCount, 3);
  assert.equal(app.calls.clicks.length, 1);
  assert.equal(app.calls.fills.length, 2);
  assert.equal(app.calls.fills[0][2], '0');
  assert.equal(app.calls.fills[1][2], '-1.5e-3');
  assert.deepEqual(app.calls.solves[0], { q: 'Calculate value 1', answerType: 'numeric' });
  assert.deepEqual(app.records.map((record) => record.answerType), ['numeric', 'mcq', 'numeric']);
  assert.equal(app.calls.submissions, 1);
});

test('cancellation while waiting for a numeric answer prevents filling', async () => {
  const app = quiz({
    questions: [numericQuestion(1)],
    solve({ isRunningRef }) { isRunningRef.current = false; return { answer: '6.0' }; },
  });
  await app.run();
  assert.equal(app.calls.fills.length, 0);
  assert.equal(app.calls.submissions, 0);
  assert.equal(app.completion.cancelled, true);
});

test('a changed numeric control, type or user-entered value prevents filling', async () => {
  for (const change of ['control', 'type', 'value']) {
    const app = quiz({
      questions: [numericQuestion(1)],
      solve() { return { answer: '6.0' }; },
      extract({ extractionCount, questions }) {
        if (extractionCount !== 2) return null;
        const fresh = structuredClone(questions[0]);
        if (change === 'control') fresh.targetDescriptor.id = 'different-input';
        if (change === 'type') { fresh.answerType = 'mcq'; fresh.options = question(1).options; }
        if (change === 'value') fresh.inputValue = '42';
        return { questions: [fresh] };
      },
    });
    await app.run();
    assert.equal(app.calls.fills.length, 0, change);
    assert.equal(app.calls.clicks.length, 0, change);
    assert.equal(app.completion.success, false, change);
    assert.match(app.completion.error, /changed/);
  }
});

test('malformed numeric answers never reach the page', async () => {
  for (const answer of ['6 registers', '1/2', 'Infinity', '1e400', '']) {
    const app = quiz({ questions: [numericQuestion(1)], solve() { return { answer }; } });
    await app.run();
    assert.equal(app.calls.fills.length, 0);
    assert.equal(app.completion.success, false);
  }
});

test('numeric fill failure stops a mixed quiz without reporting partial success', async () => {
  const app = quiz({
    questions: [question(1), numericQuestion(2)],
    solve({ page }) { return { answer: page ? '6.0' : 'B' }; },
    fill() { return { success: false, failureReason: 'Input rejected value' }; },
  });
  await app.run();
  assert.equal(app.completion.success, false);
  assert.equal(app.completion.solvedCount, 1);
  assert.match(app.completion.error, /Input rejected value/);
  assert.equal(app.records[1].answerType, 'numeric');
  assert.equal(app.records[1].selected, false);
  assert.equal(app.calls.submissions, 0);
});

test('a filled numeric question that does not advance is not requested again', async () => {
  const app = quiz({
    questions: [numericQuestion(1), question(2)],
    stuck: true,
    solve() { return { answer: '6.0' }; },
  });
  await app.run();
  assert.equal(app.calls.solves.length, 1);
  assert.equal(app.calls.fills.length, 1);
  assert.equal(app.completion.success, false);
  assert.match(app.completion.error, /Next did not advance/);
});

test('a revision page with several questions directs users to individual solves before API or writes', async () => {
  const questions = [numericQuestion(1), question(2), question(3), question(4)];
  const app = quiz({
    questions,
    extract() { return { questions }; },
    navigation() { return { currentNum: null, totalNum: null, hasNext: false, hasSubmit: false }; },
  });
  await app.run();
  assert.equal(app.calls.solves.length, 0);
  assert.equal(app.calls.fills.length, 0);
  assert.equal(app.calls.clicks.length, 0);
  assert.equal(app.calls.submissions, 0);
  assert.equal(app.completion.success, false);
  assert.match(app.completion.error, /Inspect DOM.*individual question card/);
});

for (const answerType of ['mcq', 'numeric']) {
  test(`a changed diagram prevents a stale ${answerType} answer from being applied`, async () => {
    const initial = answerType === 'numeric' ? numericQuestion(1) : question(1);
    const images = ['https://example.test/first.png', 'https://example.test/second.png'];
    const app = quiz({ questions: [{ ...initial, images }],
      solve: () => ({ answer: answerType === 'numeric' ? '42' : 'B' }),
      extract({ extractionCount, questions }) {
        if (extractionCount !== 2) return null;
        return { questions: [{ ...questions[0], images: [...images].reverse() }] };
      },
    });
    await app.run();
    assert.equal(app.calls.solves.length, 1);
    assert.equal(app.calls.clicks.length, 0);
    assert.equal(app.calls.fills.length, 0);
    assert.equal(app.calls.submissions, 0);
    assert.equal(app.completion.success, false);
  });
}

test('automatically clicks Start Test on an overview page and solves the quiz', async () => {
  let startClicked = false;
  const questions = [question(1)];
  const app = quiz({
    questions,
    startPage() {
      startClicked = true;
      return { handled: true, buttonText: 'Start Test' };
    },
    solve: () => ({ answer: 'B', cacheHit: true, usage: { total_tokens: 10 } }),
  });
  await app.run();
  assert.equal(startClicked, true);
  assert.equal(app.calls.solves.length, 1);
  assert.equal(app.calls.clicks.length, 1);
  assert.equal(app.calls.submissions, 1);
  assert.equal(app.completion.success, true);
});
