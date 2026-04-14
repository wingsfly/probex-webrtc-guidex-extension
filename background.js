// ProbeX WebRTC Monitor - Background Service Worker
// Lightweight: only handles popup status queries and re-injection on update.
// All data collection and pushing is done by content-script (which lives as long as the page).
'use strict';

const DEFAULT_CONFIG = {
  hubUrl: 'http://localhost:8080',
  probeName: 'webrtc-browser',
  agentId: '',
  collectInterval: 2000,
  pushInterval: 5000,
  enabled: true,
};

// Stats aggregated from content-script push reports (for popup display)
let stats = { pushSuccess: 0, pushFail: 0, lastPushAt: null, activeConnections: 0, latestMetrics: null };

// --- Message handling (popup + content-script stats reports) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Fetch proxy: content-script asks us to make HTTP requests
  // (bypasses mixed content since SW is not bound by page protocol)
  if (msg.type === 'proxy-fetch') {
    fetch(msg.url, {
      method: msg.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: msg.body || null,
    })
      .then(async (resp) => {
        sendResponse({ ok: resp.ok, status: resp.status });
      })
      .catch((e) => {
        sendResponse({ ok: false, status: 0, error: e.message });
      });
    return true; // async sendResponse
  }

  // Popup queries
  if (msg.type === 'get-status') {
    chrome.storage.local.get('probexConfig', (stored) => {
      sendResponse({
        config: { ...DEFAULT_CONFIG, ...stored.probexConfig },
        registered: true,
        stats,
      });
    });
    return true;
  }

  if (msg.type === 'get-latest-metrics') {
    sendResponse({ metrics: stats.latestMetrics });
    return true;
  }

  if (msg.type === 'update-config') {
    chrome.storage.local.get('probexConfig', (stored) => {
      const config = { ...DEFAULT_CONFIG, ...stored.probexConfig, ...msg.config };
      // Generate agentId if not set
      if (!config.agentId) {
        config.agentId = `browser-${Math.random().toString(36).substring(2, 8)}`;
      }
      // Save — content-scripts pick up changes via chrome.storage.onChanged
      chrome.storage.local.set({ probexConfig: config });
      sendResponse({ ok: true });
    });
    return true;
  }
});

// --- Re-inject into existing tabs on install/update ---

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        // Inject into MAIN world (bypasses page CSP)
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['injected.js'],
          world: 'MAIN',
        }).catch(() => {});
        // Inject config bridge into ISOLATED world
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-script.js'],
        }).catch(() => {});
      }
    });
  }

  // Ensure agentId is set on first install
  if (details.reason === 'install') {
    chrome.storage.local.get('probexConfig', (stored) => {
      if (!stored.probexConfig?.agentId) {
        const config = { ...DEFAULT_CONFIG, ...stored.probexConfig };
        config.agentId = `browser-${Math.random().toString(36).substring(2, 8)}`;
        chrome.storage.local.set({ probexConfig: config });
      }
    });
  }
});
