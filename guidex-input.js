// Observe public Runtime DOM state only; never inspect Vue internals or device credentials.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProbeXGuideXInput = api;
})(globalThis, function () {
  'use strict';

  function createObserver({ document, now = () => performance.now(), wallNow = () => Date.now(),
    socket = () => null, enabled = () => true, annotate = () => {}, maxWaitMs = 30000 }) {
    let pending = null;
    const page = () => document.location?.href ?? '';
    function panel() {
      const panels = Array.from(document.querySelectorAll('.gx-input'))
        .filter(p => p.isConnected && p.getClientRects().length > 0);
      return panels.length === 1 ? panels[0] : null;
    }
    function source() {
      const p = panel();
      if (!p || !socket()) return 'unknown';
      if (p.classList.contains('gx-input-local')) return 'multimodal_box';
      return p.querySelector('button.gx-microphone') ? 'browser_mic' : 'unknown';
    }
    function values(p) {
      return { source: 'browser_mic', pressAt: p.pressAt, pressWall: p.pressWall,
        pressKind: p.kind, micRequestAt: p.micRequestAt, micAt: p.micAt, readyAt: p.readyAt };
    }
    function valid() {
      if (!pending) return null;
      const p = pending;
      if (!enabled() || socket() !== p.socket || page() !== p.page || !p.button.isConnected ||
          panel() !== p.panel || source() !== 'browser_mic' ||
          (!p.context && now() - p.pressAt > maxWaitMs)) {
        pending = null;
        return null;
      }
      return p;
    }
    function refresh() {
      const p = valid();
      if (!p) return;
      const active = p.button.getAttribute('aria-pressed') === 'true';
      if (active) p.activeSeen = true;
      // A stopped/failed gesture must never be borrowed by a later turn.
      if (p.activeSeen && !active) { pending = null; return; }
      const indicator = p.button.querySelector('.gx-audio-indicator');
      // Portrait renders the waveform indicator; other layouts expose the same
      // public state through ActionButton's aria-busy attribute.
      const uiReady = indicator
        ? !indicator.classList.contains('gx-audio-waiting')
        : p.button.getAttribute('aria-busy') === 'false';
      if (active && p.micAt != null && uiReady && p.readyAt == null) {
        p.readyAt = now();
        if (p.context) annotate(p.context, values(p));
      }
    }
    function handle(event) {
      if (!enabled() || event.isTrusted !== true) return;
      refresh();
      const button = event.target?.closest?.('button.gx-microphone');
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
      if (['pointercancel', 'lostpointercapture'].includes(event.type) ||
          (event.type === 'keydown' && event.key === 'Escape')) {
        if (pending?.button === button) pending = null;
        return;
      }
      if (event.type === 'pointerdown' && (event.button !== 0 || event.isPrimary !== true)) return;
      if (event.type === 'keydown' && (event.repeat || event.isComposing || ![' ', 'Enter'].includes(event.key))) return;
      if (!['pointerdown', 'keydown', 'click'].includes(event.type)) return;
      if (button.getAttribute('aria-pressed') === 'true') return;
      const p = panel(), s = socket();
      if (!p || !s || button.closest('.gx-input') !== p || source() !== 'browser_mic') return;
      // Pointer/key activation may also generate a native click. Keep the original press.
      if (pending?.button === button && (pending.capture || event.type === 'click')) return;
      pending = { button, panel: p, socket: s, page: page(), pressAt: now(), pressWall: wallNow(),
        kind: event.type === 'pointerdown' ? 'pointer' : event.type === 'keydown' ? 'keyboard' : 'click',
        activeSeen: false };
    }
    return {
      handle, refresh, source,
      captureRequested() {
        const p = valid();
        if (!p || p.capture) return null;
        p.capture = true;
        p.micRequestAt = now();
        return p;
      },
      captureReady(token) {
        const p = valid();
        if (!p || p !== token) return;
        p.micAt = now();
        refresh();
      },
      captureFailed(token) { if (pending === token) pending = null; },
      turnStarted(context) {
        refresh();
        const p = valid();
        const inputSource = context.input === 'audio' ? source() : 'not_applicable';
        const data = { source: inputSource };
        // A real press is associated only after that capture acquired a microphone
        // and the application wrote its first audio frame with native sid/cid.
        if (p && !p.context && context.input === 'audio' && context.socketId === p.socket &&
            p.micAt != null && p.button.getAttribute('aria-pressed') === 'true') {
          p.context = context;
          Object.assign(data, values(p));
        }
        annotate(context, data);
      },
      turnEnded(metrics) {
        const c = pending?.context;
        if (c && c.instanceId === metrics.instance_id && c.sid === metrics.sid && c.cid === metrics.cid)
          pending = null;
      },
      clear(socketId) { if (socketId === undefined || pending?.socket === socketId) pending = null; },
    };
  }
  return { createObserver };
});
