import {
  extractQuizQuestionsFromPage,
  clickQuizOptionOnPage,
  fillQuizNumericAnswerOnPage,
  getQuizNavigationInfo,
  clickNextQuestionOnPage,
  waitForNextQuestionToRender,
  clickSubmitQuizOnPage,
  handleStartOrInstructionsPage,
} from './quizDom';
import { formatLlmPayload, normalizeNumericAnswer, solveMcq } from '../llm/llmService';

const isQuestionNumber = (value) => Number.isInteger(value) && value > 0;
const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function questionIdentity(question) {
  const payload = formatLlmPayload(question);
  const answerType = payload.answerType || 'mcq';
  return JSON.stringify({
    answerType,
    id: question.questionId || null,
    group: question.groupName || null,
    text: normalizeText(payload.q),
    options: Object.entries(payload.o || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, normalizeText(value)]),
    images: payload.images || [],
    // Numeric controls have no choices to anchor the answer to. Match the
    // control's stable context; its editable value is checked separately.
    input: answerType === 'numeric'
      ? Object.entries(question.targetDescriptor || {}).filter(([key]) => key !== 'inputValue')
        .sort(([a], [b]) => a.localeCompare(b))
      : null,
  });
}

/**
 * Orchestrates full quiz auto-solve: loops through questions, solves via LLM,
 * selects or fills the answer, advances to Next, and optionally submits at the end.
 *
 * @param {Object} options
 * @param {number} options.tabId
 * @param {Object} options.llmConfig - { apiKey, model }
 * @param {boolean} options.turboMode
 * @param {number} options.maxTokens
 * @param {boolean} options.autoSubmitAtEnd
 * @param {number} [options.stepDelayMs=500]
 * @param {Object} options.isRunningRef - React ref controlling execution
 * @param {Function} options.onStatus - Status update callback
 * @param {Function} options.onProgress - Progress update callback ({ current, total, percentage })
 * @param {Function} options.onQuestionSolved - Callback when a question is solved ({ record })
 * @param {Function} options.onComplete - Callback when automation finishes
 */
