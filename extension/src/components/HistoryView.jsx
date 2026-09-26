import React from 'react';

/**
 * Formats bytes to human-readable string.
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * HistoryView component renders saved MongoDB captures.
 */
export default function HistoryView({
  history,
  historyLoading,
  onRefreshHistory,
  onDeleteRecord,
}) {
  return (
    <main className="content history-view">
      <div className="history-header">
        <span className="card-label">MongoDB Saved Records</span>
        <button className="btn-refresh" onClick={onRefreshHistory} title="Refresh">
          🔄 Refresh
        </button>
      </div>

      {historyLoading ? (
        <div className="empty-state">Loading records from MongoDB...</div>
      ) : history.length === 0 ? (
        <div className="empty-state">
          <p>No saved captures found in database.</p>
          <small>Click "Inspect DOM" and "Save to DB" to capture pages.</small>
        </div>
      ) : (
        <div className="history-list">
          {history.map((item) => (
            <div key={item._id} className="history-item">
              <div className="history-info">
                <div className="history-title" title={item.title}>
                  {item.title || 'Untitled'}
                </div>
                <div className="history-url" title={item.url}>
                  {item.url}
                </div>
                <div className="history-meta">
                  <span>{formatBytes(item.sizeBytes)}</span>
                  <span>•</span>
                  {item.questions && item.questions.length > 0 ? (
                    <span className="tag-questions">{item.questions.length} questions</span>
                  ) : (
                    <span>{item.elementCount || 0} elements</span>
                  )}
                  <span>•</span>
                  <span>{new Date(item.createdAt).toLocaleTimeString()}</span>
                </div>
              </div>
              <button
                className="btn-delete"
                onClick={() => onDeleteRecord(item._id)}
                title="Delete from MongoDB"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
