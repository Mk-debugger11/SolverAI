import React from 'react';
import { IconZap, IconGlobe, IconExternalLink, IconSettings } from './Icons';

/**
 * Header component: Displays application title, backend connectivity status,
 * active tab domain, and the settings drawer toggle button.
 */
export default function Header({
  serverStatus,
  activeTab,
  showSettings,
  onToggleSettings,
  turboMode,
}) {
  return (
    <header className="header">
      <div className="header-left">
        <div className="logo-row">
          <span className="logo-icon">
            <IconZap size={15} />
          </span>
          <h1>Solver.Ai</h1>
          {turboMode && <span className="turbo-badge">TURBO</span>}
        </div>
        <p className="subtitle">Fast LLM MCQ Solver & Automation</p>
      </div>

      <div className="header-right">
        {/* Server Connection Status Pill */}
        <div
          className={`server-status-pill ${serverStatus}`}
          title={`Backend server at http://localhost:5001 is ${serverStatus}`}
        >
          <span className="status-dot"></span>
          <span className="status-label">
            {serverStatus === 'connected'
              ? 'Server Online'
              : serverStatus === 'checking'
              ? 'Checking...'
              : 'Server Offline'}
          </span>
        </div>

        {/* Active Tab Domain Chip */}
        {activeTab && (
          <div
            className="tab-domain-chip"
            title={`${activeTab.title}\n${activeTab.url}`}
          >
            <span className="domain-icon">
              <IconGlobe size={11} />
            </span>
            <span className="domain-text">
              {(() => {
                try {
                  return new URL(activeTab.url).hostname;
                } catch {
                  return 'Active Tab';
                }
              })()}
            </span>
          </div>
        )}

        {/* Pop-out to Dedicated Window */}
        <button
          type="button"
          className="btn-settings-toggle"
          onClick={() => {
            if (typeof chrome !== 'undefined' && chrome.windows) {
              chrome.windows.create({
                url: chrome.runtime.getURL('index.html'),
                type: 'popup',
                width: 450,
                height: 720,
              });
            } else if (typeof chrome !== 'undefined' && chrome.tabs) {
              chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
            }
          }}
          title="Open Dashboard in a persistent floating window (never auto-closes on tab switch)"
        >
          <IconExternalLink size={13} />
        </button>

        {/* Settings Toggle */}
        <button
          className={`btn-settings-toggle ${showSettings ? 'active' : ''}`}
          onClick={onToggleSettings}
          title="Open LLM & Solver Settings"
        >
          <IconSettings size={13} />
        </button>
      </div>
    </header>
  );
}
