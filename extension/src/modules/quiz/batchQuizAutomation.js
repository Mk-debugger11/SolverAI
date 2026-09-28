import {
  detectAssessmentsCatalog,
  clickQuizCardOnCatalog,
  waitForQuizQuestionsToLoad,
  navigateBackToCatalog,
  waitForCatalogToLoad,
} from './quizDom';
import { runFullQuizAutomation } from './quizAutomation';

/**
 * Orchestrates batch quiz completion across the Newton School assessments catalog:
 * 1. Scans catalog for all unsolved quizzes (0/X XP, unattempted icon).
 * 2. Clicks and opens each unsolved quiz sequentially.
 * 3. Handles instructions/start button if present.
 * 4. Runs full quiz automation (answers Q1..QN via LLM, clicks Next, Submits, Confirms Yes).
 * 5. Navigates back to the catalog, verifies completion, and repeats for all remaining unsolved quizzes.
 *
 * @param {Object} options
 * @param {number} options.tabId
 * @param {Object} options.llmConfig - { apiKey, model }
 * @param {boolean} options.turboMode
 * @param {number} options.maxTokens
 * @param {number} [options.stepDelayMs=500]
 * @param {number} [options.quizDelayMs=2000]
 * @param {Object} options.isBatchRunningRef - React ref controlling batch execution
 * @param {Function} options.onBatchStatus - Status banner updates
 * @param {Function} options.onBatchProgress - Overall batch progress ({ currentQuizIndex, totalQuizzes, currentQuizTitle, percentage, questionProgress })
 * @param {Function} options.onQuizStarted - Called when a quiz is opened
 * @param {Function} options.onQuizCompleted - Called when a quiz finishes and is submitted
 * @param {Function} options.onQuestionSolved - Called when any individual question is solved
 * @param {Function} options.onComplete - Called when the entire batch finishes
 */
