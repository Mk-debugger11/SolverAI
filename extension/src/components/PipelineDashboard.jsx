import React from 'react';
import { IconZap, IconInfo } from './Icons';

/**
 * PipelineDashboard: Displays real-time T1-T6 latency flowchart
 * and solution breakdown for single question solves.
 */
export default function PipelineDashboard({ pipelineResult }) {
  if (!pipelineResult) return null;

  return (
    <div className={`pipeline-dashboard ${pipelineResult.status}`}>
      <div className="pipeline-header">
        <div className="pipeline-title">
          <span className="pipeline-pulse"></span>
          <strong style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            <IconZap size={13} />
            LLM Pipeline {pipelineResult.status === 'completed' ? 'Completed' : 'Failed'}
          </strong>
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
            <span className="pipeline-badge-ans">Chosen: Option {pipelineResult.answer}</span>
            {pipelineResult.turbo && (
              <span className="pipeline-badge-turbo" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <IconZap size={11} /> TURBO (~{pipelineResult.timings?.t4 || 20}ms)
              </span>
            )}
            <span className="pipeline-badge-conf">{pipelineResult.confidence}% confidence</span>
            <span className="pipeline-badge-model">{pipelineResult.modelUsed}</span>
          </div>

          {pipelineResult.reason && (
            <div className="pipeline-reason" style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
              <IconInfo size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>{pipelineResult.reason}</span>
            </div>
          )}

          {/* T1 to T6 Timing Grid */}
          <div className="timing-breakdown-grid">
            <div className="timing-step" title="T1: DOM Extraction from Active Webpage">
              <span className="step-name">T1: DOM Extract</span>
              <span className="step-val">{pipelineResult.timings?.t1 || 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step" title="T2: Extension to Backend Network Request">
              <span className="step-name">T2: Ext → Back</span>
              <span className="step-val">{pipelineResult.timings?.t2 || 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step" title="T3: Backend to Groq API Network Request">
              <span className="step-name">T3: Back → LLM</span>
              <span className="step-val">{pipelineResult.timings?.t3 || 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step highlight" title="T4: Groq LPU LLM Inference Execution">
              <span className="step-name">T4: LLM Infer</span>
              <span className="step-val">{pipelineResult.timings?.t4 || 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step" title="T5: Backend to Extension Response">
              <span className="step-name">T5: Back → Ext</span>
              <span className="step-val">{pipelineResult.timings?.t5 || 0}ms</span>
            </div>
            <div className="timing-arrow">→</div>
            <div className="timing-step" title="T6: Native DOM Click on Webpage Option">
              <span className="step-name">T6: DOM Click</span>
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
