import React from 'react';
import {
  IconCheckCircle,
  IconAlertTriangle,
  IconInfo,
  IconFileText,
  IconX,
} from './Icons';

/**
 * StatusBanner: Displays notification messages (info, success, error) with optional details.
 */
export default function StatusBanner({ statusMessage, onClose }) {
  if (!statusMessage) return null;

  return (
    <div className={`status-banner ${statusMessage.type}`}>
      <span className="status-icon">
        {statusMessage.type === 'success' ? (
          <IconCheckCircle size={15} />
        ) : statusMessage.type === 'error' ? (
          <IconAlertTriangle size={15} />
        ) : (
          <IconInfo size={15} />
        )}
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
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <IconFileText size={12} style={{ flexShrink: 0 }} />
            <span>{statusMessage.details}</span>
          </div>
        )}
      </div>
      <button className="status-close" onClick={onClose} title="Dismiss">
        <IconX size={12} />
      </button>
    </div>
  );
}
