import { runBatchQuizAutomation } from './modules/quiz/batchQuizAutomation';
import { runFullQuizAutomation } from './modules/quiz/quizAutomation';

console.log('Solver.Ai Service Worker loaded and active.');

// Global background state
let isBatchRunning = false;
let isSingleRunning = false;
const activeBatchRef = { current: false };
const activeSingleRef = { current: false };

let batchProgress = {
  currentQuizIndex: 0,
  totalQuizzes: 0,
  currentQuizTitle: '',
  percentage: 0,
  questionProgress: null,
};

let singleProgress = {
  current: 0,
  total: 0,
  percentage: 0,
};

let batchCompletedQuizzes = [];
let autoSolvedList = [];
let lastStatusMessage = null;

// Keep-alive timer to prevent Service Worker termination during automation
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try {
      chrome.runtime.getPlatformInfo?.(() => {});
    } catch {}
  }, 10000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function broadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {
      // Ignored: popup is currently closed
    });
  } catch {}
}

function updateBadge(text, color = '#6366f1') {
  try {
    chrome.action.setBadgeText({ text });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch {}
}

function clearBadge() {
  try {
    chrome.action.setBadgeText({ text: '' });
  } catch {}
}

// Listen for messages from popup or options page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};

  if (type === 'GET_AUTOMATION_STATE') {
    sendResponse({
      isBatchRunning,
      isSingleRunning,
      batchProgress,
      singleProgress,
      batchCompletedQuizzes,
      autoSolvedList,
      lastStatusMessage,
    });
    return true;
  }

  if (type === 'START_BATCH_AUTO_SOLVE') {
    if (isBatchRunning) {
      sendResponse({ started: false, reason: 'Batch is already running' });
      return true;
    }

    isBatchRunning = true;
    activeBatchRef.current = true;
    batchCompletedQuizzes = [];
    autoSolvedList = [];
    lastStatusMessage = {
      type: 'info',
      text: 'Background Batch Auto-Solve starting across assessments catalog...',
    };

    startKeepAlive();
    updateBadge('...', '#6366f1');
    sendResponse({ started: true });

    const {
      tabId,
      llmConfig,
      turboMode,
      maxTokens,
      stepDelayMs = 500,
      quizDelayMs = 2000,
    } = message;

    runBatchQuizAutomation({
      tabId,
      llmConfig,
      turboMode,
      maxTokens,
      stepDelayMs,
      quizDelayMs,
      isBatchRunningRef: activeBatchRef,
      onBatchStatus: (st) => {
        lastStatusMessage = st;
        broadcast({ type: 'STATUS_UPDATE', status: st });
      },
      onBatchProgress: (prog) => {
        batchProgress = prog;
        if (prog.currentQuizIndex && prog.totalQuizzes) {
          updateBadge(`${prog.currentQuizIndex}/${prog.totalQuizzes}`, '#6366f1');
        }
        broadcast({ type: 'BATCH_PROGRESS_UPDATE', progress: prog });
      },
      onQuizStarted: (data) => {
        broadcast({ type: 'QUIZ_STARTED', data });
      },
      onQuizCompleted: (data) => {
        if (data.success && data.quiz) {
          batchCompletedQuizzes.push(data.quiz);
        }
        broadcast({ type: 'QUIZ_COMPLETED', data });
      },
      onQuestionSolved: (rec) => {
        autoSolvedList.unshift(rec);
        broadcast({ type: 'QUESTION_SOLVED', record: rec });
      },
      onComplete: () => {
        isBatchRunning = false;
        activeBatchRef.current = false;
        stopKeepAlive();
        updateBadge('DONE', '#10b981');
        broadcast({ type: 'BATCH_COMPLETE', completedQuizzes: batchCompletedQuizzes });
      },
    }).catch((err) => {
      console.error('Background batch error:', err);
      isBatchRunning = false;
      activeBatchRef.current = false;
      stopKeepAlive();
      clearBadge();
      lastStatusMessage = { type: 'error', text: `Batch failed: ${err.message}` };
      broadcast({ type: 'STATUS_UPDATE', status: lastStatusMessage });
    });

    return true;
  }

  if (type === 'STOP_BATCH_AUTO_SOLVE') {
    activeBatchRef.current = false;
    isBatchRunning = false;
    stopKeepAlive();
    clearBadge();
    lastStatusMessage = { type: 'info', text: 'Batch Auto-Solve paused.' };
    broadcast({ type: 'STATUS_UPDATE', status: lastStatusMessage });
    sendResponse({ stopped: true });
    return true;
  }

  if (type === 'START_SINGLE_AUTO_SOLVE') {
    if (isSingleRunning) {
      sendResponse({ started: false, reason: 'Single quiz solver is already running' });
      return true;
    }

    isSingleRunning = true;
    activeSingleRef.current = true;
    autoSolvedList = [];
    lastStatusMessage = {
      type: 'info',
      text: 'Starting Full Quiz Auto-Solve in background...',
    };

    startKeepAlive();
    updateBadge('Q...', '#3b82f6');
    sendResponse({ started: true });

    const {
      tabId,
      llmConfig,
      turboMode,
      maxTokens,
      autoSubmitAtEnd,
      stepDelayMs = 500,
    } = message;

    runFullQuizAutomation({
      tabId,
      llmConfig,
      turboMode,
      maxTokens,
      autoSubmitAtEnd,
      stepDelayMs,
      isRunningRef: activeSingleRef,
      onStatus: (st) => {
        lastStatusMessage = st;
        broadcast({ type: 'STATUS_UPDATE', status: st });
      },
      onProgress: (prog) => {
        singleProgress = prog;
        if (prog.current && prog.total) {
          updateBadge(`Q${prog.current}`, '#3b82f6');
        }
        broadcast({ type: 'SINGLE_PROGRESS_UPDATE', progress: prog });
      },
      onQuestionSolved: (rec) => {
        autoSolvedList.unshift(rec);
        broadcast({ type: 'QUESTION_SOLVED', record: rec });
      },
      onComplete: (res) => {
        isSingleRunning = false;
        activeSingleRef.current = false;
        stopKeepAlive();
        updateBadge('DONE', '#10b981');
        broadcast({ type: 'SINGLE_COMPLETE', result: res });
      },
    }).catch((err) => {
      console.error('Background single quiz error:', err);
      isSingleRunning = false;
      activeSingleRef.current = false;
      stopKeepAlive();
      clearBadge();
      lastStatusMessage = { type: 'error', text: `Auto-Solve failed: ${err.message}` };
      broadcast({ type: 'STATUS_UPDATE', status: lastStatusMessage });
    });

    return true;
  }

  if (type === 'STOP_SINGLE_AUTO_SOLVE') {
    activeSingleRef.current = false;
    isSingleRunning = false;
    stopKeepAlive();
    clearBadge();
    lastStatusMessage = { type: 'info', text: 'Quiz Auto-Solve paused.' };
    broadcast({ type: 'STATUS_UPDATE', status: lastStatusMessage });
    sendResponse({ stopped: true });
    return true;
  }
});
