// ProbeX WebRTC Monitor - Content Script (ISOLATED world)
// 1. Passes config from chrome.storage to injected.js (MAIN world)
// 2. Proxies fetch requests from injected.js through the extension
//    (bypasses mixed content: HTTPS page → HTTP ProbeX server)
(function () {
  'use strict';

  if (globalThis.__probexBridgeV2) {
    globalThis.__probexBridgeV2.sendConfig();
    return;
  }
  const bridgeId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  let retired = false;
  const listeners = [];
  const requests = new Map();
  const completed = [];
  function listen(fn) { if (!retired) { listeners.push(fn); window.addEventListener('message', fn); } }
  function retire() {
    if (retired) return;
    retired = true;
    for (const fn of listeners) window.removeEventListener('message', fn);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (_) {}
    delete globalThis.__probexBridgeV2;
  }
  globalThis.__probexBridgeV2 = { sendConfig };

  // --- Config delivery ---

  function sendConfig() {
    if (retired) return;
    try {
      chrome.storage.local.get('probexConfig', (stored) => {
        if (retired) return;
        const c = stored.probexConfig || {};
        window.postMessage({
          type: 'probex-config',
          hubUrl: c.hubUrl || 'http://localhost:8080',
          ingestToken: c.ingestToken || '',
          probeName: c.probeName || 'webrtc-browser',
          agentId: c.agentId || '',
          collectInterval: c.collectInterval || 2000,
          pushInterval: c.pushInterval || 5000,
          enabled: c.enabled !== false,
          guidexProfile: c.guidexProfile || 'auto',
        }, '*');
      });
    } catch (e) { retire(); }
  }

  // Only send audio/autotest on the page where Capture was performed
  function sendAutoTestConfig() {
    if (retired) return;
    try {
      chrome.storage.local.get(['autoTestAudio', 'autoTestConfig'], (stored) => {
        if (retired) return;
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
  function onStorageChanged(changes) {
    try { relayStorageChanges(changes); } catch (_) { retire(); }
  }

  function relayStorageChanges(changes) {
    if (retired) return;
    if (changes.probexConfig) sendConfig();
    if (retired) return;
    // Relay audio/autotest only on the captured target page
    if (changes.autoTestAudio?.newValue || changes.autoTestConfig) {
      chrome.storage.local.get('autoTestConfig', (stored) => {
        if (retired) return;
        const target = stored.autoTestConfig?.targetOrigin;
        if (target && target !== location.origin) return;

        if (changes.autoTestAudio?.newValue) {
          window.postMessage({ type: 'probex-audio', dataUrl: changes.autoTestAudio.newValue }, '*');
        }
        if (changes.autoTestConfig) {
          const cfg = changes.autoTestConfig.newValue;
          if (cfg?.running) {
            chrome.storage.local.get('autoTestAudio', (s) => {
              if (retired) return;
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
  }
  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (e) {}

  // Relay capture results from MAIN world back to storage
  listen((event) => {
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

  listen(async (event) => {
    if (retired || event.source !== window) return;
    if (event.data?.type === 'probex-bridge-discover-v2') {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'probex-bridge-ping-v2' });
        if (!retired && reply?.ok) window.postMessage({ type: 'probex-bridge-ready-v2', id: event.data.id, bridgeId }, '*');
      } catch (_) { retire(); } // Invalidated bridges stay silent, never race the live bridge.
      return;
    }
    if (event.data?.type !== 'probex-fetch-request-v2' || event.data.bridgeId !== bridgeId) return;

    const { id, url, method, headers, body } = event.data;

    if (!requests.has(id)) requests.set(id, forward({ url, method, headers, body }).finally(() => {
      completed.push(id);
      if (completed.length > 256) requests.delete(completed.shift());
    }));
    const response = await requests.get(id);
    window.postMessage({ ...response, type: 'probex-fetch-response-v2', id, bridgeId }, '*');
  });

  async function forward(request) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'proxy-fetch', ...request });
      return { ok: resp?.ok ?? false, status: resp?.status ?? 0 };
    } catch (_) {
      retire();
      return { ok: false, status: 0, error: 'proxy unavailable' };
    }
  }

  sendConfig();
  sendAutoTestConfig();
})();
