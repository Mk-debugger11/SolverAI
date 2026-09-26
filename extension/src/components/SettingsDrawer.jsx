import React from 'react';

/**
 * SettingsDrawer: Drawer panel for configuring Groq API key, model,
 * max generation tokens, and turbo mode.
 */
export default function SettingsDrawer({
  isOpen,
  onClose,
  groqApiKey,
  setGroqApiKey,
  serverHasGroqKey,
  groqModel,
  setGroqModel,
  groqMaxTokens,
  setGroqMaxTokens,
  turboMode,
  toggleTurboMode,
}) {
  if (!isOpen) return null;

  return (
    <div className="settings-drawer">
      <div className="settings-header">
        <h3>⚡ LLM Pipeline Settings</h3>
        <button className="btn-close-sm" onClick={onClose} title="Close settings">
          ✕
        </button>
      </div>

      <div className="settings-body">
        {/* Groq API Key */}
        <div className="settings-field">
          <label>
            Groq API Key {serverHasGroqKey && <span className="badge-server-configured">✓ Configured in .env</span>}
          </label>
          <input
            type="password"
            className="input-text"
            placeholder={serverHasGroqKey ? 'Using backend/.env key (or enter custom key)' : 'gsk_...'}
            value={groqApiKey}
            onChange={(e) => {
              setGroqApiKey(e.target.value);
              localStorage.setItem('groq_api_key', e.target.value);
            }}
          />
          <span className="settings-hint">
            Free key at{' '}
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">
              console.groq.com/keys
            </a>
          </span>
        </div>

        {/* Groq Model */}
        <div className="settings-field">
          <label>Groq Model</label>
          <select
            className="input-select"
            value={groqModel}
            onChange={(e) => {
              setGroqModel(e.target.value);
              localStorage.setItem('groq_model', e.target.value);
            }}
          >
            <option value="qwen/qwen3.8-27b">qwen/qwen3.8-27b (Recommended, Ultra-Fast ~80ms)</option>
            <option value="openai/gpt-oss-120b">openai/gpt-oss-120b (High Reasoning)</option>
            <option value="openai/gpt-oss-20b">openai/gpt-oss-20b</option>
            <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
            <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
          </select>
        </div>

        {/* Max Generation Tokens */}
        <div className="settings-field">
          <label>Max Generation Tokens</label>
          <input
            type="number"
            min="64"
            max="8192"
            step="64"
            className="input-text"
            placeholder="2048"
            value={groqMaxTokens}
            onChange={(e) => {
              setGroqMaxTokens(e.target.value);
              localStorage.setItem('groq_max_tokens', e.target.value);
            }}
          />
          <span className="settings-hint">
            Higher token limits prevent JSON truncation errors (Default: 2048 for precision, 256 for turbo).
          </span>
        </div>

        {/* Turbo Mode Toggle */}
        <div className="settings-field">
          <label>
            <span>⚡ Turbo Mode (1-token output)</span>
            <button
              type="button"
              className={`toggle-switch-btn ${turboMode ? 'active' : ''}`}
              onClick={toggleTurboMode}
            >
              <span className="toggle-switch-thumb"></span>
            </button>
          </label>
          <span className="settings-hint">
            Outputs strictly 1 token for the option key instead of verbose explanations. Drops LLM latency from ~120ms to ~15ms.
          </span>
        </div>
      </div>
    </div>
  );
}
