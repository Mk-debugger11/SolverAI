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
  let batchError = null;
  let consecutiveFailures = 0;
  const isQuizUrl = (value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'my.newtonschool.co') return false;
      if (url.pathname.includes('/all_assessments') || url.pathname.includes('/all_assignments')) return false;
      return (
        /^\/course\/[^/]+\/assessment\/[^/]+/.test(url.pathname) ||
        /\/assessment\/[^/]+/.test(url.pathname) ||
        /\/test\/[^/]+/.test(url.pathname) ||
        /\/quiz\/[^/]+/.test(url.pathname)
      );
    } catch { return false; }
  };

  const makeQuizKey = (q) => `${q.subject || ''}:::${q.title || ''}:::${q.date || ''}`;

  try {
    // 1. Initial Catalog Detection
    let catalogInfo = await detectAssessmentsCatalog(tabId);
    let catalogUrl = catalogInfo.currentUrl;
    if (!isBatchRunningRef.current) return;

    if (!catalogInfo.isCatalog) {
      // Check if user is on a course sub-page (e.g. /details or /assessment/...)
      if (catalogUrl && catalogUrl.includes('/course/')) {
        const derivedCatalogUrl = catalogUrl.replace(
          /\/(details|assessment\/.*|all_assessments\/.*)$/,
          '/all_assessments'
        );
        onBatchStatus?.({
          type: 'info',
          text: '🔄 Navigating to Assessments Catalog (all_assessments)...',
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
        text: '🎉 All assessments on this page are already solved! No pending quizzes found.',
      });
      return;
    }

    onBatchStatus?.({
      type: 'info',
      text: `🚀 Found ${totalToSolve} unsolved quizzes. Starting Batch Auto-Solve...`,
    });

    onBatchProgress?.({
      currentQuizIndex: 1,
      totalQuizzes: totalToSolve,
      currentQuizTitle: initialUnsolved[0]?.title || '',
      percentage: 0,
    });

    let completedCount = 0;

    // 2. Main Batch Loop
    while (isBatchRunningRef.current) {
      // Re-scan catalog to get current state
      const liveCatalog = await detectAssessmentsCatalog(tabId);
      if (!isBatchRunningRef.current) break;
      if (!liveCatalog.isCatalog) throw new Error('The catalog tab changed. Batch automation stopped.');
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
        text: `📂 Opening Quiz ${quizIndexNum} of ${totalToSolve}: ${quizDisplayTitle}...`,
      });

      onQuizStarted?.({
        quiz: currentQuiz,
        quizNum: quizIndexNum,
        totalQuizzes: totalToSolve,
      });

      // Observe tabs before the click. Only a tab opened by this catalog is
      // eligible; unrelated tabs are never selected or closed.
      let quizTabId = tabId;
      let openedInNewTab = false;
      let openedReady = false;
      const createdTabs = new Map();
      const onCreated = (tab) => {
        if (tab.openerTabId === tabId) createdTabs.set(tab.id, tab);
      };
      chrome.tabs.onCreated?.addListener(onCreated);
      try {
        const catalogTab = await chrome.tabs.get(tabId);
        const query = Number.isInteger(catalogTab.windowId) ? { windowId: catalogTab.windowId } : {};
        const before = await chrome.tabs.query(query);
        const existingIds = new Set(before.map((tab) => tab.id));
        if (!isBatchRunningRef.current) break;
        const clickRes = await clickQuizCardOnCatalog(tabId, {
          title: currentQuiz.title,
          subject: currentQuiz.subject,
          cardIndex: currentQuiz.cardIndex,
        });
        if (!clickRes.success) throw new Error(`Failed to open quiz card "${currentQuiz.title}": ${clickRes.error}`);

        for (let poll = 0; poll < 120 && isBatchRunningRef.current; poll++) {
          const tabs = await chrome.tabs.query(query);
          if (!isBatchRunningRef.current) break;
          for (const tab of tabs) {
            if (!existingIds.has(tab.id) && tab.openerTabId === tabId) createdTabs.set(tab.id, tab);
          }
          const candidates = [...createdTabs.values()].filter((tab) => !existingIds.has(tab.id));
          if (candidates.length > 1) throw new Error('The quiz opened multiple tabs. Leave them open and select the intended quiz manually.');
          if (candidates.length === 1) {
            quizTabId = candidates[0].id;
            openedInNewTab = true;
          }
          const current = await chrome.tabs.get(quizTabId);
          if (!isBatchRunningRef.current) break;
          if (isQuizUrl(current.url) && current.status === 'complete') {
            openedReady = true;
            break;
          }
          if (openedInNewTab && current.status === 'complete' && current.url && current.url !== 'about:blank') {
            throw new Error('The new tab is not a supported Newton quiz. It has been left open.');
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        chrome.tabs.onCreated?.removeListener(onCreated);
      }
      if (!isBatchRunningRef.current) break;
      if (!openedReady) throw new Error('The quiz tab could not be identified or did not finish loading. Opened tabs have been left unchanged.');
      await chrome.tabs.update(quizTabId, { active: true });
      if (!isBatchRunningRef.current) break;

      // 4. Wait for quiz questions or instructions page to load on quizTabId
      onBatchStatus?.({
        type: 'info',
        text: `⏳ Waiting for questions to load for Quiz ${quizIndexNum}: ${currentQuiz.subject}...`,
      });

      const readyRes = await waitForQuizQuestionsToLoad(quizTabId, 30000, () => isBatchRunningRef.current);
      if (!isBatchRunningRef.current) break;
      if (!readyRes.ready) {
        console.warn(`Questions did not load for quiz: ${currentQuiz.title}`);
        failedQuizzes.push({ quiz: currentQuiz, error: 'Questions did not load within timeout.' });
        consecutiveFailures++;
        completedCount++;
        if (!openedInNewTab || consecutiveFailures >= 3) {
          throw new Error('Batch stopped after quiz loading failures. The unfinished quiz has been left open.');
        }
        await chrome.tabs.update(tabId, { active: true });
        continue;
      }

      if (!isBatchRunningRef.current) break;

      // 5. Solve the full quiz via runFullQuizAutomation using isolated singleQuizRunningRef on quizTabId
      let childRunning = true;
      const singleQuizRunningRef = {
        get current() { return childRunning && isBatchRunningRef.current; },
        set current(value) { childRunning = value; },
      };

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
                singleQuizResult.errorStatus = res.errorStatus;
              } else {
                singleQuizResult.error = 'Quiz automation did not confirm completion.';
              }
              resolve();
            },
          }).catch((err) => {
            singleQuizResult.error = err.message;
            resolve();
          });
        });
      } finally {
        childRunning = false;
      }

      if (!isBatchRunningRef.current) {
        onBatchStatus?.({
          type: 'info',
          text: '⏹️ Batch Auto-Solve paused by user.',
        });
        break;
      }

      // Further quizzes cannot succeed while the provider rejects this account.
      // Leave the current quiz open so the user can resume after resolving it.
      if ([429, 401, 403].includes(singleQuizResult.errorStatus)) {
        batchError = singleQuizResult.error || 'The AI provider is temporarily unavailable.';
        failedQuizzes.push({ quiz: currentQuiz, error: batchError });
        isBatchRunningRef.current = false;
        onBatchStatus?.({ type: 'error', text: `Batch stopped: ${batchError}` });
        break;
      }

      completedCount++;

      if (singleQuizResult.success) {
        consecutiveFailures = 0;
        successfulQuizzes.push(currentQuiz);
        onQuizCompleted?.({
          quiz: currentQuiz,
          quizNum: quizIndexNum,
          success: true,
        });

        onBatchStatus?.({
          type: 'success',
          text: `🎉 Solved & Submitted Quiz ${quizIndexNum} of ${totalToSolve}: ${currentQuiz.subject}! Returning to catalog...`,
        });
      } else {
        consecutiveFailures++;
        failedQuizzes.push({ quiz: currentQuiz, error: singleQuizResult.error });
        onQuizCompleted?.({
          quiz: currentQuiz,
          quizNum: quizIndexNum,
          success: false,
          error: singleQuizResult.error,
        });

        onBatchStatus?.({
          type: 'error',
          text: `⚠️ Quiz ${quizIndexNum} encountered an issue (${singleQuizResult.error || 'unsolved'}). Returning to catalog...`,
        });
      }

      if (!singleQuizResult.success && (!openedInNewTab || consecutiveFailures >= 3)) {
        throw new Error(singleQuizResult.error || 'Batch stopped after repeated quiz failures.');
      }

      // 6. Return to the catalog, preserving unfinished quizzes for review.
      await new Promise((r) => setTimeout(r, 1200));
      if (!isBatchRunningRef.current) break;

      onBatchStatus?.({
        type: 'info',
        text: `🔄 Returning to Assessments Catalog...`,
      });

      if (openedInNewTab) {
        if (singleQuizResult.success) {
          try { await chrome.tabs.remove(quizTabId); } catch {}
        }
        try {
          await chrome.tabs.update(tabId, { active: true });
        } catch {}
        await new Promise((r) => setTimeout(r, 600));
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
        type: failedQuizzes.length ? 'error' : 'success',
        text: `🏁 Batch Auto-Solve Complete! Successfully solved ${successfulQuizzes.length} of ${totalToSolve} quizzes.${
          failedQuizzes.length > 0 ? ` (${failedQuizzes.length} skipped or failed)` : ''
        }`,
      });
    }
  } catch (err) {
    batchError = err.message;
    console.error('Batch Quiz Automation Error:', err);
    onBatchStatus?.({
      type: 'error',
      text: `Batch Auto-Solve interrupted: ${err.message}`,
    });
  } finally {
    const cancelled = !isBatchRunningRef.current && !batchError;
    isBatchRunningRef.current = false;
    onComplete?.({
      success: !cancelled && !batchError && failedQuizzes.length === 0,
      cancelled,
      error: batchError,
      totalAttempted: attemptedQuizKeys.size,
      totalSuccessful: successfulQuizzes.length,
      failedQuizzes,
    });
  }
}
