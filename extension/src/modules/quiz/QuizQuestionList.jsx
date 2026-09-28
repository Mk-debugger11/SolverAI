import React, { useState, useEffect } from 'react';

function NumericAnswerField({ question, disabled, onFill }) {
  const [value, setValue] = useState(String(question.inputValue ?? ''));
  useEffect(() => setValue(String(question.inputValue ?? '')), [question.inputValue]);

  return (
    <form className="settings-field" style={{ padding: '12px' }} onSubmit={(event) => {
      event.preventDefault();
      if (!disabled) onFill(value);
    }}>
      <label htmlFor={`numeric-${question.questionId}`}>Numerical answer</label>
      <div className="action-row">
        <input
          id={`numeric-${question.questionId}`}
          className="input-text"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="e.g. 6, -0.25 or 1e-3"
          disabled={disabled}
          autoComplete="off"
          aria-label="Numerical answer"
        />
        <button className="btn btn-secondary" type="submit" disabled={disabled || !value.trim()}>Fill answer</button>
      </div>
      <span className="settings-hint">Fill writes your number to the quiz. Solve generates an answer using AI.</span>
    </form>
  );
}

/**
 * Displays MCQ and numerical questions with answer controls and DOM viewers.
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
  onFillNumericAnswer,
  getLlmPayload,
  getOptionB,
}) {
  const [expandedHtmlIndex, setExpandedHtmlIndex] = useState(null);
  const [expandedLlmIndex, setExpandedLlmIndex] = useState(null);

  if (!capturedDom) return null;

  return (
    <section className="card dom-card">
      {/* Sub-view toggle: Quiz Questions vs Full DOM */}
      <div className="subview-toggle">
        <button
          className={`subview-btn ${domSubView === 'questions' ? 'active' : ''}`}
          onClick={() => setDomSubView('questions')}
        >
          🎯 Quiz Questions ({capturedDom.questions?.length || 0})
        </button>
        <button
          className={`subview-btn ${domSubView === 'full_dom' ? 'active' : ''}`}
          onClick={() => setDomSubView('full_dom')}
        >
          📄 Full Page DOM
        </button>
      </div>

      {/* Sub-view: Quiz questions */}
      {domSubView === 'questions' && (
        <div className="questions-container">
          {capturedDom.questions?.length === 0 ? (
            <div className="empty-state">
              <p>No editable MCQ or numerical answer fields were found. Open a question or enter revision mode first.</p>
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
              {/* Global question actions */}
              <div className="action-row">
                <button
                  id="save-mongo-btn"
                  className="btn btn-success"
                  onClick={() => onSaveToMongo('radio_containers')}
                  disabled={saving}
                >
                  {saving ? 'Saving...' : '💾 Save to DB'}
                </button>
                {capturedDom.questions[0]?.answerType !== 'numeric' && <button
                  id="select-opt-b-global"
                  className="btn btn-warning"
                  onClick={() => onSelectOptionB(0)}
                  title="Select Option B on the live webpage"
                  disabled={solving}
                >
                  🎯 Select Option B
                </button>}
                <button
                  id="copy-llm-global-btn"
                  className="btn btn-llm"
                  onClick={() => {
                    const allPayloads = capturedDom.questions.map((q) => getLlmPayload(q));
                    const toCopy = allPayloads.length === 1 ? allPayloads[0] : allPayloads;
                    copyToClipboard(JSON.stringify(toCopy, null, 2), 'global_llm_payload');
                  }}
                  title="Copy the question's solver payload"
                >
                  {copiedType === 'global_llm_payload' ? '✓ Copied LLM!' : '🤖 LLM Payload'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    copyToClipboard(
                      capturedDom.onlyRadioContainersHtml,
                      'all_containers_html'
                    )
                  }
                >
                  {copiedType === 'all_containers_html' ? '✓ Copied!' : '📋 HTML'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    copyToClipboard(
                      JSON.stringify(capturedDom.questions, null, 2),
                      'questions_json'
                    )
                  }
                >
                  {copiedType === 'questions_json' ? '✓ Copied' : '{ } JSON'}
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
                          {q.answerType === 'numeric' && <span className="q-id-badge">Numerical</span>}
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
                              onClick={() => onSolveQuestion(q)}
                              disabled={solving}
                              title="Solve this question and fill or select its answer on the webpage"
                            >
                              {solving ? '⚡...' : (turboMode ? '⚡ Turbo' : '⚡ Solve')}
                            </button>
                            {optionB && (
                              <button
                                className={`btn-select-b-card ${
                                  optionB.checked ? 'is-selected' : ''
                                }`}
                                onClick={() => onSelectOptionB(qIndex)}
                                disabled={solving}
                                title={`Select Option B (${optionB.text}) on live webpage`}
                              >
                                {optionB.checked ? '✓ Option B' : '🎯 Select Option B'}
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
                              title="Copy the question's solver payload"
                            >
                              {copiedType === `llm_copy_${qIndex}`
                                ? '✓ Copied LLM!'
                                : '🤖 LLM Payload'}
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
                            >
                              {copiedType === `q_copy_${qIndex}`
                                ? '✓ Copied Question!'
                                : '📋 Copy Question'}
                            </button>
                          </div>
                        </div>
                        <div className="q-title">{q.questionText || q.question}</div>
                      </div>

                      {q.answerType === 'numeric' && <NumericAnswerField
                        key={`${q.questionId}:${q.questionText}`}
                        question={q}
                        disabled={solving}
                        onFill={(value) => onFillNumericAnswer(qIndex, value)}
                      />}

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
                              onClick={solving ? undefined : () => onSelectOption(qIndex, oIdx)}
                              aria-disabled={solving}
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
                                disabled={solving}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onSelectOption(qIndex, oIdx);
                                }}
                              >
                                {opt.checked ? '✓ Selected' : isOptionB ? '🎯 Select B' : 'Select'}
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
                              : '🤖 View LLM Payload ▼'}
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
                        >
                          {copiedType === `div_llm_${qIndex}`
                            ? '✓ Copied'
                            : 'Copy LLM'}
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
            >
              {saving ? 'Saving...' : '💾 Save Full Page to DB'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => copyToClipboard(capturedDom.fullHtml, 'full_html')}
            >
              {copiedType === 'full_html' ? '✓ Copied!' : '📋 Copy Full HTML'}
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
