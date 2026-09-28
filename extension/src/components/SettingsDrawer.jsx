import React from 'react';
import { IconZap, IconX, IconCheck } from './Icons';

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
        <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <IconZap size={14} />
          LLM Pipeline Settings
        </h3>
        <button className="btn-close-sm" onClick={onClose} title="Close settings">
          <IconX size={12} />
        </button>
      </div>

      <div className="settings-body">
        {/* Groq API Key */}
        <div className="settings-field">
          <label>
            Groq API Key{' '}
            {serverHasGroqKey && (
              <span className="badge-server-configured" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                <IconCheck size={10} /> Configured in .env
              </span>
            )}
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
            <option value="qwen/qwen3.8-27b">qwen/qwen3.8-27b</option>
            <option value="openai/gpt-oss-120b">openai/gpt-oss-120b (High Reasoning)</option>
            <option value="openai/gpt-oss-20b">openai/gpt-oss-20b</option>
            <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
            <option value="llama-3.1-8b-instant">llama-3.1-8b-instant</option>
            <option value="allam-2-7b">allam-2-7b</option>
          </select>
        </div>

        {/* Max Generation Tokens */}
        <div className="settings-field">
          <label>Max Generation Tokens</label>
          <input
            type="number"
            min="64"
            max="2048"
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
            Turbo caps output at 512 tokens; detailed mode caps it at 2048. Requests are paced to respect API limits, and repeated answers are cached.
          </span>
        </div>

        {/* Turbo Mode Toggle */}
        <div className="settings-field">
          <label>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <IconZap size={13} />
              Turbo Mode (compact answer)
            </span>
            <button
              type="button"
              className={`toggle-switch-btn ${turboMode ? 'active' : ''}`}
              onClick={toggleTurboMode}
            >
              <span className="toggle-switch-thumb"></span>
            </button>
          </label>
          <span className="settings-hint">
            Returns compact JSON and disables Qwen thinking to save tokens. Turn off for harder questions and a brief explanation. API limits may require a wait.
          </span>
        </div>
      </div>
    </div>
  );
}
