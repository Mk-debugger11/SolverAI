import React, { useState, useEffect, useRef } from 'react';

// Shared Components
import Header from './components/Header';
import SettingsDrawer from './components/SettingsDrawer';
import StatusBanner from './components/StatusBanner';
import PipelineDashboard from './components/PipelineDashboard';
import HistoryView from './components/HistoryView';
import { IconCrosshair, IconHistory, IconZap, IconCpu } from './components/Icons';

// Quiz Module
import {
  extractQuizQuestionsFromPage,
  clickQuizOptionOnPage,
  fillQuizNumericAnswerOnPage,
  clickSubmitQuizOnPage,
  detectAssessmentsCatalog,
  handleStartOrInstructionsPage,
  detectQuizStartPage,
} from './modules/quiz/quizDom';
import QuizDashboard from './modules/quiz/QuizDashboard';
import QuizQuestionList from './modules/quiz/QuizQuestionList';
import AssignmentDashboard from './modules/assignments/AssignmentDashboard';
import { acquireQuizActionLease } from './modules/assignments/quizActionLease';
import { getAssignmentWorkerState, sendAssignmentCommand } from './modules/assignments/assignmentMessages';
import { assertAssignmentPageAction } from './modules/assignments/assignmentPageScope';

// LLM Module & Services
import { formatLlmPayload, solveMcq, fetchLlmConfig, normalizeNumericAnswer } from './modules/llm/llmService';
import {
  checkBackendHealth,
  saveDomCapture,
  fetchDomHistory,
  deleteDomRecord,
} from './services/domService';

