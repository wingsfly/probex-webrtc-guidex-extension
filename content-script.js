// ProbeX WebRTC Monitor - Content Script (ISOLATED world)
// 1. Passes config from chrome.storage to injected.js (MAIN world)
// 2. Proxies fetch requests from injected.js through the extension
//    (bypasses mixed content: HTTPS page → HTTP ProbeX server)
(function () {
  'use strict';

  // --- Config delivery ---

  function sendConfig() {
    try {
      chrome.storage.local.get('probexConfig', (stored) => {
        const c = stored.probexConfig || {};
        window.postMessage({
          type: 'probex-config',
          hubUrl: c.hubUrl || 'http://localhost:8080',
          probeName: c.probeName || 'webrtc-browser',
          agentId: c.agentId || '',
          collectInterval: c.collectInterval || 2000,
          pushInterval: c.pushInterval || 5000,
          enabled: c.enabled !== false,
        }, '*');
      });
    } catch (e) { /* extension context gone */ }
  }

  sendConfig();

  // Only send audio/autotest on the page where Capture was performed
  function sendAutoTestConfig() {
    try {
      chrome.storage.local.get(['autoTestAudio', 'autoTestConfig'], (stored) => {
        const target = stored.autoTestConfig?.targetOrigin;
        if (target && target !== location.origin) return; // not the captured page
        if (stored.autoTestAudio) {
          window.postMessage({ type: 'probex-audio', dataUrl: stored.autoTestAudio }, '*');
        }
        if (stored.autoTestConfig?.running) {
          window.postMessage({
            type: 'probex-autotest-start',
            selector: stored.autoTestConfig.selector,
            interval: stored.autoTestConfig.interval,
          }, '*');
        }
      });
    } catch (e) {}
  }
  sendAutoTestConfig();

  try {
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.probexConfig) sendConfig();
      // Relay audio/autotest only on the captured target page
      if (changes.autoTestAudio?.newValue || changes.autoTestConfig) {
        chrome.storage.local.get('autoTestConfig', (stored) => {
          const target = stored.autoTestConfig?.targetOrigin;
          if (target && target !== location.origin) return;

          if (changes.autoTestAudio?.newValue) {
            window.postMessage({ type: 'probex-audio', dataUrl: changes.autoTestAudio.newValue }, '*');
          }
          if (changes.autoTestConfig) {
            const cfg = changes.autoTestConfig.newValue;
            if (cfg?.running) {
              chrome.storage.local.get('autoTestAudio', (s) => {
                if (s.autoTestAudio) {
                  window.postMessage({ type: 'probex-audio', dataUrl: s.autoTestAudio }, '*');
                }
                window.postMessage({
                  type: 'probex-autotest-start',
                  selector: cfg.selector,
                  interval: cfg.interval,
                }, '*');
              });
            } else {
              window.postMessage({ type: 'probex-autotest-stop' }, '*');
            }
          }
        });
      }
    });
  } catch (e) {}

  // Relay capture results from MAIN world back to storage
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'probex-capture-result') {
      try {
        chrome.storage.local.set({
          autoTestConfig: {
            ...(JSON.parse(localStorage.getItem('__probex_atc') || '{}')),
            selector: event.data.selector,
            targetOrigin: location.origin, // remember which page was captured
            running: false,
          },
        });
      } catch (e) {}
    }
  });

  // --- Fetch proxy: injected.js (MAIN) → content-script (ISOLATED) → background SW ---
  // This bypasses mixed content restrictions because the background SW
  // has host_permissions: <all_urls> and is not bound by the page's protocol.

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'probex-fetch-request') return;

    const { id, url, method, body } = event.data;

    try {
      // Send to background SW which does the actual fetch
      const resp = await chrome.runtime.sendMessage({
        type: 'proxy-fetch',
        url,
        method,
        body,
      });
      window.postMessage({
        type: 'probex-fetch-response',
        id,
        ok: resp?.ok ?? false,
        status: resp?.status ?? 0,
        body: resp?.body ?? null,
      }, '*');
    } catch (e) {
      // Extension context invalidated — tell injected.js to use fallback
      window.postMessage({
        type: 'probex-fetch-response',
        id,
        ok: false,
        status: 0,
        error: 'proxy unavailable',
      }, '*');
    }
  });
})();
