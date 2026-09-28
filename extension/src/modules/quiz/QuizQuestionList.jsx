import React, { useState } from 'react';
import {
  IconCrosshair,
  IconFileText,
  IconDatabase,
  IconCpu,
  IconCode,
  IconZap,
  IconCheck,
  IconCopy,
} from '../../components/Icons';

/**
 * QuizQuestionList displays extracted radio questions, option lists,
 * manual option selection buttons, and raw HTML/JSON viewers.
 */
export default function QuizQuestionList({
  capturedDom,
  domSubView,
  setDomSubView,
  turboMode,
  solving,
  saving,
  copiedType,
  copyToClipboard,
  onSaveToMongo,
  onSelectOptionB,
  onSelectOption,
  onSolveQuestion,
  getLlmPayload,
  getOptionB,
}) {
  const [expandedHtmlIndex, setExpandedHtmlIndex] = useState(null);
  const [expandedLlmIndex, setExpandedLlmIndex] = useState(null);

  if (!capturedDom) return null;

  return (
    <section className="card dom-card">
      {/* Sub-view toggle: Radio Questions vs Full DOM */}
      <div className="subview-toggle">
        <button
          className={`subview-btn ${domSubView === 'questions' ? 'active' : ''}`}
          onClick={() => setDomSubView('questions')}
        >
          <IconCrosshair size={12} style={{ marginRight: '5px' }} />
          Radio Containers ({capturedDom.questions?.length || 0})
        </button>
        <button
          className={`subview-btn ${domSubView === 'full_dom' ? 'active' : ''}`}
          onClick={() => setDomSubView('full_dom')}
        >
          <IconFileText size={12} style={{ marginRight: '5px' }} />
          Full Page DOM
        </button>
      </div>

      {/* Sub-view: RADIO QUESTIONS ONLY */}
      {domSubView === 'questions' && (
        <div className="questions-container">
          {capturedDom.questions?.length === 0 ? (
            <div className="empty-state">
              <p>No radio inputs (<code>&lt;input type="radio"&gt;</code>) detected on this webpage.</p>
              <button
                className="btn btn-secondary"
                style={{ marginTop: '8px' }}
                onClick={() => setDomSubView('full_dom')}
              >
                View Full Page DOM
              </button>
            </div>
          ) : (
            <>
              {/* Global action buttons for Radio Questions */}
              <div className="action-row">
                <button
                  id="save-mongo-btn"
                  className="btn btn-success"
                  onClick={() => onSaveToMongo('radio_containers')}
                  disabled={saving}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <IconDatabase size={12} style={{ marginRight: '4px' }} />
                  {saving ? 'Saving...' : 'Save to DB'}
                </button>
                <button
                  id="select-opt-b-global"
                  className="btn btn-warning"
                  onClick={() => onSelectOptionB(0)}
                  title="Select Option B on the live webpage"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <IconCrosshair size={12} style={{ marginRight: '4px' }} />
                  Select Option B
                </button>
                <button
                  id="copy-llm-global-btn"
                  className="btn btn-llm"
                  onClick={() => {
                    const allPayloads = capturedDom.questions.map((q) => getLlmPayload(q));
                    const toCopy = allPayloads.length === 1 ? allPayloads[0] : allPayloads;
                    copyToClipboard(JSON.stringify(toCopy, null, 2), 'global_llm_payload');
                  }}
                  title="Copy LLM Payload JSON: { q: '...', o: { A: '...', B: '...' } }"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {copiedType === 'global_llm_payload' ? (
                    <>
                      <IconCheck size={12} style={{ marginRight: '4px' }} /> Copied LLM!
                    </>
                  ) : (
                    <>
                      <IconCpu size={12} style={{ marginRight: '4px' }} /> LLM Payload
                    </>
                  )}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    copyToClipboard(
                      capturedDom.onlyRadioContainersHtml,
                      'all_containers_html'
                    )
                  }
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {copiedType === 'all_containers_html' ? (
                    <>
                      <IconCheck size={12} style={{ marginRight: '4px' }} /> Copied!
                    </>
                  ) : (
                    <>
                      <IconFileText size={12} style={{ marginRight: '4px' }} /> HTML
                    </>
                  )}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    copyToClipboard(
                      JSON.stringify(capturedDom.questions, null, 2),
                      'questions_json'
                    )
                  }
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {copiedType === 'questions_json' ? (
                    <>
                      <IconCheck size={12} style={{ marginRight: '4px' }} /> Copied
                    </>
                  ) : (
                    <>
                      <IconCode size={12} style={{ marginRight: '4px' }} /> JSON
                    </>
                  )}
                </button>
              </div>

              {/* List of Extracted Question Containers */}
              <div className="question-cards-list">
                {capturedDom.questions.map((q, qIndex) => {
                  const optionB = getOptionB(q);
                  return (
                    <div key={qIndex} className="question-card">
                      <div className="question-card-header">
                        <div className="q-badge-row">
                          <span className="q-badge">Q{qIndex + 1}</span>
                          {q.questionId && (
                            <span
                              className="q-id-badge"
                              title={`Question ID: ${q.questionId}`}
                            >
                              ID: {q.questionId}
                            </span>
                          )}
                          <div className="q-badge-actions">
                            <button
                              className={`btn-solve-card ${turboMode ? 'turbo' : ''}`}
                              onClick={() => onSolveQuestion(qIndex)}
                              disabled={solving}
                              title={turboMode ? "Solve with Turbo Mode (~15ms) and click on webpage" : "Solve with LLM and click on webpage"}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                            >
                              <IconZap size={11} />
                              {solving ? '...' : (turboMode ? 'Turbo' : 'Solve')}
                            </button>
                            {optionB && (
                              <button
                                className={`btn-select-b-card ${
                                  optionB.checked ? 'is-selected' : ''
                                }`}
                                onClick={() => onSelectOptionB(qIndex)}
                                title={`Select Option B (${optionB.text}) on live webpage`}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                              >
                                {optionB.checked ? (
                                  <>
                                    <IconCheck size={11} /> Option B
                                  </>
                                ) : (
                                  <>
                                    <IconCrosshair size={11} /> Select Option B
                                  </>
                                )}
                              </button>
                            )}
                            <button
                              className="btn-copy-llm"
                              onClick={() =>
                                copyToClipboard(
                                  JSON.stringify(getLlmPayload(q), null, 2),
                                  `llm_copy_${qIndex}`
                                )
                              }
                              title="Copy LLM Payload: { q: '...', o: { A: '...', B: '...' } }"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                            >
                              {copiedType === `llm_copy_${qIndex}` ? (
                                <>
                                  <IconCheck size={11} /> Copied LLM!
                                </>
                              ) : (
                                <>
                                  <IconCpu size={11} /> LLM Payload
                                </>
                              )}
                            </button>
                            <button
                              className="btn-copy-question"
                              onClick={() =>
                                copyToClipboard(
                                  JSON.stringify(q, null, 2),
                                  `q_copy_${qIndex}`
                                )
                              }
                              title="Copy complete JSON object of this question with all DOM attributes and options"
                              style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                            >
                              {copiedType === `q_copy_${qIndex}` ? (
                                <>
                                  <IconCheck size={11} /> Copied Question!
                                </>
                              ) : (
                                <>
                                  <IconCopy size={11} /> Copy Question
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                        <div className="q-title">{q.questionText || q.question}</div>
                      </div>

                      {/* Options List */}
                      <div className="options-list">
                        {(q.options || []).map((opt, oIdx) => {
                          const isOptionB = optionB && (optionB === opt || (optionB.index !== undefined && optionB.index === oIdx));
                          const letter = opt.optionLetter || String.fromCharCode(65 + oIdx);
                          return (
                            <div
                              key={oIdx}
                              className={`option-item ${opt.checked ? 'checked' : ''} ${
                                isOptionB ? 'is-opt-b' : ''
                              }`}
                              onClick={() => onSelectOption(qIndex, oIdx)}
                              title={`Click to select Option ${letter} on live webpage`}
                            >
                              <span className="radio-circle">
                                {opt.checked && <span className="radio-dot" />}
                              </span>
                              <span
                                className={`option-letter-badge ${
                                  isOptionB ? 'badge-opt-b' : ''
                                }`}
                                title={`Option ${letter}`}
                              >
                                {letter}
                              </span>
                              <span className="option-text">{opt.text}</span>
                              {opt.value &&
                                opt.value !== opt.text &&
                                opt.value !== opt.id && (
                                  <span className="option-value">val: {opt.value}</span>
                                )}
                              <button
                                className={`btn-click-opt ${opt.checked ? 'is-selected' : ''} ${
                                  isOptionB ? 'btn-click-b' : ''
                                }`}
                                title={`Select Option ${letter} on live webpage`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectOption(qIndex, oIdx);
                                }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                              >
                                {opt.checked ? (
                                  <>
                                    <IconCheck size={10} /> Selected
                                  </>
                                ) : isOptionB ? (
                                  <>
                                    <IconCrosshair size={10} /> Select B
                                  </>
                                ) : (
                                  'Select'
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>

                      {/* Container Footer: LLM Payload & HTML Toggles */}
                      <div className="card-footer-actions">
                        <div className="footer-links-row">
                          <button
                            className="btn-link"
                            onClick={() =>
                              setExpandedLlmIndex(
                                expandedLlmIndex === qIndex ? null : qIndex
                              )
                            }
                          >
                            {expandedLlmIndex === qIndex
                              ? 'Hide LLM Payload ▲'
                              : 'View LLM Payload ▼'}
                          </button>
                          <button
                            className="btn-link"
                            onClick={() =>
                              setExpandedHtmlIndex(
                                expandedHtmlIndex === qIndex ? null : qIndex
                              )
                            }
                          >
                            {expandedHtmlIndex === qIndex
                              ? 'Hide Parent Div HTML ▲'
                              : 'Inspect HTML ▼'}
                          </button>
                        </div>
                        <button
                          className="btn-copy-small"
                          onClick={() =>
                            copyToClipboard(
                              JSON.stringify(getLlmPayload(q), null, 2),
                              `div_llm_${qIndex}`
                            )
                          }
                          title="Copy LLM Payload JSON"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}
                        >
                          {copiedType === `div_llm_${qIndex}` ? (
                            <>
                              <IconCheck size={10} /> Copied
                            </>
                          ) : (
                            'Copy LLM'
                          )}
                        </button>
                      </div>

                      {expandedLlmIndex === qIndex && (
                        <pre className="code-preview" style={{ marginTop: '8px' }}>
                          <code>{JSON.stringify(getLlmPayload(q), null, 2)}</code>
                        </pre>
                      )}

                      {expandedHtmlIndex === qIndex && (
                        <pre className="code-preview" style={{ marginTop: '8px' }}>
                          <code>{capturedDom.onlyRadioContainersHtml || ''}</code>
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Sub-view: FULL PAGE DOM */}
      {domSubView === 'full_dom' && (
        <div className="full-dom-container">
          <div className="action-row">
            <button
              className="btn btn-success"
              onClick={() => onSaveToMongo('full_dom')}
              disabled={saving}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              <IconDatabase size={12} />
              {saving ? 'Saving...' : 'Save Full Page to DB'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => copyToClipboard(capturedDom.fullHtml, 'full_html')}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
            >
              {copiedType === 'full_html' ? (
                <>
                  <IconCheck size={12} /> Copied!
                </>
              ) : (
                <>
                  <IconFileText size={12} /> Copy Full HTML
                </>
              )}
            </button>
          </div>
          <pre className="code-preview full-dom-preview">
            <code>{capturedDom.fullHtml ? capturedDom.fullHtml.slice(0, 5000) + '...\n\n[Truncated for performance]' : 'No full HTML captured.'}</code>
          </pre>
        </div>
      )}
    </section>
  );
}