export async function runFullQuizAutomation({
  tabId,
  llmConfig,
  turboMode,
  maxTokens,
  autoSubmitAtEnd,
  stepDelayMs = 500,
  isRunningRef,
  onStatus,
  onProgress,
  onQuestionSolved,
  onComplete,
}) {
  let currentQuestionNum = 1;
  let totalQuestions = null;
  let lastQuestionIdentity = null;
  let solvedQuestionsCount = 0;
  let automationError = null;
  let reachedEnd = false;
  let completed = false;

  try {
    if (!tabId) throw new Error('No active Chrome tab found.');

    // 0. Automatically check for "Start Test" / "Start Assessment" overview page and click it
    try {
      const startRes = await handleStartOrInstructionsPage(tabId);
      if (startRes?.handled) {
        onStatus?.({
          type: 'info',
          text: `Clicked "${startRes.buttonText}". Starting quiz and waiting for questions to mount...`,
        });
        await new Promise((r) => setTimeout(r, 1200));
      }
    } catch {}

    while (isRunningRef.current) {
      // 1. Check live quiz navigation on page
      const navInfo = await getQuizNavigationInfo(tabId);
      if (navInfo) {
        if (isQuestionNumber(navInfo.currentNum)) currentQuestionNum = navInfo.currentNum;
        if (isQuestionNumber(navInfo.totalNum)) totalQuestions = navInfo.totalNum;
      }
      if (!isRunningRef.current) break;

      onProgress?.({
        current: currentQuestionNum,
        total: totalQuestions,
        percentage: totalQuestions ? Math.round(((currentQuestionNum - 1) / totalQuestions) * 100) : 0,
      });

      onStatus?.({
        type: 'info',
        text: `Solving Question ${currentQuestionNum}${totalQuestions ? ` of ${totalQuestions}` : ''}. The backend checks its cache and waits for API capacity if needed.`,
      });

      // 2. Wait for React to mount the question and its answer controls.
      let questions = [];
      for (let attempt = 0; attempt < 25; attempt++) {
        if (!isRunningRef.current) break;
        const domData = await extractQuizQuestionsFromPage(tabId, true);
        if (domData?.questions?.length > 0) {
          questions = domData.questions;
          break;
        }
        if (attempt === 3 || attempt === 8) {
          try {
            const retryStart = await handleStartOrInstructionsPage(tabId);
            if (retryStart?.handled) {
              onStatus?.({
                type: 'info',
                text: `Clicked "${retryStart.buttonText}". Mounting questions...`,
              });
              await new Promise((r) => setTimeout(r, 1000));
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 400));
        if (!isRunningRef.current) break;
      }
      if (!isRunningRef.current) break;

      if (!questions.length) {
        throw new Error(`Could not find an answerable question on Question ${currentQuestionNum}.`);
      }
      if (questions.length > 1 && !navInfo?.hasNext && !navInfo?.hasSubmit) {
        throw new Error('This page displays several questions together without quiz navigation. Use Inspect DOM, then Solve on an individual question card.');
      }

      const q = questions[0];
      const currentQText = normalizeText(q.questionText);
      const identity = questionIdentity(q);

      // Avoid spending another request if Next did not change the question.
      if (identity === lastQuestionIdentity) {
        throw new Error('Next did not advance past the previous question. Auto-Solve stopped before requesting it again.');
      }

      const payload = formatLlmPayload(q);
      const answerType = payload.answerType || 'mcq';

      // 3. Query LLM Solver
      const tSolveStart = performance.now();
      const solution = await solveMcq(payload, {
        apiKey: llmConfig?.apiKey,
        model: llmConfig?.model,
        turbo: turboMode,
        maxTokens,
      });
      if (!isRunningRef.current) break;

      const answer = answerType === 'numeric'
        ? normalizeNumericAnswer(solution.answer)
        : String(solution.answer ?? '').toUpperCase().trim();
      if (answerType === 'mcq' && !Object.hasOwn(payload.o, answer)) {
        throw new Error(`The solver returned an invalid option for Question ${currentQuestionNum}.`);
      }

      // A paced request can take a while. Confirm that the page still shows
      // the same question and choices, and use its latest input descriptors.
      const freshData = await extractQuizQuestionsFromPage(tabId, true);
      if (!isRunningRef.current) break;
      const freshQuestion = freshData?.questions?.[0];
      const inputChanged = answerType === 'numeric' &&
        String(freshQuestion?.inputValue ?? freshQuestion?.targetDescriptor?.inputValue ?? '') !==
        String(q.inputValue ?? q.targetDescriptor?.inputValue ?? '');
      if (!freshQuestion || questionIdentity(freshQuestion) !== identity || inputChanged) {
        throw new Error('The question or options changed, or the input was edited while waiting. No answer was applied.');
      }

      // 4. Apply the answer using the current page's matching control.
      let applyResult;
      if (answerType === 'numeric') {
        if (!freshQuestion.targetDescriptor) {
          throw new Error(`Could not identify the numeric input for Question ${currentQuestionNum}.`);
        }
        applyResult = await fillQuizNumericAnswerOnPage(tabId, freshQuestion.targetDescriptor, answer);
      } else {
        const targetOptIndex = (freshQuestion.options || []).findIndex(
          (option, index) => (option.optionLetter || String.fromCharCode(65 + index)).toUpperCase() === answer
        );
        if (targetOptIndex < 0) {
          throw new Error(`Option ${answer} is not present on Question ${currentQuestionNum}.`);
        }
        const targetOpt = freshQuestion.options[targetOptIndex];
        const clickDescriptor = {
          ...(targetOpt.targetDescriptor || {}),
          optionLetter: answer,
          name: freshQuestion.groupName,
          index: targetOptIndex,
        };
        applyResult = await clickQuizOptionOnPage(tabId, clickDescriptor, targetOptIndex, freshQuestion.groupName);
      }

      const tTotal = Math.round(performance.now() - tSolveStart);
      if (applyResult?.success) {
        solvedQuestionsCount++;
      }

      const record = {
        qNum: currentQuestionNum,
        question: (q.questionText || '').slice(0, 50),
        answer,
        answerType,
        reason: solution.reason,
        cacheHit: solution.cacheHit,
        deduplicated: solution.deduplicated,
        usage: solution.usage,
        totalTime: tTotal,
        selected: Boolean(applyResult?.success),
        selectionError: applyResult?.success ? null : applyResult?.failureReason || 'The answer could not be applied',
      };

      onQuestionSolved?.(record);

      if (!applyResult?.success) {
        throw new Error(`Q${currentQuestionNum}: ${answerType === 'numeric' ? 'answer' : 'Option'} ${answer} could not be applied: ${applyResult?.failureReason || 'Answer control did not update'}.`);
      }
      if (!isRunningRef.current) break;
      lastQuestionIdentity = identity;

      // Check if there are further questions
      const currentNav = await getQuizNavigationInfo(tabId);
      if (!isRunningRef.current) break;
      if (isQuestionNumber(currentNav?.totalNum)) totalQuestions = currentNav.totalNum;
      const visibleQuestionNum = isQuestionNumber(currentNav?.currentNum)
        ? currentNav.currentNum : currentQuestionNum;
      const isLastQuestion = totalQuestions !== null
        ? visibleQuestionNum >= totalQuestions
        : currentNav?.hasNext === false && currentNav?.hasSubmit === true;

      if (!isLastQuestion) {
        if (!currentNav?.hasNext) {
          throw new Error(`Could not confirm the end of the quiz or find Next after Question ${currentQuestionNum}.`);
        }
        onStatus?.({
          type: 'info',
          text: `Q${currentQuestionNum}: ${answerType === 'numeric' ? `entered ${answer}` : `selected Option ${answer}`}${solution.cacheHit ? ' using a cached answer (no API request)' : solution.deduplicated ? ' using a shared request' : ''}. Advancing to Next...`,
        });

        await new Promise((r) => setTimeout(r, stepDelayMs));
        if (!isRunningRef.current) break;

        const advanced = await clickNextQuestionOnPage(tabId);
        if (!advanced) {
          throw new Error(`Failed to click "Next" button after Question ${currentQuestionNum}.`);
        }

        const rendered = await waitForNextQuestionToRender(tabId, currentQText, currentQuestionNum);
        if (!isRunningRef.current) break;
        if (rendered === false) throw new Error('The next question did not finish loading.');
        currentQuestionNum++;
      } else {
        reachedEnd = true;
        totalQuestions ??= currentQuestionNum;
        break;
      }
    }

    // 5. Post-Quiz Completion: Submit Quiz
    if (reachedEnd && isRunningRef.current) {
      onProgress?.({
        current: totalQuestions,
        total: totalQuestions,
        percentage: 100,
      });

      if (autoSubmitAtEnd) {
        onStatus?.({ type: 'info', text: '⚡ Submitting quiz on webpage...' });
        await new Promise((r) => setTimeout(r, 600));
        if (!isRunningRef.current) return;

        const submitRes = await clickSubmitQuizOnPage(tabId);
        if (!isRunningRef.current) return;
        if (submitRes?.success) {
          onStatus?.({
            type: 'success',
            text: submitRes.confirmed
              ? `🎉 All ${totalQuestions} Questions Solved & Quiz Submitted Successfully!`
              : `🎉 All ${totalQuestions} Questions Solved & Quiz Submitted!`,
          });
        } else {
          throw new Error(`Answers were applied, but the quiz could not be submitted: ${submitRes?.reason || 'Submit failed'}.`);
        }
      } else {
        onStatus?.({
          type: 'success',
          text: `✓ All ${totalQuestions} Questions Solved! Auto-submit is turned off.`,
        });
      }
      completed = true;
    }
  } catch (err) {
    automationError = err;
    console.error('Quiz automation error:', err);
    onStatus?.({
      type: 'error',
      text: `Auto-Solve interrupted: ${err.message}`,
    });
  } finally {
    const cancelled = !automationError && !isRunningRef.current;
    if (cancelled) onStatus?.({ type: 'info', text: 'Auto-Solve stopped.' });
    isRunningRef.current = false;
    onComplete?.({
      success: completed && !automationError && !cancelled,
      cancelled,
      solvedCount: solvedQuestionsCount,
      error: automationError ? automationError.message : null,
      errorStatus: automationError?.status ?? null,
    });
  }
}
