import { runBatchQuizAutomation } from './modules/quiz/batchQuizAutomation';
import { runFullQuizAutomation } from './modules/quiz/quizAutomation';
import { createAssignmentRunner } from './modules/assignments/assignmentRunner';
import { detectAssignment } from './modules/assignments/assignmentDetector';
import { codeAdapter } from './modules/assignments/codeAdapter';
import { notebookAdapter } from './modules/assignments/notebookAdapter';
import { assignmentApi } from './modules/assignments/assignmentApi';
import { portalSubmission } from './modules/assignments/portalSubmission';
import { createBatchAssignmentRunner } from './modules/assignments/batchAssignmentRunner';

console.log('DOM Fetcher Service Worker loaded and active.');

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
let popupQuizLease = null;

function popupQuizBusy() {
  if (popupQuizLease && popupQuizLease.expiresAt <= Date.now()) popupQuizLease = null;
  return Boolean(popupQuizLease);
}

let assignmentState = { job: null, busy: false };
let assignmentBatchState = { batch: null, busy: false };
const activeAssignmentOperations = new Set();
const ASSIGNMENT_PROTOCOL_VERSION = 2;
const assignmentActions = ['inspect', 'generate', 'apply', 'run', 'save', 'submit', 'restore', 'recover', 'automate', 'solve', 'stop'];
const assignmentBatchActions = ['start', 'stop', 'recover'];
const assignmentCapabilities = { assignmentActions, assignmentBatchActions };
function emitAssignmentState() {
  const state = { ...assignmentState, batch: assignmentBatchState.batch,
    busy: assignmentBusy() };
  broadcast({ type: 'ASSIGNMENT_STATE', protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, ...state });
  return state;
}
const assignments = createAssignmentRunner({
  storage: chrome.storage?.local,
  detect: detectAssignment,
  adapters: { code: codeAdapter, notebook: notebookAdapter },
  api: assignmentApi,
  submission: portalSubmission,
  isOtherBusy: () => isBatchRunning || isSingleRunning || popupQuizBusy(),
  notify: (state) => { assignmentState = state; emitAssignmentState(); },
});
const assignmentBatches = createBatchAssignmentRunner({
  storage: chrome.storage?.local, singleRunner: assignments,
  isOtherBusy: () => isBatchRunning || isSingleRunning || popupQuizBusy(),
  notify: (state) => { assignmentBatchState = state; emitAssignmentState(); },
});
const assignmentBusy = () => assignments.busy || assignmentBatches.busy || activeAssignmentOperations.size > 0;
async function readAssignmentState() {
  [assignmentState, assignmentBatchState] = await Promise.all([assignments.getState(), assignmentBatches.getState()]);
  return { ...assignmentState, batch: assignmentBatchState.batch, busy: assignmentBusy(),
    protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, capabilities: assignmentCapabilities };
}

