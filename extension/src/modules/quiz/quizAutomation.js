import {
  extractQuizQuestionsFromPage,
  clickQuizOptionOnPage,
  getQuizNavigationInfo,
  clickNextQuestionOnPage,
  waitForNextQuestionToRender,
  clickSubmitQuizOnPage,
} from './quizDom';
import { formatLlmPayload, solveMcq } from '../llm/llmService';

/**
 * Orchestrates full quiz auto-solve: loops through questions, solves via LLM,
 * clicks target option, advances to Next, and automatically submits quiz at the end.
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
  if (!tabId) {
    onStatus?.({ type: 'error', text: 'No active Chrome tab found.' });
    return;
  }

  let currentQuestionNum = 1;
  let totalQuestions = 8;
  let consecutiveStuckCount = 0;
  let lastQuestionText = '';
  let solvedQuestionsCount = 0;
  let automationError = null;

  try {
    while (isRunningRef.current) {
      // 1. Check live quiz navigation on page
      const navInfo = await getQuizNavigationInfo(tabId);
      if (navInfo) {
        if (navInfo.currentNum) currentQuestionNum = navInfo.currentNum;
        if (navInfo.totalNum) totalQuestions = navInfo.totalNum;
      }

      onProgress?.({
        current: currentQuestionNum,
        total: totalQuestions,
        percentage: Math.round(((currentQuestionNum - 1) / totalQuestions) * 100),
      });

      onStatus?.({
        type: 'info',
        text: `⚡ Solving Question ${currentQuestionNum} of ${totalQuestions}...`,
      });

      // 2. Extract DOM questions with retry polling to allow React to mount radios
      let questions = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const domData = await extractQuizQuestionsFromPage(tabId, true);
        if (domData?.questions?.length > 0) {
          questions = domData.questions;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
        if (!isRunningRef.current) break;
      }

      if (!questions.length) {
        throw new Error(`Could not find radio question on Question ${currentQuestionNum}.`);
      }

      const q = questions[0];
      const currentQText = (q.questionText || '').replace(/\s+/g, ' ').trim();

      // Stuck detection safeguard
      if (currentQText && currentQText === lastQuestionText) {
        consecutiveStuckCount++;
        if (consecutiveStuckCount >= 2) {
          throw new Error(
            `Repeatedly stuck on Question ${currentQuestionNum}. Next button did not advance the question.`
          );
        }
      } else {
        consecutiveStuckCount = 0;
        lastQuestionText = currentQText;
      }

      const payload = formatLlmPayload(q);

      // 3. Query LLM Solver with automatic rate-limit cooldown, retries, and fallback
      const tSolveStart = performance.now();
      let solution = null;

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          solution = await solveMcq(payload, {
            apiKey: llmConfig?.apiKey,
            model: llmConfig?.model,
            turbo: turboMode,
            maxTokens: turboMode ? 512 : (maxTokens || 2048),
          });
          break;
        } catch (llmErr) {
          const isRateLimit =
            llmErr.message?.includes('Rate limit') ||
            llmErr.message?.includes('429') ||
            llmErr.message?.includes('OTPM') ||
            llmErr.message?.includes('TPM') ||
            llmErr.message?.includes('try again in');

          if (isRateLimit && attempt < 3) {
            const secMatch = llmErr.message.match(/try again in ([\d\.]+)s/i);
            const waitSec = secMatch ? Math.ceil(parseFloat(secMatch[1])) + 1 : 8;

            for (let s = waitSec; s > 0; s--) {
              if (!isRunningRef.current) break;
              onStatus?.({
                type: 'warning',
                text: `⏳ Groq Rate Limit reached. Cooling down for ${s}s before solving Q${currentQuestionNum}...`,
              });
              await new Promise((r) => setTimeout(r, 1000));
            }

            if (!isRunningRef.current) break;
            continue;
          }

          // Non-rate-limit error (e.g. temporary JSON validation or network hiccup)
          if (attempt < 3) {
            console.warn(`[Q${currentQuestionNum}] LLM attempt ${attempt + 1} failed: ${llmErr.message}. Retrying...`);
            onStatus?.({
              type: 'warning',
              text: `⚠️ Q${currentQuestionNum} solver attempt failed (${llmErr.message.slice(0, 45)}...). Retrying...`,
            });
            await new Promise((r) => setTimeout(r, 1200));
            if (!isRunningRef.current) break;
            continue;
          }

          // Resilient fallback: If all 4 attempts failed, select Option A / first available option rather than crashing the whole quiz
          console.warn(`[Q${currentQuestionNum}] All solver attempts failed: ${llmErr.message}. Using safe fallback.`);
          const fallbackLetter = (q.options?.[0]?.optionLetter || 'A').toUpperCase();
          solution = {
            answer: fallbackLetter,
            confidence: 50,
            reason: `⚠️ Fallback answer (solver recovery: ${llmErr.message.slice(0, 50)})`,
          };
          break;
        }
      }

      if (!solution) {
        const fallbackLetter = (q.options?.[0]?.optionLetter || 'A').toUpperCase();
        solution = {
          answer: fallbackLetter,
          confidence: 50,
          reason: '⚠️ Fallback answer (solver timed out)',
        };
      }

      const answerLetter = (solution.answer || '').toUpperCase().trim();
      const targetOpt = (q.options || []).find(
        (o) => (o.optionLetter || '').toUpperCase() === answerLetter
      ) || (q.options || [])[answerLetter.charCodeAt(0) - 65];
      const targetOptIndex = targetOpt
        ? (q.options || []).indexOf(targetOpt)
        : (answerLetter.charCodeAt(0) - 65);

      const clickDescriptor = {
        ...(targetOpt?.targetDescriptor || {}),
        optionLetter: answerLetter,
        name: q.groupName,
        index: targetOptIndex,
      };

      // 4. Click target option on webpage
      const clickResult = await clickQuizOptionOnPage(
        tabId,
        clickDescriptor,
        targetOptIndex,
        q.groupName
      );

      const tTotal = Math.round(performance.now() - tSolveStart);
      if (clickResult.success) {
        solvedQuestionsCount++;
      }

      const record = {
        qNum: currentQuestionNum,
        question: (q.questionText || '').slice(0, 50),
        answer: answerLetter,
        reason: solution.reason,
        totalTime: tTotal,
        selected: clickResult.success,
        selectionError: clickResult.success ? null : clickResult.failureReason || 'Radio remained unchecked',
      };

      onQuestionSolved?.(record);

      // Stop immediately if option could not be selected
      if (!clickResult.success) {
        isRunningRef.current = false;
        onStatus?.({
          type: 'error',
          text: `🛑 Auto-Solve stopped: Q${currentQuestionNum} (Option ${answerLetter}) could not be selected!`,
          details: clickResult.failureReason || 'Target radio remained unchecked after selection attempt.',
        });
        break;
      }

      // Check if there are further questions
      const currentNav = await getQuizNavigationInfo(tabId);
      const isLastQuestion =
        (currentNav && !currentNav.hasNext) ||
        currentQuestionNum >= totalQuestions ||
        (currentNav && currentNav.currentNum >= currentNav.totalNum);

      if (!isLastQuestion && isRunningRef.current) {
        onStatus?.({
          type: 'info',
          text: `✓ Q${currentQuestionNum} Solved (Option ${answerLetter})! Advancing to Next...`,
        });

        await new Promise((r) => setTimeout(r, stepDelayMs));
        if (!isRunningRef.current) break;

        const advanced = await clickNextQuestionOnPage(tabId);
        if (!advanced) {
          throw new Error(`Failed to click "Next" button after Question ${currentQuestionNum}.`);
        }

        await waitForNextQuestionToRender(tabId, currentQText, currentQuestionNum);
        currentQuestionNum++;
      } else {
        // Final question answered!
        break;
      }
    }

    // 5. Post-Quiz Completion: Submit Quiz
    if (isRunningRef.current) {
      onProgress?.({
        current: totalQuestions,
        total: totalQuestions,
        percentage: 100,
      });

      if (autoSubmitAtEnd) {
        onStatus?.({ type: 'info', text: '⚡ Submitting quiz on webpage...' });
        await new Promise((r) => setTimeout(r, 600));

        const submitRes = await clickSubmitQuizOnPage(tabId);
        if (submitRes.success) {
          onStatus?.({
            type: 'success',
            text: submitRes.confirmed
              ? `🎉 All ${totalQuestions} Questions Solved & Quiz Submitted Successfully!`
              : `🎉 All ${totalQuestions} Questions Solved & Quiz Submitted!`,
          });
        } else {
          onStatus?.({
            type: 'success',
            text: `✓ All ${totalQuestions} Questions Solved! Click "Submit Quiz" on page to finalize.`,
          });
        }
      } else {
        onStatus?.({
          type: 'success',
          text: `✓ All ${totalQuestions} Questions Solved! Auto-submit is turned off.`,
        });
      }
    }
  } catch (err) {
    automationError = err;
    console.error('Quiz automation error:', err);
    onStatus?.({
      type: 'error',
      text: `Auto-Solve interrupted: ${err.message}`,
    });
  } finally {
    isRunningRef.current = false;
    onComplete?.({
      success: !automationError && solvedQuestionsCount > 0,
      solvedCount: solvedQuestionsCount,
      error: automationError ? automationError.message : null,
    });
  }
}
