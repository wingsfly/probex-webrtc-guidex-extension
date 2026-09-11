// Versioned page/extension RPC: choose a transport before dispatching a write.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProbeXTransport = api;
})(globalThis, function () {
  'use strict';

  function newId() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes); // Also available on HTTP GuideX pages.
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function createClient({ window, fetch, discoveryTimeout = 1000, requestTimeout = 30000 }) {
    const pending = new Map();
    window.addEventListener('message', event => {
      if (event.source !== window) return;
      const data = event.data;
      const entry = pending.get(data?.id);
      if (!entry || data.type !== entry.type || (entry.bridgeId && data.bridgeId !== entry.bridgeId)) return;
      if (data.type === 'probex-bridge-ready-v2' && !data.bridgeId) return;
      entry.finish(data);
    });

    function rpc(message, type, timeout, bridgeId) {
      return new Promise(resolve => {
        const id = newId();
        const timer = setTimeout(() => finish(null), timeout);
        function finish(value) { clearTimeout(timer); pending.delete(id); resolve(value); }
        pending.set(id, { type, bridgeId, finish });
        window.postMessage({ ...message, id, bridgeId }, '*');
      });
    }

    return async function request(url, options) {
      const bridge = await rpc({ type: 'probex-bridge-discover-v2' }, 'probex-bridge-ready-v2', discoveryTimeout);
      // Discovery cannot issue HTTP requests, so this fallback is safe even if a
      // late bridge responds. After dispatch, failures have an unknown outcome.
      if (!bridge) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeout);
        try { return await fetch(url, { ...options, signal: controller.signal }); }
        finally { clearTimeout(timer); }
      }
      const response = await rpc({ type: 'probex-fetch-request-v2', url,
        method: options.method || 'GET', headers: options.headers, body: options.body },
      'probex-fetch-response-v2', requestTimeout, bridge.bridgeId);
      if (!response || !response.status) throw new Error('ProbeX proxy outcome unknown; retry with the same result_id');
      return { ok: response.ok, status: response.status };
    };
  }

  return { newId, createClient };
});