// A runtime request acknowledges dispatch immediately. Progress and the terminal
// result use broadcasts, so a long solve does not depend on one popup response port.
function dispatchAssignmentOperation(scope, action, payload, invoke, sendResponse) {
  const operationId = crypto.randomUUID();
  activeAssignmentOperations.add(operationId);
  startKeepAlive();
  let operation;
  try { operation = invoke(payload); }
  catch (error) {
    activeAssignmentOperations.delete(operationId);
    sendResponse({ success: false, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, error: error.message });
    if (!assignmentBusy() && !isSingleRunning && !isBatchRunning) stopKeepAlive();
    return;
  }
  sendResponse({ success: true, accepted: true, operationId, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION });
  const finish = async (success, error) => {
    activeAssignmentOperations.delete(operationId);
    let state;
    try { state = await readAssignmentState(); }
    catch (stateError) {
      state = { ...assignmentState, batch: assignmentBatchState.batch, busy: assignmentBusy(), stateError: stateError.message };
    }
    broadcast({ type: 'ASSIGNMENT_ACTION_RESULT', ...state, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION,
      operationId, scope, action, success, ...(error ? { error: error.message || String(error) } : {}) });
  };
  Promise.resolve(operation).then(() => finish(true), (error) => finish(false, error))
    .finally(() => { if (!assignmentBusy() && !isSingleRunning && !isBatchRunning) stopKeepAlive(); });
}

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

  if (type === 'GET_ASSIGNMENT_STATE') {
    readAssignmentState().then(sendResponse).catch((error) => sendResponse({ success: false,
      protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, capabilities: assignmentCapabilities, error: error.message }));
    return true;
  }

  if (type === 'ASSIGNMENT_ACTION') {
    if (!assignmentActions.includes(message.action)) {
      sendResponse({ success: false, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, error: 'Unknown assignment action.' });
      return true;
    }
    if (message.action !== 'stop' && (assignmentBusy() || isBatchRunning || isSingleRunning || popupQuizBusy())) {
      sendResponse({ success: false, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, error: 'Another quiz or assignment action is still active.' });
      return true;
    }
    dispatchAssignmentOperation('action', message.action, message.payload,
      (payload) => assignmentBatches.busy && message.action === 'stop' ? assignmentBatches.stop() : assignments.action(message.action, payload), sendResponse);
    return true;
  }

  if (type === 'ASSIGNMENT_BATCH_ACTION') {
    const method = message.action;
    if (!assignmentBatchActions.includes(method)) { sendResponse({ success: false, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, error: 'Unknown assignment batch action.' }); return true; }
    if (method !== 'stop' && (assignmentBusy() || isBatchRunning || isSingleRunning || popupQuizBusy())) {
      sendResponse({ success: false, protocolVersion: ASSIGNMENT_PROTOCOL_VERSION, error: 'Another quiz or assignment action is still active.' });
      return true;
    }
    dispatchAssignmentOperation('batch', message.action, message.payload, (payload) => assignmentBatches[method](payload), sendResponse);
    return true;
  }

  if (type === 'ACQUIRE_POPUP_QUIZ_ACTION') {
    if (assignmentBusy() || isSingleRunning || isBatchRunning || popupQuizBusy()) {
      sendResponse({ success: false, error: 'Another quiz or assignment action is still active.' });
    } else {
      popupQuizLease = { token: crypto.randomUUID(), expiresAt: Date.now() + 180000 };
      sendResponse({ success: true, token: popupQuizLease.token });
    }
    return true;
  }

  if (type === 'CHECK_POPUP_QUIZ_ACTION' || type === 'RELEASE_POPUP_QUIZ_ACTION') {
    const valid = popupQuizBusy() && popupQuizLease.token === message.token;
    if (valid && type === 'RELEASE_POPUP_QUIZ_ACTION') popupQuizLease = null;
    else if (valid) popupQuizLease.expiresAt = Date.now() + 180000;
    sendResponse({ success: Boolean(valid) });
    return true;
  }

  if (type === 'GET_AUTOMATION_STATE') {
    sendResponse({
      isBatchRunning,
      isSingleRunning,
      batchProgress,
      singleProgress,
      batchCompletedQuizzes,
      autoSolvedList,
      lastStatusMessage,
      isAssignmentRunning: assignmentBusy(),
    });
    return true;
  }

  if (type === 'START_BATCH_AUTO_SOLVE') {
    if (isBatchRunning || isSingleRunning || assignmentBusy() || popupQuizBusy()) {
      sendResponse({ started: false, reason: 'A quiz or assignment action is still active or stopping. Wait for it to finish.' });
      return true;
    }

    isBatchRunning = true;
    activeBatchRef.current = true;
    batchCompletedQuizzes = [];
    autoSolvedList = [];
    lastStatusMessage = {
      type: 'info',
      text: '🚀 Background Batch Auto-Solve starting across assessments catalog...',
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
      onComplete: (result) => {
        isBatchRunning = false;
        activeBatchRef.current = false;
        stopKeepAlive();
        if (result?.success) updateBadge('✓', '#10b981');
        else clearBadge();
        broadcast({ type: 'BATCH_COMPLETE', completedQuizzes: batchCompletedQuizzes, result });
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
    // Keep the run locked until its pending request settles and onComplete runs.
    clearBadge();
    lastStatusMessage = { type: 'info', text: 'Stopping batch; waiting for any pending request to finish.' };
    broadcast({ type: 'STATUS_UPDATE', status: lastStatusMessage });
    sendResponse({ stopped: true });
    return true;
  }

  if (type === 'START_SINGLE_AUTO_SOLVE') {
    if (isSingleRunning || isBatchRunning || assignmentBusy() || popupQuizBusy()) {
      sendResponse({ started: false, reason: 'A quiz or assignment action is still active or stopping. Wait for it to finish.' });
      return true;
    }

    isSingleRunning = true;
    activeSingleRef.current = true;
    autoSolvedList = [];
    lastStatusMessage = {
      type: 'info',
      text: '🚀 Starting Full Quiz Auto-Solve in background...',
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
        if (res?.success) updateBadge('✓', '#10b981');
        else clearBadge();
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
    // Do not allow a new run to reactivate the same ref while this one is stopping.
    clearBadge();
    lastStatusMessage = { type: 'info', text: 'Stopping quiz; waiting for any pending request to finish.' };
    broadcast({ type: 'STATUS_UPDATE', status: lastStatusMessage });
    sendResponse({ stopped: true });
    return true;
  }
});
