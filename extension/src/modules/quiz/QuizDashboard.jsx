import React from 'react';
import {
  IconBookOpen,
  IconRefresh,
  IconPlay,
  IconSquare,
  IconLayers,
  IconZap,
  IconSearch,
  IconCheck,
  IconCheckCircle,
  IconUpload,
  IconAlertTriangle,
} from '../../components/Icons';

/**
 * QuizDashboard component renders automation controls, live progress,
 * and the stream of solved questions.
 * 
 * Provides:
 * 1. Single-Quiz Auto-Solve: Solves all questions (Q1..QN) on the currently open quiz & submits.
 * 2. Batch Auto-Solve: Iterates through all unsolved quizzes from the catalog, opens, solves & submits each.
 * 3. Fast Single Question LLM Solver & DOM Inspector.
 */
export default function QuizDashboard({
  // Single Quiz States
  autoRunning,
  autoProgress,
  autoSolvedList,
  autoSubmitAtEnd,
  turboMode,
  solving,
  loading,
  onStartAutoSolve,
  onStopAutoSolve,
  onSolveCurrent,
  onInspectDom,
  onToggleAutoSubmit,
  onManualSubmitQuiz,

  // Batch Automation States & Handlers
  catalogInfo,
  batchRunning,
  batchProgress,
  batchCompletedQuizzes = [],
  onStartBatchAutoSolve,
  onStopBatchAutoSolve,
  onScanCatalog,
}) {
  const isCatalog = Boolean(catalogInfo?.isCatalog);
  const unsolvedCount = catalogInfo?.unsolvedCount ?? 0;

  return (
    <>
      {/* Assessments Catalog Mode Information Banner (if on catalog page) */}
      {isCatalog && (
        <div className="catalog-info-card">
          <div className="catalog-info-title">
            <IconBookOpen size={14} />
            <span>Assessments Catalog</span>
            <span className="catalog-info-badge">{catalogInfo?.total || 0} Total</span>
            <span className="catalog-info-badge unsolved">{unsolvedCount} Unsolved</span>
          </div>
          {onScanCatalog && (
            <button
              className="btn-link"
              onClick={onScanCatalog}
              disabled={batchRunning || autoRunning || solving}
              title="Refresh catalog scan"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <IconRefresh size={11} />
              Refresh
            </button>
          )}
        </div>
      )}

      <section className="dashboard-section quiz-actions-section">
        <div className="btn-group-column">
          {/* FEATURE 1: Auto-Solve Opened Quiz & Submit (Full Single-Quiz Solver) */}
          <button
            id="auto-solve-full-quiz-btn"
            className={`btn btn-full-quiz ${autoRunning ? 'is-running' : ''}`}
            onClick={autoRunning ? onStopAutoSolve : onStartAutoSolve}
            disabled={batchRunning || (solving && !autoRunning)}
            title="Automatically solves Question 1 through N on the currently opened quiz, clicks answers, and submits"
          >
            <div className="btn-full-quiz-content">
              <span className="btn-quiz-icon">{autoRunning ? <IconSquare size={16} /> : <IconPlay size={16} />}</span>
              <div className="btn-quiz-texts">
                <span className="btn-quiz-title">
                  {autoRunning ? 'Stop Quiz Auto-Solve' : 'Auto-Solve Opened Quiz & Submit'}
                </span>
                <span className="btn-quiz-subtitle">
                  {autoRunning
                    ? `Solving Question ${autoProgress.current} of ${autoProgress.total || '?'}...`
                    : 'Answers each question using paced requests and cached answers'}
                </span>
              </div>
            </div>
          </button>

          {/* FEATURE 2: Batch Auto-Solve All Unsolved Quizzes */}
          <button
            id="batch-auto-solve-btn"
            className={`btn btn-batch-quiz ${batchRunning ? 'is-running' : ''}`}
            onClick={batchRunning ? onStopBatchAutoSolve : onStartBatchAutoSolve}
            disabled={autoRunning || (solving && !batchRunning)}
            title="Automatically loops through each unsolved quiz on the catalog, opens it, solves Q1..QN, submits and repeats"
          >
            <div className="btn-batch-quiz-content">
              <span className="btn-batch-icon">{batchRunning ? <IconSquare size={16} /> : <IconLayers size={16} />}</span>
              <div className="btn-batch-texts">
                <span className="btn-batch-title">
                  {batchRunning
                    ? 'Stop Batch Auto-Solve'
                    : `Batch Auto-Solve All Unsolved Quizzes ${isCatalog ? `(${unsolvedCount})` : ''}`}
                </span>
                <span className="btn-batch-subtitle">
                  {batchRunning
                    ? `Solving Quiz ${batchProgress.currentQuizIndex} of ${batchProgress.totalQuizzes}: ${batchProgress.currentQuizTitle}`
                    : isCatalog
                    ? `Loops ${unsolvedCount} unsolved quizzes → opens quiz → solves → submits → repeats`
                    : 'Loops all unsolved quizzes from assessments catalog → solves & submits each'}
                </span>
              </div>
            </div>
          </button>

          {/* Fast Single Question & Inspect DOM Actions Row */}
          <div className="action-row-split">
            <button
              id="auto-solve-top-btn"
              className={`btn btn-solve-pipeline ${turboMode ? 'turbo-glow' : ''}`}
              onClick={onSolveCurrent}
              disabled={solving || loading || autoRunning || batchRunning}
              title={turboMode ? 'Solve with a compact answer; API limits may require a wait' : 'Solve with a brief explanation'}
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}
            >
              <IconZap size={12} />
              {solving
                ? (turboMode ? 'Turbo Solving...' : 'Running Pipeline...')
                : 'Solve Current'}
            </button>
            <button
              id="fetch-dom-btn"
              className="btn btn-secondary"
              onClick={onInspectDom}
              disabled={loading || solving || autoRunning || batchRunning}
              title="Inspect MCQ and numerical questions in the active tab"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}
            >
              <IconSearch size={12} />
              {loading ? 'Inspecting...' : 'Inspect DOM'}
            </button>
          </div>
        </div>
      </section>

      {/* Live Batch Automation Dashboard */}
      {batchRunning && (
        <div className="batch-auto-panel running">
          <div className="quiz-auto-header">
            <div className="quiz-auto-title">
              <span className="batch-pulse-dot"></span>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <IconZap size={13} />
                Batch Auto-Solving Quizzes...
              </strong>
            </div>
            <div className="quiz-auto-count">
              Quiz {batchProgress.currentQuizIndex} of {batchProgress.totalQuizzes || 1}
            </div>
          </div>

          {/* Active Quiz Title Badge */}
          {batchProgress.currentQuizTitle && (
            <div className="batch-active-quiz-badge" title={batchProgress.currentQuizTitle}>
              <IconBookOpen size={12} />
              <span>{batchProgress.currentQuizTitle}</span>
            </div>
          )}

          {/* Dual Progress: Overall Batch & Active Quiz Question */}
          <div className="batch-dual-progress">
            <div className="batch-progress-label">
              <span>Overall Batch Progress</span>
              <span>{batchProgress.percentage || 0}%</span>
            </div>
            <div className="quiz-progress-track" style={{ marginBottom: 0 }}>
              <div
                className="batch-progress-bar-overall"
                style={{ width: `${batchProgress.percentage || 0}%` }}
              ></div>
            </div>

            {batchProgress.questionProgress && (
              <>
                <div className="batch-progress-label" style={{ marginTop: '4px' }}>
                  <span>Current Quiz: Question {batchProgress.questionProgress.current} of {batchProgress.questionProgress.total}</span>
                  <span>{batchProgress.questionProgress.percentage || 0}%</span>
                </div>
                <div className="quiz-progress-track" style={{ marginBottom: 0 }}>
                  <div
                    className="quiz-progress-bar"
                    style={{ width: `${batchProgress.questionProgress.percentage || 0}%` }}
                  ></div>
                </div>
              </>
            )}
          </div>

          {/* Batch Controls */}
          <div className="quiz-auto-controls">
            <span style={{ fontSize: '10px', color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              <IconCheck size={11} /> Solved {batchCompletedQuizzes.length} quiz(zes) so far
            </span>
            <button
              className="btn-pause-sm"
              onClick={onStopBatchAutoSolve}
              title="Stop Batch Automation"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <IconSquare size={10} />
              Stop Batch
            </button>
          </div>
        </div>
      )}

      {/* Live Single Quiz Automation Dashboard (shown when solving opened quiz) */}
      {(autoRunning || (!batchRunning && autoSolvedList.length > 0)) && (
        <div className={`quiz-auto-panel ${autoRunning ? 'running' : 'completed'}`}>
          <div className="quiz-auto-header">
            <div className="quiz-auto-title">
              <span className={`quiz-pulse-dot ${autoRunning ? 'active' : 'done'}`}></span>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                {autoRunning ? <IconZap size={13} /> : <IconCheckCircle size={13} />}
                {autoRunning ? 'Auto-Solving Opened Quiz...' : 'Quiz run results'}
              </strong>
            </div>
            <div className="quiz-auto-count">
              {autoProgress.current > 0 ? `Q ${autoProgress.current}/${autoProgress.total || '?'}` : ''}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="quiz-progress-track">
            <div
              className="quiz-progress-bar"
              style={{ width: `${autoProgress.percentage || 0}%` }}
            ></div>
          </div>

          {/* Controls bar: Auto-submit toggle & Submit button */}
          <div className="quiz-auto-controls">
            <label className="checkbox-label" title="Automatically click Submit Quiz upon answering last question">
              <input
                type="checkbox"
                checked={autoSubmitAtEnd}
                onChange={onToggleAutoSubmit}
                disabled={autoRunning || batchRunning || solving}
              />
              <span>Auto-Submit Quiz at end</span>
            </label>
            {autoRunning ? (
              <button
                className="btn-pause-sm"
                onClick={onStopAutoSolve}
                title="Pause automation"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <IconSquare size={10} />
                Pause
              </button>
            ) : (
              <button
                className="btn-submit-sm"
                onClick={onManualSubmitQuiz}
                disabled={solving || batchRunning}
                title="Click Submit Quiz on webpage and confirm modal"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
              >
                <IconUpload size={12} />
                Submit Quiz
              </button>
            )}
          </div>

          {/* Solved Questions Stream */}
          <div className="quiz-solved-stream">
            {autoSolvedList.map((item, idx) => (
              <div
                key={item.qNum !== undefined ? `q-${item.qNum}-${idx}` : idx}
                className="quiz-stream-item"
                title={item.selectionError ? `Selection Failed: ${item.selectionError}` : (item.reason ? `Reason: ${item.reason}` : item.question)}
              >
                {item.quizSubject && (
                  <span className="stream-quiz-badge">{item.quizSubject}</span>
                )}
                <span className="stream-q-badge">Q{item.qNum}</span>
                <span
                  className="stream-ans-badge"
                  style={item.selected === false ? { background: '#ef4444', color: '#fff' } : undefined}
                >
                  {item.answerType === 'numeric' ? 'Answer' : 'Option'} {item.answer} {item.selected === false ? (
                    <><IconAlertTriangle size={10} style={{ marginLeft: '3px', verticalAlign: 'middle' }} /> Failed</>
                  ) : (
                    <IconCheck size={10} style={{ marginLeft: '3px', verticalAlign: 'middle' }} />
                  )}
                </span>
                <span className="stream-timing-badge">{item.totalTime}ms</span>
                {item.cacheHit && <span className="stream-timing-badge">Cached</span>}
                <span className="stream-text-snippet">
                  {item.reason
                    ? item.reason.length > 35
                    ? item.reason.slice(0, 35) + '...'
                    : item.reason
                    : item.question.length > 32
                    ? item.question.slice(0, 32) + '...'
                    : item.question}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* When batch running, also show stream of solved questions */}
      {batchRunning && autoSolvedList.length > 0 && (
        <div className="quiz-auto-panel completed" style={{ marginTop: '8px' }}>
          <div className="quiz-auto-header">
            <span style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>
              Live Solved Questions Stream ({autoSolvedList.length})
            </span>
          </div>
          <div className="quiz-solved-stream">
            {autoSolvedList.map((item, idx) => (
              <div
                key={`batch-q-${idx}`}
                className="quiz-stream-item"
                title={item.selectionError ? `Selection Failed: ${item.selectionError}` : (item.reason ? `Reason: ${item.reason}` : item.question)}
              >
                {item.quizSubject && (
                  <span className="stream-quiz-badge">{item.quizSubject}</span>
                )}
                <span className="stream-q-badge">Q{item.qNum}</span>
                <span
                  className="stream-ans-badge"
                  style={item.selected === false ? { background: '#ef4444', color: '#fff' } : undefined}
                >
                  {item.answerType === 'numeric' ? 'Answer' : 'Option'} {item.answer} {item.selected === false ? (
                    <><IconAlertTriangle size={10} style={{ marginLeft: '3px', verticalAlign: 'middle' }} /> Failed</>
                  ) : (
                    <IconCheck size={10} style={{ marginLeft: '3px', verticalAlign: 'middle' }} />
                  )}
                </span>
                <span className="stream-timing-badge">{item.totalTime}ms</span>
                {item.cacheHit && <span className="stream-timing-badge">Cached</span>}
                <span className="stream-text-snippet">
                  {item.reason
                    ? item.reason.length > 35
                    ? item.reason.slice(0, 35) + '...'
                    : item.reason
                    : item.question}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
