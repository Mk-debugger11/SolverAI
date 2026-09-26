import React from 'react';

/**
 * StatusBanner: Displays notification messages (info, success, error) with optional details.
 */
export default function StatusBanner({ statusMessage, onClose }) {
  if (!statusMessage) return null;

  return (
    <div className={`status-banner ${statusMessage.type}`}>
      <span className="status-icon">
        {statusMessage.type === 'success'
          ? '✓'
          : statusMessage.type === 'error'
          ? '⚠️'
          : 'ℹ️'}
      </span>
      <div className="status-content">
        <span className="status-text">{statusMessage.text}</span>
        {statusMessage.details && (
          <div
            className="status-details"
            style={{
              fontSize: '11px',
              marginTop: '4px',
              opacity: 0.85,
              wordBreak: 'break-word',
            }}
          >
            📋 {statusMessage.details}
          </div>
        )}
      </div>
      <button className="status-close" onClick={onClose} title="Dismiss">
        ✕
      </button>
    </div>
  );
}