export default function App() {
  // Tab and Connectivity State
  const [activeTab, setActiveTab] = useState(null);
  const [serverStatus, setServerStatus] = useState('checking'); // 'connected' | 'disconnected'
  const [statusMessage, setStatusMessage] = useState(null);
  const [view, setView] = useState('capture'); // 'capture' | 'history'
  const [domSubView, setDomSubView] = useState('questions'); // 'questions' | 'full_dom'
  const [assignmentJob, setAssignmentJob] = useState(null);
  const [assignmentBusy, setAssignmentBusy] = useState(false);
  const [assignmentBatch, setAssignmentBatch] = useState(null);
  const [assignmentSettings, setAssignmentSettings] = useState(() => ({
    model: localStorage.getItem('assignment_model') || 'qwen/qwen3.8-27b',
    maxTokens: localStorage.getItem('assignment_max_tokens') || '4096',
  }));

  // DOM Capture State
  const [capturedDom, setCapturedDom] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copiedType, setCopiedType] = useState(null);

  // History State
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // LLM Solver Settings & States
  const [groqApiKey, setGroqApiKey] = useState(() => localStorage.getItem('groq_api_key') || '');
  const [groqModel, setGroqModel] = useState(() => localStorage.getItem('groq_model') || 'qwen/qwen3.8-27b');
  const [groqMaxTokens, setGroqMaxTokens] = useState(() => localStorage.getItem('groq_max_tokens') || '2048');
  const [turboMode, setTurboMode] = useState(() => localStorage.getItem('turbo_mode') !== 'false');
  const [serverHasGroqKey, setServerHasGroqKey] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [solving, setSolving] = useState(false);
  const [pipelineResult, setPipelineResult] = useState(null);

  // Quiz Auto-Solve States (Single Quiz)
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoProgress, setAutoProgress] = useState({ current: 0, total: 0, percentage: 0 });
  const [autoSolvedList, setAutoSolvedList] = useState([]);
  const [autoSubmitAtEnd, setAutoSubmitAtEnd] = useState(() => localStorage.getItem('auto_submit_at_end') !== 'false');
  const [stepDelayMs] = useState(500);
  const autoRunningRef = useRef(false);

  // Batch Quiz Auto-Solve States (Assessments Catalog)
  const [catalogInfo, setCatalogInfo] = useState(null);
  const [quizStartInfo, setQuizStartInfo] = useState(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState({
    currentQuizIndex: 0,
    totalQuizzes: 0,
    currentQuizTitle: '',
    percentage: 0,
    questionProgress: null,
  });
  const [batchCompletedQuizzes, setBatchCompletedQuizzes] = useState([]);
  const batchRunningRef = useRef(false);

  function acceptAssignmentState(state) {
    if ('job' in state) setAssignmentJob(state.job || null);
    if ('busy' in state) setAssignmentBusy(Boolean(state.busy));
    if ('batch' in state) setAssignmentBatch(state.batch || null);
  }

  // Initialize: Check active tab, sync background automation state, and backend status
  useEffect(() => {
    initActiveTab();
    refreshBackendStatus();
    loadServerConfig();

    if (typeof chrome !== 'undefined' && chrome.tabs) {
      const handleActivated = async (activeInfo) => {
        try {
          const tab = await chrome.tabs.get(activeInfo.tabId);
          if (tab) {
            setActiveTab(tab);
            handleScanCatalog(tab.id);
          }
        } catch {}
      };

      const handleUpdated = (tabId, changeInfo, tab) => {
        if (tab && tab.active && changeInfo.status === 'complete') {
          setActiveTab(tab);
          handleScanCatalog(tab.id);
        }
      };

      chrome.tabs.onActivated?.addListener(handleActivated);
      chrome.tabs.onUpdated?.addListener(handleUpdated);

      // Sync state with background worker
      if (chrome.runtime?.sendMessage) {
        getAssignmentWorkerState().then(acceptAssignmentState)
          .catch((error) => setStatusMessage({ type: 'error', text: error.message }));
        chrome.runtime.sendMessage({ type: 'GET_AUTOMATION_STATE' }, (resp) => {
          if (resp) {
            if (resp.isBatchRunning) {
              setBatchRunning(true);
              batchRunningRef.current = true;
              if (resp.batchProgress) setBatchProgress(resp.batchProgress);
              if (resp.batchCompletedQuizzes) setBatchCompletedQuizzes(resp.batchCompletedQuizzes);
            }
            if (resp.isSingleRunning) {
              setAutoRunning(true);
              autoRunningRef.current = true;
              if (resp.singleProgress) setAutoProgress(resp.singleProgress);
            }
            if (resp.autoSolvedList?.length) {
              setAutoSolvedList(resp.autoSolvedList);
            }
            if (resp.lastStatusMessage) {
              setStatusMessage(resp.lastStatusMessage);
            }
          }
        });

        const handleRuntimeMessage = (msg) => {
          if (!msg) return;
          if (msg.type === 'ASSIGNMENT_STATE') {
            acceptAssignmentState(msg);
          } else if (msg.type === 'ASSIGNMENT_ACTION_RESULT') {
            acceptAssignmentState(msg);
            if (!msg.success) setStatusMessage({ type: 'error', text: msg.error || 'The assignment action failed. Check its recorded state.' });
          } else if (msg.type === 'STATUS_UPDATE') {
            setStatusMessage(msg.status);
          } else if (msg.type === 'BATCH_PROGRESS_UPDATE') {
            setBatchProgress(msg.progress);
            setBatchRunning(true);
            batchRunningRef.current = true;
          } else if (msg.type === 'SINGLE_PROGRESS_UPDATE') {
            setAutoProgress(msg.progress);
            setAutoRunning(true);
            autoRunningRef.current = true;
          } else if (msg.type === 'QUESTION_SOLVED') {
            setAutoSolvedList((prev) => [msg.record, ...prev]);
          } else if (msg.type === 'QUIZ_COMPLETED') {
            if (msg.data?.success && msg.data?.quiz) {
              setBatchCompletedQuizzes((prev) => [...prev, msg.data.quiz]);
            }
          } else if (msg.type === 'BATCH_COMPLETE') {
            setBatchRunning(false);
            batchRunningRef.current = false;
            setStatusMessage({
              type: msg.result?.success ? 'success' : msg.result?.cancelled ? 'info' : 'error',
              text: msg.result?.error || `${msg.result?.cancelled ? 'Batch stopped' : 'Batch finished'}: ${msg.completedQuizzes?.length || 0} quizzes solved${msg.result?.failedQuizzes?.length ? `, ${msg.result.failedQuizzes.length} failed` : ''}.`,
            });
            handleScanCatalog();
          } else if (msg.type === 'SINGLE_COMPLETE') {
            setAutoRunning(false);
            autoRunningRef.current = false;
          }
        };

        chrome.runtime.onMessage.addListener(handleRuntimeMessage);

        return () => {
          chrome.tabs.onActivated?.removeListener(handleActivated);
          chrome.tabs.onUpdated?.removeListener(handleUpdated);
          chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
        };
      }

      return () => {
        chrome.tabs.onActivated?.removeListener(handleActivated);
        chrome.tabs.onUpdated?.removeListener(handleUpdated);
      };
    }
  }, []);

  const getFreshActiveTabId = async () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          setActiveTab(tab);
          return tab.id;
        }
      } catch {}
    }
    return activeTab?.id || 1;
  };

  const initActiveTab = async () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          setActiveTab(tab);
          handleScanCatalog(tab.id);
        }
      } catch (err) {
        console.warn('Failed to query active Chrome tab:', err);
      }
    } else {
      setActiveTab({
        id: 1,
        url: window.location.href,
        title: document.title || 'Development Preview',
      });
    }
  };

  const handleScanCatalog = async (tabIdToUse) => {
    const tId = tabIdToUse || activeTab?.id;
    if (!tId || typeof chrome === 'undefined' || !chrome.scripting) return null;
    try {
      const info = await detectAssessmentsCatalog(tId);
      setCatalogInfo(info);
      if (info.isCatalog && info.unsolvedCount > 0) {
        setQuizStartInfo(null);
        setStatusMessage({
          type: 'info',
          text: `Assessments Catalog: ${info.unsolvedCount} unsolved quiz(zes) pending!`,
        });
      } else if (!info.isCatalog) {
        const startInfo = await detectQuizStartPage(tId);
        setQuizStartInfo(startInfo?.isStartPage ? startInfo : null);
        if (startInfo?.isStartPage) {
          setStatusMessage({
            type: 'info',
            text: `Quiz Overview: ${startInfo.questionCount ? `${startInfo.questionCount} Questions ready.` : 'Ready to start.'} Click "Start Test" or "Auto-Solve Opened Quiz & Submit" to launch and solve!`,
          });
        }
      } else {
        setQuizStartInfo(null);
      }
      return info;
    } catch (err) {
      console.warn('Catalog check failed:', err);
      return null;
    }
  };

  const refreshBackendStatus = async () => {
    const res = await checkBackendHealth();
    setServerStatus(res.connected ? 'connected' : 'disconnected');
  };

  const loadServerConfig = async () => {
    const config = await fetchLlmConfig();
    if (config) {
      setServerHasGroqKey(Boolean(config.hasGroqKey));
      if (config.model && !localStorage.getItem('groq_model')) {
        setGroqModel(config.model);
      }
      if (config.maxTokens && !localStorage.getItem('groq_max_tokens')) {
        setGroqMaxTokens(String(config.maxTokens));
      }
    }
  };

  const toggleAutoSubmitAtEnd = () => {
    setAutoSubmitAtEnd((prev) => {
      const next = !prev;
      localStorage.setItem('auto_submit_at_end', String(next));
      return next;
    });
  };

  const toggleTurboMode = () => {
    setTurboMode((prev) => {
      const next = !prev;
      localStorage.setItem('turbo_mode', String(next));
      return next;
    });
  };

  // Clipboard copy helper
  const copyToClipboard = (text, type) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedType(type);
      setTimeout(() => setCopiedType(null), 2000);
    });
  };

  // Inspect DOM questions on active webpage
  const handleFetchDom = async () => {
    setLoading(true);
    setStatusMessage({ type: 'info', text: 'Extracting quiz questions and answer fields from the active tab...' });

    try {
      const targetTabId = await getFreshActiveTabId();
      if (targetTabId) {
        const data = await extractQuizQuestionsFromPage(targetTabId, false);
        setCapturedDom(data);
        if (data.questions && data.questions.length > 0) {
          setQuizStartInfo(null);
          setDomSubView('questions');
          setStatusMessage({
            type: 'success',
            text: `Extracted ${data.questions.length} question(s), including ${data.questions.filter((q) => q.answerType === 'numeric').length} numerical.`,
          });
        } else {
          const startInfo = await detectQuizStartPage(targetTabId);
          setQuizStartInfo(startInfo?.isStartPage ? startInfo : null);
          if (startInfo?.isStartPage) {
            setStatusMessage({
              type: 'info',
              text: `Quiz Overview Detected (${startInfo.questionCount ? `${startInfo.questionCount} Questions` : 'Ready to start'}). Click "Start Test" or "Auto-Solve Opened Quiz & Submit" to begin!`,
            });
          } else {
            setStatusMessage({
              type: 'info',
              text: 'No questions currently rendered on this page. If this is a test overview, click "Auto-Solve" or "Start Test".',
            });
          }
        }
      }
    } catch (err) {
      console.error('DOM extraction error:', err);
      setStatusMessage({
        type: 'error',
        text: `DOM extraction failed: ${err.message}`,
      });
    } finally {
      setLoading(false);
    }
  };

  // Save current DOM capture to MongoDB
  const handleSaveToMongo = async (saveOption = 'radio_containers') => {
    if (!capturedDom) return;
    setSaving(true);
    setStatusMessage({ type: 'info', text: 'Saving capture to database...' });

    try {
      const htmlToSave =
        saveOption === 'radio_containers' && capturedDom.onlyRadioContainersHtml
          ? capturedDom.onlyRadioContainersHtml
          : capturedDom.fullHtml;

      await saveDomCapture({
        url: activeTab?.url || 'http://unknown-url.com',
        title: activeTab?.title || 'DOM Capture',
        html: htmlToSave,
        elementCount: capturedDom.elementCount || 0,
        sizeBytes: new Blob([htmlToSave]).size,
        questions: capturedDom.questions || [],
      });

      setStatusMessage({
        type: 'success',
        text: 'Capture saved to MongoDB successfully!',
      });
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: `Save failed: ${err.message}`,
      });
    } finally {
      setSaving(false);
    }
  };

  // Load history from MongoDB
  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const records = await fetchDomHistory();
      setHistory(records);
    } catch (err) {
      setStatusMessage({ type: 'error', text: `Failed to load history: ${err.message}` });
    } finally {
      setHistoryLoading(false);
    }
  };

  // Delete history record
  const handleDeleteRecord = async (id) => {
    try {
      await deleteDomRecord(id);
      setHistory((prev) => prev.filter((item) => item._id !== id));
      setStatusMessage({ type: 'success', text: 'Record deleted from MongoDB.' });
    } catch (err) {
      setStatusMessage({ type: 'error', text: `Delete failed: ${err.message}` });
    }
  };

  // Fast single question LLM pipeline (T1-T6)
  const handleRunLlmPipeline = async (inspectedQuestion = null) => {
    if (solving || autoRunning || batchRunning || assignmentBusy) return;
    setSolving(true);
    setPipelineResult(null);

    const timingTracker = { t1: 0, requestMs: 0, t6: 0, total: 0 };
    const pStart = performance.now();
    let lease;

    try {
      lease = await acquireQuizActionLease();
      const targetTabId = await getFreshActiveTabId();
      // T1: DOM Extraction
      const t1Start = performance.now();
      let domData = await extractQuizQuestionsFromPage(targetTabId, true);
      let questions = domData.questions || [];
      timingTracker.t1 = Math.round(performance.now() - t1Start);

      if (!questions.length) {
        const startRes = await handleStartOrInstructionsPage(targetTabId);
        if (startRes?.handled) {
          setStatusMessage({
            type: 'info',
            text: `Clicked "${startRes.buttonText}". Waiting for Question 1 to load...`,
          });
          // Poll up to 6 seconds for Question 1 to mount
          for (let wait = 0; wait < 15; wait++) {
            await new Promise((r) => setTimeout(r, 400));
            domData = await extractQuizQuestionsFromPage(targetTabId, true);
            questions = domData.questions || [];
            if (questions.length) break;
          }
        }
      }

      if (!questions.length) {
        throw new Error('No editable MCQ or numerical question found on the active page.');
      }

      const matchingQuestions = inspectedQuestion ? questions.filter((question) =>
        (question.answerType || 'mcq') === (inspectedQuestion.answerType || 'mcq') &&
        question.questionId === inspectedQuestion.questionId &&
        question.groupName === inspectedQuestion.groupName &&
        JSON.stringify(formatLlmPayload(question)) === JSON.stringify(formatLlmPayload(inspectedQuestion))
      ) : [questions[0]];
      if (matchingQuestions.length !== 1) {
        throw new Error('This question changed or is no longer editable. Inspect DOM again before solving it.');
      }
      const q = matchingQuestions[0];
      const payload = formatLlmPayload(q);
      setStatusMessage({ type: 'info', text: 'Checking cached answers or waiting for the API allowance...' });

      // T2-T5: LLM Solver
      const solution = await solveMcq(payload, {
        apiKey: groqApiKey,
        model: groqModel,
        turbo: turboMode,
        maxTokens: groqMaxTokens,
      });

      timingTracker.requestMs = solution.timings.roundtripMs;

      const answerType = q.answerType || 'mcq';
      const answer = answerType === 'numeric'
        ? normalizeNumericAnswer(solution.answer)
        : String(solution.answer ?? '').toUpperCase().trim();

      // Rate-limit waits can outlast a manual page change. Recheck before clicking.
      const latest = await extractQuizQuestionsFromPage(targetTabId, true);
      const freshQuestion = latest.questions?.find((question) =>
        (question.answerType || 'mcq') === answerType &&
        question.questionId === q.questionId &&
        question.groupName === q.groupName &&
        JSON.stringify(formatLlmPayload(question)) === JSON.stringify(payload)
      );
      if (!freshQuestion) throw new Error('The question changed while waiting. Run Solve Current again.');
      if (answerType === 'numeric' && freshQuestion.inputValue !== q.inputValue) {
        throw new Error('The numerical answer was edited while waiting. Your entry was left unchanged.');
      }

      // T6: Click on webpage
      await lease.check();
      const t6Start = performance.now();
      let clickRes;
      if (answerType === 'numeric') {
        clickRes = await fillQuizNumericAnswerOnPage(targetTabId, freshQuestion.targetDescriptor, answer);
      } else {
        const targetOptIndex = (freshQuestion.options || []).findIndex(
          (option) => (option.optionLetter || '').toUpperCase() === answer
        );
        if (targetOptIndex < 0) throw new Error('The returned answer does not match an available option.');
        const targetOpt = freshQuestion.options[targetOptIndex];
        clickRes = await clickQuizOptionOnPage(targetTabId, {
          ...targetOpt.targetDescriptor,
          optionLetter: answer,
          name: freshQuestion.groupName,
          index: targetOptIndex,
        }, targetOptIndex, freshQuestion.groupName);
      }
      timingTracker.t6 = Math.round(performance.now() - t6Start);
      timingTracker.total = Math.round(performance.now() - pStart);

      setPipelineResult({
        status: clickRes.success ? 'completed' : 'error',
        answer,
        answerType,
        confidence: solution.confidence,
        reason: solution.reason,
        modelUsed: solution.modelUsed,
        turbo: solution.turbo,
        cacheHit: solution.cacheHit,
        deduplicated: solution.deduplicated,
        usage: solution.usage,
        timings: timingTracker,
        error: clickRes.success ? null : clickRes.failureReason,
      });

      if (!clickRes.success) {
        setStatusMessage({
          type: 'error',
          text: `The solver returned ${answerType === 'numeric' ? answer : `Option ${answer}`}, but the answer could not be applied.`,
          details: clickRes.failureReason,
        });
      } else {
        setStatusMessage({
          type: 'success',
          text: `${answerType === 'numeric' ? `Filled numerical answer ${answer}` : `Selected Option ${answer}`}${solution.cacheHit ? ' using a cached answer (no API request)' : solution.deduplicated ? ' using a shared request' : ''}.`,
        });
        if (answerType === 'numeric') {
          setCapturedDom((previous) => previous ? {
            ...previous,
            questions: previous.questions.map((question) => question.questionId === q.questionId
              ? { ...question, inputValue: answer } : question),
          } : previous);
        }
      }
    } catch (err) {
      console.error('LLM Pipeline Error:', err);
      setStatusMessage({ type: 'error', text: `Pipeline failed: ${err.message}` });
      setPipelineResult({ status: 'error', error: err.message, timings: timingTracker });
    } finally {
      await lease?.release();
      setSolving(false);
    }
  };

  const handleFillNumericAnswer = async (questionIndex, value) => {
    if (solving || autoRunning || batchRunning || assignmentBusy) return;
    const question = capturedDom?.questions?.[questionIndex];
    if (question?.answerType !== 'numeric') return;
    setSolving(true);
    let lease;
    try {
      lease = await acquireQuizActionLease();
      const answer = normalizeNumericAnswer(value);
      const tabId = await getFreshActiveTabId();
      const latest = await extractQuizQuestionsFromPage(tabId, true);
      const current = latest.questions?.find((candidate) =>
        candidate.answerType === 'numeric' && candidate.questionId === question.questionId &&
        JSON.stringify(formatLlmPayload(candidate)) === JSON.stringify(formatLlmPayload(question))
      );
      if (!current) throw new Error('The question changed. Inspect DOM again before filling an answer.');
      await lease.check();
      const result = await fillQuizNumericAnswerOnPage(tabId, current.targetDescriptor, answer);
      if (!result.success) throw new Error(result.failureReason || 'The numerical field did not retain the answer.');
      setCapturedDom((previous) => previous ? {
        ...previous,
        questions: previous.questions.map((candidate) => candidate.questionId === question.questionId
          ? { ...candidate, inputValue: answer } : candidate),
      } : previous);
      setStatusMessage({ type: 'success', text: `Filled ${answer} on the page. No AI request was used.` });
    } catch (error) {
      setStatusMessage({ type: 'error', text: error.message });
    } finally {
      await lease?.release();
      setSolving(false);
    }
  };

  // Select an option manually by clicking on card
  const handleSelectOption = async (questionIndex, optionIndex) => {
    if (solving || autoRunning || batchRunning || assignmentBusy) return;
    if (!capturedDom?.questions?.[questionIndex]) return;
    const q = capturedDom.questions[questionIndex];
    const opt = q.options[optionIndex];
    if (!opt) return;

    const clickDescriptor = {
      ...(opt.targetDescriptor || {}),
      optionLetter: opt.optionLetter,
      name: q.groupName,
      index: optionIndex,
    };

    let lease;
    setSolving(true);
    try {
      lease = await acquireQuizActionLease();
      await lease.check();
      const res = await clickQuizOptionOnPage(
        activeTab?.id,
        clickDescriptor,
        optionIndex,
        q.groupName
      );

      if (res.success) {
        setStatusMessage({ type: 'success', text: `Selected Option ${opt.optionLetter} on live webpage.` });
      } else {
        setStatusMessage({ type: 'error', text: `Selection failed: ${res.failureReason}` });
      }
    } catch (error) {
      setStatusMessage({ type: 'error', text: error.message });
    } finally {
      await lease?.release();
      setSolving(false);
    }
  };

  // Helper to select Option B
  const handleSelectOptionB = async (questionIndex = 0) => {
    const q = capturedDom?.questions?.[questionIndex];
    if (!q) {
      await handleRunLlmPipeline();
      return;
    }
    const optB = (q.options || []).find((o) => (o.optionLetter || '').toUpperCase() === 'B') || q.options[1];
    if (optB) {
      const bIdx = (q.options || []).indexOf(optB);
      await handleSelectOption(questionIndex, bIdx !== -1 ? bIdx : 1);
    }
  };

  // Full Quiz Auto-Solve runner
  const handleStartAutoSolve = async () => {
    if (autoRunning || batchRunning || solving || assignmentBusy) return;
    const targetTabId = await getFreshActiveTabId();
    if (!targetTabId) {
      setStatusMessage({ type: 'error', text: 'No active Chrome tab found.' });
      return;
    }

    // Safeguard: If user is on assessments catalog page, advise them on which button to click
    const currentCatalog = await detectAssessmentsCatalog(targetTabId);
    if (currentCatalog?.isCatalog) {
      setStatusMessage({
        type: 'info',
        text: 'You are on the Assessments Catalog page! Use "Batch Auto-Solve All Unsolved Quizzes" below, or click an assessment card to open it first.',
      });
      return;
    }

    setAutoRunning(true);
    autoRunningRef.current = true;
    setAutoSolvedList([]);
    setStatusMessage({ type: 'info', text: 'Starting Full Quiz Auto-Solve in background...' });

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'START_SINGLE_AUTO_SOLVE',
        tabId: targetTabId,
        llmConfig: { apiKey: groqApiKey, model: groqModel },
        turboMode,
        maxTokens: groqMaxTokens,
        autoSubmitAtEnd,
        stepDelayMs,
      }, (response) => {
        if (!response?.started) {
          setAutoRunning(false);
          autoRunningRef.current = false;
          setStatusMessage({ type: 'info', text: chrome.runtime.lastError?.message || response?.reason || 'Could not start the quiz runner.' });
        }
      });
    }
  };

  // Direct Start Test handler: clicks "Start Test" on webpage and mounts Question 1
  const handleDirectStartTest = async () => {
    if (loading || autoRunning || batchRunning || solving || assignmentBusy) return;
    setLoading(true);
    setStatusMessage({ type: 'info', text: 'Clicking "Start Test" on webpage...' });

    try {
      const targetTabId = await getFreshActiveTabId();
      const res = await handleStartOrInstructionsPage(targetTabId);

      if (res?.handled) {
        setStatusMessage({
          type: 'success',
          text: `Clicked "${res.buttonText}"! Loading Question 1...`,
        });
        setQuizStartInfo(null);

        // Poll for Question 1 to mount on the webpage
        let found = false;
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise((r) => setTimeout(r, 400));
          const domData = await extractQuizQuestionsFromPage(targetTabId, false);
          if (domData?.questions?.length > 0) {
            setCapturedDom(domData);
            setDomSubView('questions');
            setStatusMessage({
              type: 'success',
              text: `Quiz started! Loaded Question 1 (${domData.questions.length} question(s) extracted).`,
            });
            found = true;
            break;
          }
        }

        if (!found) {
          await handleFetchDom();
        }
      } else {
        setStatusMessage({
          type: 'error',
          text: 'Could not find "Start Test" button on this tab. Ensure the test overview is visible.',
        });
      }
    } catch (err) {
      console.error('Direct Start Test Error:', err);
      setStatusMessage({ type: 'error', text: `Failed to start test: ${err.message}` });
    } finally {
      setLoading(false);
    }
  };

  const handleStopAutoSolve = () => {
    autoRunningRef.current = false;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'STOP_SINGLE_AUTO_SOLVE' });
    }
    setStatusMessage({ type: 'info', text: 'Stopping quiz; waiting for any pending request to finish.' });
  };

  // Batch Quiz Auto-Solve runner across assessments catalog
  const handleStartBatchAutoSolve = async () => {
    if (batchRunning || autoRunning || solving || assignmentBusy) return;
    const targetTabId = await getFreshActiveTabId();
    if (!targetTabId) {
      setStatusMessage({ type: 'error', text: 'No active Chrome tab found.' });
      return;
    }

    setBatchRunning(true);
    batchRunningRef.current = true;
    setBatchCompletedQuizzes([]);
    setAutoSolvedList([]);
    setStatusMessage({
      type: 'info',
      text: 'Starting Batch Auto-Solve in background (runs persistently across tabs)...',
    });

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'START_BATCH_AUTO_SOLVE',
        tabId: targetTabId,
        llmConfig: { apiKey: groqApiKey, model: groqModel },
        turboMode,
        maxTokens: groqMaxTokens,
        stepDelayMs,
        quizDelayMs: 2000,
      }, (response) => {
        if (!response?.started) {
          setBatchRunning(false);
          batchRunningRef.current = false;
          setStatusMessage({ type: 'info', text: chrome.runtime.lastError?.message || response?.reason || 'Could not start the batch runner.' });
        }
      });
    }
  };

  const handleStopBatchAutoSolve = () => {
    batchRunningRef.current = false;
    autoRunningRef.current = false;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'STOP_BATCH_AUTO_SOLVE' });
    }
    setStatusMessage({ type: 'info', text: 'Stopping batch; waiting for any pending request to finish.' });
  };

  // Manual trigger for Submit Quiz and modal confirmation
  const handleManualSubmitQuiz = async () => {
    if (solving || autoRunning || batchRunning || assignmentBusy) return;
    let lease;
    setSolving(true);
    try {
      lease = await acquireQuizActionLease();
      await lease.check();
      setStatusMessage({ type: 'info', text: 'Submitting quiz on webpage...' });
      const res = await clickSubmitQuizOnPage(activeTab?.id);
      if (res.success) {
        setStatusMessage({
          type: 'success',
          text: res.confirmed
            ? 'Quiz submitted successfully.'
            : 'Submit Quiz clicked on webpage.',
        });
      } else {
        setStatusMessage({
          type: 'error',
          text: `Submit failed: ${res.reason || res.error || 'Submit Quiz button not found'}`,
        });
      }
    } catch (error) {
      setStatusMessage({ type: 'error', text: error.message });
    } finally {
      await lease?.release();
      setSolving(false);
    }
  };

  const getAssignmentActionTabId = async (action) => {
    if (!globalThis.chrome?.tabs?.query) throw new Error('The active Chrome tab could not be identified.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!Number.isInteger(tab?.id)) throw new Error('Open a Newton assignment tab before continuing.');
    setActiveTab(tab);
    assertAssignmentPageAction(tab.url, action);
    return tab.id;
  };

  const handleAssignmentAction = async (action, payload = {}) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('Load the built extension in Chrome to use assignment actions.');
    }
    try {
      const tabId = ['inspect', 'solve'].includes(action) ? await getAssignmentActionTabId(action) : assignmentJob?.context?.tabId;
      setStatusMessage(null);
      const response = await sendAssignmentCommand({
        scope: 'action', action, onState: acceptAssignmentState,
        payload: { ...assignmentSettings, ...payload, tabId, apiKey: groqApiKey || undefined },
      });
      // An acknowledgement starts work; broadcasts own the changing state.
      // Applying an early acknowledgement here can overwrite a faster result.
      if (!response.accepted) acceptAssignmentState(response);
    } catch (error) {
      setStatusMessage({ type: 'error', text: error.message });
      throw error;
    }
  };

  const handleAssignmentBatchAction = async (action, payload = {}) => {
    if (!globalThis.chrome?.runtime?.sendMessage) {
      throw new Error('Load the built extension in Chrome to use assignment actions.');
    }
    try {
      const tabId = action === 'start' ? await getAssignmentActionTabId(action) : assignmentBatch?.catalogTabId;
      setStatusMessage(null);
      const response = await sendAssignmentCommand({
        scope: 'batch', action, onState: acceptAssignmentState,
        payload: { ...assignmentSettings, ...payload, tabId, apiKey: groqApiKey || undefined },
      });
      if (!response.accepted) acceptAssignmentState(response);
    } catch (error) {
      setStatusMessage({ type: 'error', text: error.message });
      throw error;
    }
  };

  const handleAssignmentSettings = (settings) => {
    setAssignmentSettings((previous) => {
      const next = { ...previous, ...settings };
      localStorage.setItem('assignment_model', next.model);
      localStorage.setItem('assignment_max_tokens', next.maxTokens);
      return next;
    });
  };

  const getOptionB = (q) =>
    (q.options || []).find((o) => o.optionLetter === 'B') || (q.options || [])[1];

  return (
    <div className="popup-container">
      {/* Header */}
      <Header
        serverStatus={serverStatus}
        activeTab={activeTab}
        showSettings={showSettings}
        onToggleSettings={() => setShowSettings(!showSettings)}
        turboMode={turboMode}
      />

      {/* Settings Drawer */}
      <SettingsDrawer
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        groqApiKey={groqApiKey}
        setGroqApiKey={setGroqApiKey}
        serverHasGroqKey={serverHasGroqKey}
        groqModel={groqModel}
        setGroqModel={setGroqModel}
        groqMaxTokens={groqMaxTokens}
        setGroqMaxTokens={setGroqMaxTokens}
        turboMode={turboMode}
        toggleTurboMode={toggleTurboMode}
      />

      {/* Navigation Tabs */}
      <nav className="nav-tabs">
        <button
          className={`tab-btn ${view === 'capture' ? 'active' : ''}`}
          onClick={() => setView('capture')}
        >
          <IconCrosshair size={13} style={{ marginRight: '6px' }} />Quizzes
        </button>
        <button className={`tab-btn ${view === 'assignments' ? 'active' : ''}`} onClick={() => setView('assignments')}>
          Assignments
        </button>
        <button
          className={`tab-btn ${view === 'history' ? 'active' : ''}`}
          onClick={() => {
            setView('history');
            loadHistory();
          }}
        >
          <IconHistory size={13} style={{ marginRight: '6px' }} />History ({history.length})
        </button>
      </nav>

      {/* Status Notifications */}
      <StatusBanner statusMessage={statusMessage} onClose={() => setStatusMessage(null)} />

      {view === 'assignments' && (
        <AssignmentDashboard job={assignmentJob} batch={assignmentBatch} activeTabUrl={activeTab?.url} operationBusy={assignmentBusy} busy={assignmentBusy || solving || autoRunning || batchRunning}
          settings={assignmentSettings} onSettingsChange={handleAssignmentSettings} onAction={handleAssignmentAction}
          onBatchAction={handleAssignmentBatchAction} onSwitchTab={setView} />
      )}

      {/* Quiz & DOM Solver View */}
      {view === 'capture' && (
        <main className="content capture-view">
          {/* Active Webpage Card with Turbo Mode vs Detailed Mode Toggle */}
          <section className="card active-tab-card">
            <div className="card-label">Active Webpage</div>
            <div className="tab-title" title={activeTab?.title || ''}>
              {activeTab?.title || 'Detecting active tab...'}
            </div>
            <div className="tab-url" title={activeTab?.url || ''}>
              {activeTab?.url || 'No active URL'}
            </div>

            <div className="turbo-toggle-bar">
              <div className="turbo-info">
                <span className="turbo-flame">{turboMode ? <IconZap size={14} /> : <IconCpu size={14} />}</span>
                <span className="turbo-title">{turboMode ? 'Turbo Mode' : 'Detailed Mode'}</span>
                <span className={`turbo-badge ${turboMode ? 'active' : 'detailed'}`}>
                  {turboMode ? 'Compact answer' : 'Brief explanation'}
                </span>
              </div>
              <button
                type="button"
                className={`toggle-switch-btn ${turboMode ? 'active' : ''}`}
                onClick={toggleTurboMode}
                title="Toggle between compact answers and answers with a brief explanation"
              >
                <span className="toggle-switch-thumb"></span>
              </button>
            </div>
          </section>

          {/* Quiz Dashboard Module */}
          <QuizDashboard
            autoRunning={autoRunning}
            autoProgress={autoProgress}
            autoSolvedList={autoSolvedList}
            autoSubmitAtEnd={autoSubmitAtEnd}
            turboMode={turboMode}
            solving={solving || assignmentBusy}
            loading={loading}
            onStartAutoSolve={handleStartAutoSolve}
            onStopAutoSolve={handleStopAutoSolve}
            onSolveCurrent={() => handleRunLlmPipeline()}
            onInspectDom={handleFetchDom}
            onToggleAutoSubmit={toggleAutoSubmitAtEnd}
            onManualSubmitQuiz={handleManualSubmitQuiz}
            catalogInfo={catalogInfo}
            batchRunning={batchRunning}
            batchProgress={batchProgress}
            batchCompletedQuizzes={batchCompletedQuizzes}
            onStartBatchAutoSolve={handleStartBatchAutoSolve}
            onStopBatchAutoSolve={handleStopBatchAutoSolve}
            onScanCatalog={() => handleScanCatalog()}
            startInfo={quizStartInfo}
            onDirectStartTest={handleDirectStartTest}
          />

          {/* Pipeline Timing Dashboard */}
          <PipelineDashboard pipelineResult={pipelineResult} />

          {/* Captured Quiz Questions List */}
          <QuizQuestionList
            capturedDom={capturedDom}
            domSubView={domSubView}
            setDomSubView={setDomSubView}
            turboMode={turboMode}
            solving={solving || autoRunning || batchRunning || assignmentBusy}
            saving={saving}
            copiedType={copiedType}
            copyToClipboard={copyToClipboard}
            onSaveToMongo={handleSaveToMongo}
            onSelectOptionB={handleSelectOptionB}
            onSelectOption={handleSelectOption}
            onSolveQuestion={handleRunLlmPipeline}
            onFillNumericAnswer={handleFillNumericAnswer}
            getLlmPayload={formatLlmPayload}
            getOptionB={getOptionB}
          />
        </main>
      )}

      {/* History View */}
      {view === 'history' && (
        <HistoryView
          history={history}
          historyLoading={historyLoading}
          onRefreshHistory={loadHistory}
          onDeleteRecord={handleDeleteRecord}
        />
      )}
    </div>
  );
}
