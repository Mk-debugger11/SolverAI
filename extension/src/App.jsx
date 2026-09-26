import React, { useState, useEffect, useRef } from 'react';

// Shared Components
import Header from './components/Header';
import SettingsDrawer from './components/SettingsDrawer';
import StatusBanner from './components/StatusBanner';
import PipelineDashboard from './components/PipelineDashboard';
import HistoryView from './components/HistoryView';

// Quiz Module
import {
  extractQuizQuestionsFromPage,
  clickQuizOptionOnPage,
  clickSubmitQuizOnPage,
  detectAssessmentsCatalog,
} from './modules/quiz/quizDom';
import { runFullQuizAutomation } from './modules/quiz/quizAutomation';
import { runBatchQuizAutomation } from './modules/quiz/batchQuizAutomation';
import QuizDashboard from './modules/quiz/QuizDashboard';
import QuizQuestionList from './modules/quiz/QuizQuestionList';

// LLM Module & Services
import { formatLlmPayload, solveMcq, fetchLlmConfig } from './modules/llm/llmService';
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
          if (msg.type === 'STATUS_UPDATE') {
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
              type: 'success',
              text: `🎉 Batch Completed! ${msg.completedQuizzes?.length || 0} quizzes solved.`,
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
        setStatusMessage({
          type: 'info',
          text: `📋 Assessments Catalog: ${info.unsolvedCount} unsolved quiz(zes) pending!`,
        });
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
    setStatusMessage({ type: 'info', text: 'Extracting radio questions and DOM from active tab...' });

    try {
      const targetTabId = await getFreshActiveTabId();
      if (targetTabId) {
        const data = await extractQuizQuestionsFromPage(targetTabId, false);
        setCapturedDom(data);
        if (data.questions && data.questions.length > 0) {
          setDomSubView('questions');
        }
        setStatusMessage({
          type: 'success',
          text: `Extracted ${data.questions.length} radio question(s) successfully!`,
        });
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
  const handleRunLlmPipeline = async (questionIndex = 0) => {
    if (solving) return;
    setSolving(true);
    setPipelineResult(null);

    const timingTracker = { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0, t6: 0, total: 0 };
    const pStart = performance.now();

    try {
      const targetTabId = await getFreshActiveTabId();
      // T1: DOM Extraction
      const t1Start = performance.now();
      const domData = await extractQuizQuestionsFromPage(targetTabId, true);
      const questions = domData.questions || [];
      timingTracker.t1 = Math.round(performance.now() - t1Start);

      if (!questions.length) {
        throw new Error('No radio question found on the active page.');
      }

      const q = questions[questionIndex] || questions[0];
      const payload = formatLlmPayload(q);

      // T2-T5: LLM Solver
      const solution = await solveMcq(payload, {
        apiKey: groqApiKey,
        model: groqModel,
        turbo: turboMode,
        maxTokens: groqMaxTokens,
      });

      timingTracker.t2 = solution.timings.t2_t5_network_ms;
      timingTracker.t3 = solution.timings.t3_backend_to_llm_ms;
      timingTracker.t4 = solution.timings.t4_llm_inference_ms;
      timingTracker.t5 = Math.max(1, Math.round(solution.timings.t2_t5_network_ms * 0.4));

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

      // T6: Click on webpage
      const t6Start = performance.now();
      const clickRes = await clickQuizOptionOnPage(
        activeTab?.id,
        clickDescriptor,
        targetOptIndex,
        q.groupName
      );
      timingTracker.t6 = Math.round(performance.now() - t6Start);
      timingTracker.total = Math.round(performance.now() - pStart);

      setPipelineResult({
        status: clickRes.success ? 'completed' : 'error',
        answer: answerLetter,
        confidence: solution.confidence,
        reason: solution.reason,
        modelUsed: solution.modelUsed,
        turbo: solution.turbo,
        timings: timingTracker,
        error: clickRes.success ? null : clickRes.failureReason,
      });

      if (!clickRes.success) {
        setStatusMessage({
          type: 'error',
          text: `⚠️ Solved: Option ${answerLetter}, but could NOT select it on webpage!`,
          details: clickRes.failureReason,
        });
      } else {
        setStatusMessage({
          type: 'success',
          text: solution.turbo
            ? `⚡ Turbo Solved & Clicked Option ${answerLetter} in ${timingTracker.total}ms! (LLM: ${timingTracker.t4}ms)`
            : `⚡ Solved & Clicked Option ${answerLetter} in ${timingTracker.total}ms!`,
        });
      }
    } catch (err) {
      console.error('LLM Pipeline Error:', err);
      setStatusMessage({ type: 'error', text: `Pipeline failed: ${err.message}` });
      setPipelineResult({ status: 'error', error: err.message, timings: timingTracker });
    } finally {
      setSolving(false);
    }
  };

  // Select an option manually by clicking on card
  const handleSelectOption = async (questionIndex, optionIndex) => {
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
  };

  // Helper to select Option B
  const handleSelectOptionB = async (questionIndex = 0) => {
    const q = capturedDom?.questions?.[questionIndex];
    if (!q) {
      await handleRunLlmPipeline(0);
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
    if (autoRunning) return;
    const targetTabId = await getFreshActiveTabId();
    if (!targetTabId) {
      setStatusMessage({ type: 'error', text: 'No active Chrome tab found.' });
      return;
    }

    // Safeguard: If user is on assessments catalog page, advise them on which button to click
    if (catalogInfo?.isCatalog) {
      setStatusMessage({
        type: 'info',
        text: '📋 You are on the Assessments Catalog page! Use "Batch Auto-Solve All Unsolved Quizzes" below, or click an assessment card to open it first.',
      });
    }

    setAutoRunning(true);
    autoRunningRef.current = true;
    setAutoSolvedList([]);
    setStatusMessage({ type: 'info', text: '🚀 Starting Full Quiz Auto-Solve in background...' });

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'START_SINGLE_AUTO_SOLVE',
        tabId: targetTabId,
        llmConfig: { apiKey: groqApiKey, model: groqModel },
        turboMode,
        maxTokens: groqMaxTokens,
        autoSubmitAtEnd,
        stepDelayMs,
      });
    }
  };

  const handleStopAutoSolve = () => {
    autoRunningRef.current = false;
    setAutoRunning(false);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'STOP_SINGLE_AUTO_SOLVE' });
    }
    setStatusMessage({ type: 'info', text: '⏹️ Full Quiz Auto-Solve paused.' });
  };

  // Batch Quiz Auto-Solve runner across assessments catalog
  const handleStartBatchAutoSolve = async () => {
    if (batchRunning) return;
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
      text: '🚀 Starting Batch Auto-Solve in background (runs persistently across tabs)...',
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
      });
    }
  };

  const handleStopBatchAutoSolve = () => {
    batchRunningRef.current = false;
    autoRunningRef.current = false;
    setBatchRunning(false);
    setAutoRunning(false);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'STOP_BATCH_AUTO_SOLVE' });
    }
    setStatusMessage({ type: 'info', text: '⏹️ Batch Auto-Solve stopped.' });
  };

  // Manual trigger for Submit Quiz and modal confirmation
  const handleManualSubmitQuiz = async () => {
    setStatusMessage({ type: 'info', text: '⚡ Submitting quiz on webpage...' });
    const res = await clickSubmitQuizOnPage(activeTab?.id);
    if (res.success) {
      setStatusMessage({
        type: 'success',
        text: res.confirmed
          ? '🎉 Quiz Submitted & Confirmed Successfully!'
          : '✓ Submit Quiz clicked on webpage!',
      });
    } else {
      setStatusMessage({
        type: 'error',
        text: `Submit failed: ${res.reason || res.error || 'Submit Quiz button not found'}`,
      });
    }
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
          🎯 Quiz & DOM Solver
        </button>
        <button
          className={`tab-btn ${view === 'history' ? 'active' : ''}`}
          onClick={() => {
            setView('history');
            loadHistory();
          }}
        >
          🗂️ History ({history.length})
        </button>
      </nav>

      {/* Status Notifications */}
      <StatusBanner statusMessage={statusMessage} onClose={() => setStatusMessage(null)} />

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
                <span className="turbo-flame">{turboMode ? '⚡' : '🧠'}</span>
                <span className="turbo-title">{turboMode ? 'Turbo Mode' : 'Detailed Mode'}</span>
                <span className={`turbo-badge ${turboMode ? 'active' : 'detailed'}`}>
                  {turboMode ? '⚡ Ultra-Fast (~25ms)' : '🧠 Step-by-Step (~150ms)'}
                </span>
              </div>
              <button
                type="button"
                className={`toggle-switch-btn ${turboMode ? 'active' : ''}`}
                onClick={toggleTurboMode}
                title="Toggle between Ultra-Fast Turbo (1-token) and Detailed Reasoning"
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
            solving={solving}
            loading={loading}
            onStartAutoSolve={handleStartAutoSolve}
            onStopAutoSolve={handleStopAutoSolve}
            onSolveCurrent={() => handleRunLlmPipeline(0)}
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
          />

          {/* Pipeline Timing Dashboard */}
          <PipelineDashboard pipelineResult={pipelineResult} />

          {/* Captured Quiz Questions List */}
          <QuizQuestionList
            capturedDom={capturedDom}
            domSubView={domSubView}
            setDomSubView={setDomSubView}
            turboMode={turboMode}
            solving={solving}
            saving={saving}
            copiedType={copiedType}
            copyToClipboard={copyToClipboard}
            onSaveToMongo={handleSaveToMongo}
            onSelectOptionB={handleSelectOptionB}
            onSelectOption={handleSelectOption}
            onSolveQuestion={handleRunLlmPipeline}
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
