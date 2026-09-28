import React from 'react';

/**
 * Displays measured request timing and whether the answer used an API call.
 */
export default function PipelineDashboard({ pipelineResult }) {
  if (!pipelineResult) return null;

  return (
    <div className={`pipeline-dashboard ${pipelineResult.status}`}>
      <div className="pipeline-header">
        <div className="pipeline-title">
          <span className="pipeline-pulse"></span>
          <strong>⚡ LLM Pipeline {pipelineResult.status === 'completed' ? 'Completed' : 'Failed'}</strong>
        </div>
        {pipelineResult.timings?.total > 0 && (
          <div className="pipeline-total-time">
            Total: {pipelineResult.timings.total} ms
          </div>
        )}
      </div>

      {pipelineResult.status === 'completed' && (
        <>
          <div className="pipeline-answer-banner">
            <span className="pipeline-badge-ans">{pipelineResult.answerType === 'numeric' ? 'Filled:' : 'Chosen: Option'} {pipelineResult.answer}</span>
            {pipelineResult.turbo && (
              <span className="pipeline-badge-turbo">Compact answer</span>
            )}
            {pipelineResult.cacheHit && <span className="pipeline-badge-conf">Cached · no API request</span>}
            {pipelineResult.deduplicated && <span className="pipeline-badge-conf">Shared request</span>}
            <span className="pipeline-badge-model">{pipelineResult.modelUsed}</span>
          </div>

          {pipelineResult.reason && (
            <div className="pipeline-reason">
              💡 {pipelineResult.reason}
            </div>
          )}

          {!pipelineResult.cacheHit && !pipelineResult.deduplicated && Number.isFinite(pipelineResult.usage?.total_tokens) && (
            <div className="pipeline-reason">Tokens used: {pipelineResult.usage.total_tokens}</div>
          )}

          {/* Request time includes server queueing, rate-limit waits and inference. */}
          <div className="timing-breakdown-grid">
            <div className="timing-step" title="T1: DOM Extraction from Active Webpage">
              <span className="step-name">DOM extraction</span>
              <span className="step-val">{pipelineResult.timings?.t1 || 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step highlight" title="Total backend request time, including pacing and retries">
              <span className="step-name">Backend request</span>
              <span className="step-val">{pipelineResult.timings?.requestMs ?? 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step" title="Time to fill or select the answer on the webpage">
              <span className="step-name">Apply answer</span>
              <span className="step-val">{pipelineResult.timings?.t6 || 0}ms</span>
            </div>
          </div>
        </>
      )}

      {pipelineResult.status === 'error' && (
        <div className="pipeline-error-text">
          {pipelineResult.error}
        </div>
      )}
    </div>
  );
}