export async function runBatchQuizAutomation({
  tabId,
  llmConfig,
  turboMode,
  maxTokens,
  stepDelayMs = 500,
  quizDelayMs = 2000,
  isBatchRunningRef,
  onBatchStatus,
  onBatchProgress,
  onQuizStarted,
  onQuizCompleted,
  onQuestionSolved,
  onComplete,
}) {
  if (!tabId) {
    onBatchStatus?.({ type: 'error', text: 'No active Chrome tab found.' });
    return;
  }

  const attemptedQuizKeys = new Set();
  const successfulQuizzes = [];
  const failedQuizzes = [];

  const makeQuizKey = (q) => `${q.subject || ''}:::${q.title || ''}:::${q.date || ''}`;

  try {
    // 1. Initial Catalog Detection
    let catalogInfo = await detectAssessmentsCatalog(tabId);
    let catalogUrl = catalogInfo.currentUrl;

    if (!catalogInfo.isCatalog) {
      // Check if user is on a course sub-page (e.g. /details or /assessment/...)
      if (catalogUrl && catalogUrl.includes('/course/')) {
        const derivedCatalogUrl = catalogUrl.replace(
          /\/(details|assessment\/.*|all_assessments\/.*)$/,
          '/all_assessments'
        );
        onBatchStatus?.({
          type: 'info',
          text: 'Navigating to Assessments Catalog (all_assessments)...',
        });
        await chrome.tabs.update(tabId, { url: derivedCatalogUrl });
        const loadRes = await waitForCatalogToLoad(tabId, 12000);
        if (loadRes.ready) {
          catalogInfo = loadRes.catalogInfo;
          catalogUrl = derivedCatalogUrl;
        }
      }
    }

    if (!catalogInfo.isCatalog) {
      throw new Error(
        'Please open the Newton School "My Assessments" page (all_assessments) to start batch auto-solve.'
      );
    }

    const initialUnsolved = (catalogInfo.quizzes || []).filter((q) => q.isUnsolved);
    const totalToSolve = initialUnsolved.length;

    if (totalToSolve === 0) {
      onBatchStatus?.({
        type: 'success',
        text: 'All assessments on this page are already solved! No pending quizzes found.',
      });
      return;
    }

    onBatchStatus?.({
      type: 'info',
      text: `Found ${totalToSolve} unsolved quizzes. Starting Batch Auto-Solve...`,
    });

    onBatchProgress?.({
      currentQuizIndex: 1,
      totalQuizzes: totalToSolve,
      currentQuizTitle: initialUnsolved[0]?.title || '',
      percentage: 0,
    });

    let completedCount = 0;
    let consecutiveQuizFailures = 0;

    // 2. Main Batch Loop
    while (isBatchRunningRef.current) {
      // Re-scan catalog to get current state
      const liveCatalog = await detectAssessmentsCatalog(tabId);
      const pendingQuizzes = (liveCatalog.quizzes || []).filter(
        (q) => q.isUnsolved && !attemptedQuizKeys.has(makeQuizKey(q))
      );

      if (pendingQuizzes.length === 0) {
        // No more unsolved quizzes remaining!
        break;
      }

      const currentQuiz = pendingQuizzes[0];
      const quizIndexNum = completedCount + 1;
      attemptedQuizKeys.add(makeQuizKey(currentQuiz));

      const quizDisplayTitle = `${currentQuiz.subject ? `[${currentQuiz.subject}] ` : ''}${currentQuiz.title}`;

      onBatchProgress?.({
        currentQuizIndex: quizIndexNum,
        totalQuizzes: totalToSolve,
        currentQuizTitle: quizDisplayTitle,
        percentage: Math.round((completedCount / totalToSolve) * 100),
      });

      onBatchStatus?.({
        type: 'info',
        text: `Opening Quiz ${quizIndexNum} of ${totalToSolve}: ${quizDisplayTitle}...`,
      });

      onQuizStarted?.({
        quiz: currentQuiz,
        quizNum: quizIndexNum,
        totalQuizzes: totalToSolve,
      });

      // 3. Track existing tabs before clicking the assessment card
      let catalogWindowId = null;
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        try {
          const catTab = await chrome.tabs.get(tabId);
          catalogWindowId = catTab.windowId;
        } catch {}
      }

      let existingTabIds = new Set();
      if (typeof chrome !== 'undefined' && chrome.tabs) {
        try {
          const winTabs = catalogWindowId
            ? await chrome.tabs.query({ windowId: catalogWindowId })
            : await chrome.tabs.query({});
          existingTabIds = new Set(winTabs.map((t) => t.id));
        } catch {}
      }

      // Attach chrome.tabs.onCreated listener to immediately capture the new tab opened
      let newlyCreatedTabId = null;
      const onTabCreated = (t) => {
        if (!newlyCreatedTabId) {
          if (!catalogWindowId || t.windowId === catalogWindowId || t.openerTabId === tabId) {
            newlyCreatedTabId = t.id;
          }
        }
      };

      if (typeof chrome !== 'undefined' && chrome.tabs?.onCreated) {
        chrome.tabs.onCreated.addListener(onTabCreated);
      }

      const clickRes = await clickQuizCardOnCatalog(tabId, {
        title: currentQuiz.title,
        subject: currentQuiz.subject,
        cardIndex: currentQuiz.cardIndex,
      });

      if (!clickRes.success) {
        if (typeof chrome !== 'undefined' && chrome.tabs?.onCreated) {
          chrome.tabs.onCreated.removeListener(onTabCreated);
        }
        throw new Error(`Failed to open quiz card "${currentQuiz.title}": ${clickRes.error}`);
      }

      // Detect if click spawned a new tab or navigated current tab
      let quizTabId = tabId;
      let openedInNewTab = false;

      for (let i = 0; i < 25; i++) {
        if (newlyCreatedTabId) {
          quizTabId = newlyCreatedTabId;
          openedInNewTab = true;
          break;
        }
        if (typeof chrome !== 'undefined' && chrome.tabs) {
          try {
            const currentTabs = catalogWindowId
              ? await chrome.tabs.query({ windowId: catalogWindowId })
              : await chrome.tabs.query({});
            const foundNew = currentTabs.find((t) => !existingTabIds.has(t.id));
            if (foundNew) {
              quizTabId = foundNew.id;
              openedInNewTab = true;
              break;
            }
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      if (typeof chrome !== 'undefined' && chrome.tabs?.onCreated) {
        chrome.tabs.onCreated.removeListener(onTabCreated);
      }

      if (openedInNewTab) {
        try {
          await chrome.tabs.update(quizTabId, { active: true });
        } catch {}

        // Wait for tab document to reach complete status and have a non-blank URL
        for (let wait = 0; wait < 35; wait++) {
          try {
            const tInfo = await chrome.tabs.get(quizTabId);
            if (
              tInfo &&
              tInfo.status === 'complete' &&
              tInfo.url &&
              !tInfo.url.startsWith('about:')
            ) {
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 250));
        }

        // Brief delay to allow Next.js runtime to bootstrap
        await new Promise((r) => setTimeout(r, 800));
      }

      if (!isBatchRunningRef.current) break;

      // 4. Wait for quiz questions or instructions page to load on quizTabId
      onBatchStatus?.({
        type: 'info',
        text: `Waiting for quiz questions or start page to load for Quiz ${quizIndexNum}: ${currentQuiz.subject}...`,
      });

      const readyRes = await waitForQuizQuestionsToLoad(quizTabId, 30000);
      if (!readyRes.ready) {
        console.warn(`Questions did not load for quiz: ${currentQuiz.title}`);
        failedQuizzes.push({ quiz: currentQuiz, error: 'Questions did not load within timeout.' });
        onBatchStatus?.({
          type: 'error',
          text: `Questions did not load for Quiz ${quizIndexNum}: "${currentQuiz.title}". Tab #${quizTabId} is left open for inspection.`,
        });

        // SAFE: Do NOT remove quizTabId. Refocus catalog and proceed
        if (openedInNewTab) {
          try { await chrome.tabs.update(tabId, { active: true }); } catch {}
        } else {
          await navigateBackToCatalog(tabId, catalogUrl);
          await waitForCatalogToLoad(tabId, 10000);
        }
        completedCount++;
        continue;
      }

      if (!isBatchRunningRef.current) break;

      // 5. Solve the full quiz via runFullQuizAutomation using isolated singleQuizRunningRef on quizTabId
      const singleQuizRunningRef = { current: true };
      const cancelSyncTimer = setInterval(() => {
        if (!isBatchRunningRef.current) {
          singleQuizRunningRef.current = false;
        }
      }, 150);

      let singleQuizResult = { success: false, error: null };

      try {
        await new Promise((resolve) => {
          runFullQuizAutomation({
            tabId: quizTabId,
            llmConfig,
            turboMode,
            maxTokens,
            autoSubmitAtEnd: true,
            stepDelayMs,
            isRunningRef: singleQuizRunningRef,
            onStatus: (st) => {
              onBatchStatus?.({
                ...st,
                text: `[Quiz ${quizIndexNum}/${totalToSolve}] ${st.text}`,
              });
            },
            onProgress: (prog) => {
              onBatchProgress?.({
                currentQuizIndex: quizIndexNum,
                totalQuizzes: totalToSolve,
                currentQuizTitle: quizDisplayTitle,
                questionProgress: prog,
                percentage: Math.round(
                  ((completedCount + (prog.percentage || 0) / 100) / totalToSolve) * 100
                ),
              });
            },
            onQuestionSolved: (rec) => {
              onQuestionSolved?.({
                ...rec,
                quizNum: quizIndexNum,
                quizSubject: currentQuiz.subject,
                quizTitle: currentQuiz.title,
              });
            },
            onComplete: (res) => {
              if (res && typeof res.success === 'boolean') {
                singleQuizResult.success = res.success;
                singleQuizResult.error = res.error;
              } else {
                singleQuizResult.success = true;
              }
              resolve();
            },
          }).catch((err) => {
            singleQuizResult.error = err.message;
            resolve();
          });
        });
      } finally {
        clearInterval(cancelSyncTimer);
      }

      if (!isBatchRunningRef.current) {
        onBatchStatus?.({
          type: 'info',
          text: 'Batch Auto-Solve paused by user.',
        });
        break;
      }

      completedCount++;

      if (singleQuizResult.success) {
        consecutiveQuizFailures = 0;
        successfulQuizzes.push(currentQuiz);
        onQuizCompleted?.({
          quiz: currentQuiz,
          quizNum: quizIndexNum,
          success: true,
        });

        onBatchStatus?.({
          type: 'success',
          text: `Solved & Submitted Quiz ${quizIndexNum} of ${totalToSolve}: ${currentQuiz.subject}! Returning to catalog...`,
        });
      } else {
        consecutiveQuizFailures++;
        failedQuizzes.push({ quiz: currentQuiz, error: singleQuizResult.error });
        onQuizCompleted?.({
          quiz: currentQuiz,
          quizNum: quizIndexNum,
          success: false,
          error: singleQuizResult.error,
        });

        onBatchStatus?.({
          type: 'error',
          text: `Quiz ${quizIndexNum} encountered an issue (${singleQuizResult.error || 'unsolved'}). Tab #${quizTabId} is left open for review.`,
        });

        if (consecutiveQuizFailures >= 3) {
          onBatchStatus?.({
            type: 'error',
            text: `Batch Auto-Solve paused: 3 consecutive quizzes encountered errors (${singleQuizResult.error || 'unsolved'}). Please inspect tab #${quizTabId} or check connection.`,
          });
          isBatchRunningRef.current = false;
          break;
        }
      }

      // 6. Return to catalog: ONLY close new tab IF quiz was successfully solved & submitted!
      await new Promise((r) => setTimeout(r, 1200));
      if (!isBatchRunningRef.current) break;

      onBatchStatus?.({
        type: 'info',
        text: `Returning to Assessments Catalog...`,
      });

      if (openedInNewTab) {
        if (singleQuizResult.success) {
          // Successfully solved & submitted: safely remove quiz tab and refocus catalog
          try {
            await chrome.tabs.remove(quizTabId);
          } catch {}
          try {
            await chrome.tabs.update(tabId, { active: true });
          } catch {}
          await new Promise((r) => setTimeout(r, 600));
        } else {
          // Quiz was NOT completely solved: LEAVE TAB OPEN so user can inspect!
          onBatchStatus?.({
            type: 'warning',
            text: `Quiz ${quizIndexNum} was not fully submitted. Tab #${quizTabId} is left open for review. Refocusing catalog...`,
          });
          try {
            await chrome.tabs.update(tabId, { active: true });
          } catch {}
          await new Promise((r) => setTimeout(r, 800));
        }
      } else {
        await navigateBackToCatalog(tabId, catalogUrl);
        await waitForCatalogToLoad(tabId, 12000);
      }

      // Brief delay between quizzes to allow catalog DOM to settle
      if (isBatchRunningRef.current && completedCount < totalToSolve) {
        await new Promise((r) => setTimeout(r, quizDelayMs));
      }
    }

    // 7. Final Completion
    if (isBatchRunningRef.current) {
      onBatchProgress?.({
        currentQuizIndex: totalToSolve,
        totalQuizzes: totalToSolve,
        currentQuizTitle: 'Batch Completed',
        percentage: 100,
      });

      onBatchStatus?.({
        type: 'success',
        text: `Batch Auto-Solve Complete! Successfully solved ${successfulQuizzes.length} of ${totalToSolve} quizzes.${
          failedQuizzes.length > 0 ? ` (${failedQuizzes.length} skipped or failed)` : ''
        }`,
      });
    }
  } catch (err) {
    console.error('Batch Quiz Automation Error:', err);
    onBatchStatus?.({
      type: 'error',
      text: `Batch Auto-Solve interrupted: ${err.message}`,
    });
  } finally {
    isBatchRunningRef.current = false;
    onComplete?.({
      totalAttempted: attemptedQuizKeys.size,
      totalSuccessful: successfulQuizzes.length,
      failedQuizzes,
    });
  }
}
