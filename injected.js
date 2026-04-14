// ProbeX WebRTC Monitor - Injected into page main world
// Hooks RTCPeerConnection, collects getStats(), and pushes directly to ProbeX hub.
// Runs as pure page JS — survives extension updates/restarts.
(function () {
  'use strict';

  // If already hooked, just update config and resume
  if (window.__probexWebrtcHooked) {
    if (window.__probexResume) window.__probexResume();
    return;
  }
  window.__probexWebrtcHooked = true;

  const OriginalRTCPeerConnection =
    window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!OriginalRTCPeerConnection) return;

  // ====== Audio Injection for Auto-Test ======
  // Strategy: hook getUserMedia to return a proxy stream whose audio track we control.
  // The app (Guidex/XRTC) uses receive-only PeerConnections for downstream, and sends
  // mic audio upstream via a separate channel (WebSocket/HTTP). By hooking getUserMedia,
  // we intercept the mic stream regardless of how the app transmits it.

  const origGetUserMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  let audioCtx = null;
  let audioBuffer = null;       // decoded AudioBuffer for test audio
  let currentSource = null;     // active AudioBufferSourceNode
  let micGainNode = null;       // controls real mic volume (0 when injecting)
  let injectGainNode = null;    // controls injected audio volume (0 normally)
  let streamDest = null;        // MediaStreamDestination → proxy audio track

  function ensureAudioCtx() {
    if (audioCtx) return;
    audioCtx = new AudioContext();
    streamDest = audioCtx.createMediaStreamDestination();
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = 1;
    micGainNode.connect(streamDest);
    injectGainNode = audioCtx.createGain();
    injectGainNode.gain.value = 0;
    injectGainNode.connect(streamDest);
  }

  // Hook getUserMedia — intercept audio streams.
  // Must survive SES lockdown (Secure EcmaScript) which may freeze/overwrite properties.
  // Hook at both prototype level and instance level, with Object.defineProperty for resilience.

  const origProtoGUM = MediaDevices.prototype.getUserMedia;

  async function hookedGetUserMedia(constraints) {
    if (!constraints?.audio) {
      return origProtoGUM.call(this, constraints);
    }

    ensureAudioCtx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Try to get real mic stream; if no mic available, create a silent proxy anyway
    let realStream = null;
    try {
      realStream = await origProtoGUM.call(this, constraints);
      // Connect real mic to our mixer
      const micSource = audioCtx.createMediaStreamSource(realStream);
      micSource.connect(micGainNode);
    } catch (e) {
      console.debug('[ProbeX] getUserMedia: no mic (' + e.name + '), using silent proxy stream');
      // No mic — return proxy with silent audio (will be filled by test audio injection)
    }

    const proxy = new MediaStream();
    // Keep video tracks from real stream if available
    if (realStream) realStream.getVideoTracks().forEach(t => proxy.addTrack(t));
    // Audio from our mixer (silent when no mic, test audio when playing)
    streamDest.stream.getAudioTracks().forEach(t => proxy.addTrack(t));

    console.log('[ProbeX] getUserMedia intercepted: proxy stream returned (mic=' + (realStream ? 'real' : 'none') + ')');
    return proxy;
  }

  // Apply hook at prototype level. Must stay writable so SES lockdown doesn't crash.
  // We let SES overwrite it, then re-apply after SES finishes.
  try {
    MediaDevices.prototype.getUserMedia = hookedGetUserMedia;
    console.log('[ProbeX] getUserMedia hook installed (prototype)');
  } catch (e) {
    console.warn('[ProbeX] getUserMedia hook FAILED:', e.message);
  }

  // Also hook the legacy API
  if (navigator.getUserMedia) {
    const origLegacy = navigator.getUserMedia.bind(navigator);
    navigator.getUserMedia = function (constraints, onSuccess, onError) {
      origLegacy(constraints, (stream) => {
        if (!constraints?.audio) { onSuccess(stream); return; }
        hookedGetUserMedia.call(navigator.mediaDevices, constraints)
          .then(onSuccess).catch(onError);
      }, onError);
    };
  }

  // ====== Track WebSocket connections + monitor voiceDictation protocol ======
  window.__probexWsList = [];
  let voiceDictationWs = null;
  let vdSendCount = 0;

  const OrigWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
    window.__probexWsList.push(ws);
    console.log('[ProbeX][TRACE] WebSocket created: ' + url);

    if (url.includes('voiceDictation')) {
      voiceDictationWs = ws;
      vdSendCount = 0;
      console.log('[ProbeX] voiceDictation WebSocket detected!');
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data === 'string') {
          console.log('[ProbeX][VD] recv: ' + ev.data.slice(0, 300));
        }
      });
    }

    // Monitor interact WS for TTS/avatar response events
    if (url.includes('/v1/interact')) {
      console.log('[ProbeX] interact WebSocket detected!');
      let interactMsgCount = 0;
      ws.addEventListener('message', (ev) => {
        interactMsgCount++;
        if (typeof ev.data === 'string' && interactMsgCount <= 20) {
          console.log('[ProbeX][INTERACT] recv #' + interactMsgCount + ': ' + ev.data.slice(0, 400));
        }
      });
    }

    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  Object.keys(OrigWebSocket).forEach(k => { window.WebSocket[k] = OrigWebSocket[k]; });
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => { window.WebSocket[k] = OrigWebSocket[k]; });

  // Hook WebSocket.prototype.send to intercept ALL sends (survives SES + prototype.call patterns)
  const origWsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (this === voiceDictationWs || (this.url && this.url.includes('voiceDictation'))) {
      vdSendCount++;
      if (vdSendCount <= 10) {
        if (data instanceof ArrayBuffer) {
          const hex = Array.from(new Uint8Array(data.slice(0, 32))).map(b => b.toString(16).padStart(2, '0')).join(' ');
          console.log('[ProbeX][VD] send #' + vdSendCount + ' binary ' + data.byteLength + 'B | ' + hex);
        } else if (data instanceof Blob) {
          console.log('[ProbeX][VD] send #' + vdSendCount + ' blob ' + data.size + 'B type=' + data.type);
        } else if (typeof data === 'string') {
          console.log('[ProbeX][VD] send #' + vdSendCount + ' text: ' + data.slice(0, 300));
        }
      }
    }
    return origWsSend.call(this, data);
  };

  // ====== Track SpeechRecognition (may capture mic without getUserMedia) ======
  const OrigSpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (OrigSpeechRecognition) {
    const origStart = OrigSpeechRecognition.prototype.start;
    OrigSpeechRecognition.prototype.start = function () {
      console.log('[ProbeX][TRACE] SpeechRecognition.start() called');
      return origStart.call(this);
    };
  }

  // ====== Trace all possible audio capture paths ======
  // The XRTC SDK might not use getUserMedia directly. Detect how it captures audio.

  const origCreateMediaStreamSource = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    console.log('[ProbeX][TRACE] AudioContext.createMediaStreamSource called, tracks:', stream.getAudioTracks().map(t => t.label));
    return origCreateMediaStreamSource.call(this, stream);
  };

  const origMediaRecorder = window.MediaRecorder;
  if (origMediaRecorder) {
    window.MediaRecorder = function (stream, options) {
      console.log('[ProbeX][TRACE] MediaRecorder created, audio tracks:', stream.getAudioTracks().map(t => t.label));
      return new origMediaRecorder(stream, options);
    };
    window.MediaRecorder.prototype = origMediaRecorder.prototype;
    Object.keys(origMediaRecorder).forEach(k => { window.MediaRecorder[k] = origMediaRecorder[k]; });
  }

  // Hook addTrack/addStream on PeerConnection to detect any send tracks
  const origAddTrack = OriginalRTCPeerConnection.prototype.addTrack;
  OriginalRTCPeerConnection.prototype.addTrack = function (track, ...streams) {
    console.log('[ProbeX][TRACE] PC.addTrack kind=' + track.kind + ' label=' + track.label);
    return origAddTrack.call(this, track, ...streams);
  };

  const origAddStream = OriginalRTCPeerConnection.prototype.addStream;
  if (origAddStream) {
    OriginalRTCPeerConnection.prototype.addStream = function (stream) {
      console.log('[ProbeX][TRACE] PC.addStream tracks:', stream.getTracks().map(t => t.kind + ':' + t.label));
      return origAddStream.call(this, stream);
    };
  }

  // Periodic check: re-apply hooks if SES/lockdown overwrites them.
  const hookedWsSend = WebSocket.prototype.send; // save our hooked version
  let hookCheckInterval = setInterval(() => {
    try {
      if (MediaDevices.prototype.getUserMedia !== hookedGetUserMedia) {
        MediaDevices.prototype.getUserMedia = hookedGetUserMedia;
      }
      if (navigator.mediaDevices &&
          Object.prototype.hasOwnProperty.call(navigator.mediaDevices, 'getUserMedia') &&
          navigator.mediaDevices.getUserMedia !== hookedGetUserMedia) {
        navigator.mediaDevices.getUserMedia = hookedGetUserMedia;
      }
      // Also protect WebSocket.prototype.send hook
      if (WebSocket.prototype.send !== hookedWsSend) {
        WebSocket.prototype.send = hookedWsSend;
      }
    } catch (e) {}
  }, 1000); // Check every second, indefinitely (very lightweight)

  /** Send test audio directly through the voiceDictation WebSocket.
   *  Bypasses getUserMedia/MediaRecorder entirely — sends PCM chunks in the
   *  same format the Guidex SDK uses: {"status":1,"message":"<base64 PCM>"} */
  function playTestAudio() {
    return new Promise((resolve) => {
      if (!audioBuffer) { console.warn('[ProbeX] No audio buffer loaded'); resolve(); return; }
      if (!voiceDictationWs || voiceDictationWs.readyState !== WebSocket.OPEN) {
        console.warn('[ProbeX] voiceDictation WebSocket not open');
        resolve();
        return;
      }

      // Convert AudioBuffer to 16-bit PCM at 16kHz (iFlytek ASR standard)
      const targetRate = 16000;
      const srcData = audioBuffer.getChannelData(0); // mono channel
      const ratio = audioBuffer.sampleRate / targetRate;
      const targetLen = Math.floor(srcData.length / ratio);
      const pcm16 = new Int16Array(targetLen);
      for (let i = 0; i < targetLen; i++) {
        const srcIdx = Math.floor(i * ratio);
        const sample = Math.max(-1, Math.min(1, srcData[srcIdx]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      // Split into chunks (~40ms each, matching typical ASR frame size)
      const chunkSamples = Math.floor(targetRate * 0.04); // 640 samples per 40ms
      const totalChunks = Math.ceil(pcm16.length / chunkSamples);
      const sendInterval = 40;

      console.log('[ProbeX] Sending test audio via WS: ' + audioBuffer.duration.toFixed(1) + 's, ' + totalChunks + ' chunks @ ' + sendInterval + 'ms');

      const ws = voiceDictationWs;
      const origSendRef = OrigWebSocket.prototype.send.bind(ws);

      // Pre-encode all chunks to base64 strings
      const encodedChunks = [];
      for (let i = 0; i < totalChunks; i++) {
        const start = i * chunkSamples;
        const end = Math.min(start + chunkSamples, pcm16.length);
        const chunk = pcm16.slice(start, end);
        const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        let binary = '';
        for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
        encodedChunks.push(btoa(binary));
      }

      // Use a Web Worker for accurate timing even when tab is hidden.
      // Worker timers are NOT throttled by Chrome's background tab policy.
      const workerCode = `
        let idx = 0, total = 0, interval = 40;
        self.onmessage = (e) => {
          total = e.data.total;
          interval = e.data.interval;
          tick();
        };
        function tick() {
          if (idx >= total) { self.postMessage({ done: true, sent: idx }); return; }
          self.postMessage({ idx: idx });
          idx++;
          setTimeout(tick, interval);
        }
      `;
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const worker = new Worker(URL.createObjectURL(blob));

      worker.onmessage = (e) => {
        if (e.data.done) {
          worker.terminate();
          URL.revokeObjectURL(blob);
          console.log('[ProbeX] Test audio send complete (' + e.data.sent + '/' + totalChunks + ' chunks)');
          resolve();
          return;
        }
        const idx = e.data.idx;
        if (ws.readyState !== WebSocket.OPEN) {
          worker.terminate();
          console.warn('[ProbeX] WS closed during send at chunk ' + idx);
          resolve();
          return;
        }
        try {
          origSendRef(JSON.stringify({ status: 1, message: encodedChunks[idx] }));
        } catch (err) {
          console.error('[ProbeX] WS send error:', err.message);
          worker.terminate();
          resolve();
        }
      };

      worker.postMessage({ total: totalChunks, interval: sendInterval });
    });
  }

  /** Send voiceDictation end message (status=2) to close the ASR session */
  function sendVoiceDictationEnd() {
    if (!voiceDictationWs || voiceDictationWs.readyState !== WebSocket.OPEN) return;
    try {
      const msg = JSON.stringify({ status: 2, message: '', language: 'en' });
      OrigWebSocket.prototype.send.call(voiceDictationWs, msg);
      console.log('[ProbeX] Sent voiceDictation end (status=2)');
    } catch (e) {}
  }

  // --- Config (injected via postMessage from content-script) ---
  let hubUrl = 'http://localhost:8080';
  let probeName = 'webrtc-browser';
  let agentId = '';
  let collectInterval = 2000;
  let pushInterval = 5000;
  let enabled = true;
  let registered = false;

  // --- State ---
  const connections = new Map();
  let nextId = 1;
  let resultBuffer = [];
  let collectTimer = null;
  let pushTimer = null;
  let stopped = false;
  let pushOk = 0;
  let pushFail = 0;
  let lastPushAt = 0;
  let latestMetrics = null;
  let activeConnections = 0;

  // Listen for config from content-script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'probex-config') {
      const c = event.data;
      if (c.hubUrl) hubUrl = c.hubUrl;
      if (c.probeName) probeName = c.probeName;
      if (c.agentId) agentId = c.agentId;
      if (c.collectInterval) {
        collectInterval = c.collectInterval;
        startCollectLoop();
      }
      if (c.pushInterval) {
        pushInterval = c.pushInterval;
        startPushLoop();
      }
      if (c.enabled !== undefined) {
        enabled = c.enabled;
        if (enabled) { startCollectLoop(); startPushLoop(); }
        else { stopAll(); }
      }
      // Re-register if probe name changed
      registered = false;
      return;
    }

    if (event.data?.type === 'probex-stop') {
      stopAll();
      return;
    }

    // Auto-test: receive audio file as base64 data URL
    if (event.data?.type === 'probex-audio') {
      loadAudioFromDataUrl(event.data.dataUrl);
      return;
    }

    // Auto-test: start/stop
    if (event.data?.type === 'probex-autotest-start') {
      startAutoTest(event.data.selector, event.data.interval);
      return;
    }
    if (event.data?.type === 'probex-autotest-stop') {
      stopAutoTest();
      return;
    }
  });

  // ====== RTCPeerConnection Hook ======

  function ProxiedRTCPeerConnection(config, constraints) {
    const pc = constraints
      ? new OriginalRTCPeerConnection(config, constraints)
      : new OriginalRTCPeerConnection(config);

    const id = nextId++;
    connections.set(id, { pc, prevStats: null });
    console.log('[ProbeX] new PeerConnection #%d, total=%d', id, connections.size);

    const origClose = pc.close.bind(pc);
    pc.close = function () {
      connections.delete(id);
      console.log('[ProbeX] PC #%d closed (close()), remaining=%d', id, connections.size);
      return origClose();
    };
    pc.addEventListener('connectionstatechange', () => {
      console.log('[ProbeX] PC #%d state=%s', id, pc.connectionState);
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        connections.delete(id);
        console.log('[ProbeX] PC #%d removed, remaining=%d', id, connections.size);
      }
    });
    return pc;
  }

  ProxiedRTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.keys(OriginalRTCPeerConnection).forEach(k => { ProxiedRTCPeerConnection[k] = OriginalRTCPeerConnection[k]; });
  ProxiedRTCPeerConnection.generateCertificate = OriginalRTCPeerConnection.generateCertificate;

  window.RTCPeerConnection = ProxiedRTCPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = ProxiedRTCPeerConnection;

  // ====== Stats Collection (500ms sub-sampling → 2s max-aggregated push) ======

  const SUBSAMPLE_INTERVAL = 500;  // collect getStats every 500ms
  const REPORT_INTERVAL = 2000;    // aggregate and report every 2s
  let subSamples = [];             // accumulate sub-samples within the 2s window

  async function collectSubSample() {
    if (stopped || !enabled) return;

    for (const [id, entry] of connections) {
      const { pc, prevStats } = entry;
      if (pc.connectionState === 'closed' || pc.connectionState === 'failed') {
        connections.delete(id);
        continue;
      }
      try {
        const stats = await pc.getStats();
        const metrics = extractMetrics(stats, prevStats);
        if (metrics) {
          latestMetrics = metrics;
          subSamples.push(metrics);
        }
        entry.prevStats = statsToMap(stats);
      } catch (e) {}
    }
  }

  function flushSubSamples() {
    if (subSamples.length === 0) return;

    // Aggregate: take max of sync metrics, last value of others
    const last = subSamples[subSamples.length - 1];
    const aggregated = { ...last };

    // For jitter buffer and sync metrics, take the max absolute value (worst case)
    let maxAvSync = null;
    let maxAudioJb = null;
    let maxVideoJb = null;
    for (const s of subSamples) {
      if (s.avSyncDiffMs != null) {
        if (maxAvSync == null || Math.abs(s.avSyncDiffMs) > Math.abs(maxAvSync)) maxAvSync = s.avSyncDiffMs;
      }
      if (s.audioJbDelayMs != null) {
        if (maxAudioJb == null || s.audioJbDelayMs > maxAudioJb) maxAudioJb = s.audioJbDelayMs;
      }
      if (s.videoJbDelayMs != null) {
        if (maxVideoJb == null || s.videoJbDelayMs > maxVideoJb) maxVideoJb = s.videoJbDelayMs;
      }
    }
    if (maxAvSync != null) aggregated.avSyncDiffMs = maxAvSync;
    if (maxAudioJb != null) aggregated.audioJbDelayMs = maxAudioJb;
    if (maxVideoJb != null) aggregated.videoJbDelayMs = maxVideoJb;

    resultBuffer.push({
      timestamp: new Date().toISOString(),
      pageUrl: location.href,
      connectionCount: connections.size,
      metrics: aggregated,
    });

    subSamples = [];
    if (resultBuffer.length > 200) resultBuffer = resultBuffer.slice(-100);
  }

  // ====== Network: proxy through extension (avoids mixed content) with direct fallback ======

  // Request ID counter for proxy RPC
  let rpcId = 0;
  const rpcCallbacks = new Map();

  // Listen for proxy responses from content-script
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'probex-fetch-response') return;
    const cb = rpcCallbacks.get(event.data.id);
    if (cb) { rpcCallbacks.delete(event.data.id); cb(event.data); }
  });

  function proxyFetch(url, options) {
    return new Promise((resolve) => {
      const id = ++rpcId;
      const timeout = setTimeout(() => {
        rpcCallbacks.delete(id);
        resolve(null); // null = proxy unavailable, caller should fallback
      }, 3000);
      rpcCallbacks.set(id, (data) => {
        clearTimeout(timeout);
        resolve(data); // { ok, status, body }
      });
      window.postMessage({
        type: 'probex-fetch-request',
        id,
        url,
        method: options.method || 'GET',
        body: options.body || null,
      }, '*');
    });
  }

  // Unified fetch: try extension proxy first (no mixed content), fallback to direct
  async function probexFetch(url, options) {
    // Try proxy through content-script → background (bypasses mixed content)
    const proxyResult = await proxyFetch(url, options);
    // Only trust proxy if it got a real HTTP response (status > 0)
    if (proxyResult && proxyResult.status > 0) {
      return { ok: proxyResult.ok, status: proxyResult.status };
    }
    // Fallback: direct fetch (works for localhost, same-protocol, etc.)
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body || null,
    });
    return { ok: resp.ok, status: resp.status };
  }

  // ====== Push to ProbeX ======

  async function registerProbe() {
    try {
      const result = await probexFetch(`${hubUrl}/api/v1/probes/register`, {
        method: 'POST',
        body: JSON.stringify({
          name: probeName,
          description: 'Chrome extension: browser-side WebRTC quality monitor via getStats()',
          output_schema: {
            standard_fields: ['latency_ms', 'packet_loss_pct', 'download_bps', 'upload_bps'],
            extra_fields: [
              { name: 'audio_jitter', type: 'number', unit: 'ms', description: 'Audio RTP interarrival jitter', chartable: true },
              { name: 'video_jitter', type: 'number', unit: 'ms', description: 'Video RTP interarrival jitter', chartable: true },
              { name: 'video_frames_decoded', type: 'number', unit: 'frames', chartable: true },
              { name: 'video_frames_dropped', type: 'number', unit: 'frames', chartable: true },
              { name: 'video_fps', type: 'number', unit: 'fps', chartable: true },
              { name: 'quality_limitation', type: 'string', description: 'cpu/bandwidth/none' },
              { name: 'available_outgoing_bitrate', type: 'number', unit: 'bps', chartable: true },
              { name: 'audio_jb_delay_ms', type: 'number', unit: 'ms', description: 'Audio jitter buffer playout delay', chartable: true },
              { name: 'video_jb_delay_ms', type: 'number', unit: 'ms', description: 'Video jitter buffer playout delay', chartable: true },
              { name: 'av_sync_diff_ms', type: 'number', unit: 'ms', description: 'Video-Audio jitter buffer delay diff (>0 = video lags)', chartable: true },
              { name: 'page_url', type: 'string', description: 'Source page URL' },
              { name: 'connection_count', type: 'number', description: 'Active PeerConnection count' },
            ],
          },
        }),
      });
      registered = result.ok || result.status === 409;
    } catch (e) { registered = false; }
  }

  let regFailCount = 0;
  async function pushResults() {
    if (!enabled || resultBuffer.length === 0) return;
    if (!registered) {
      regFailCount++;
      // Exponential backoff: only retry registration every 2^n cycles (max 64 = ~5 min)
      const retryEvery = Math.min(64, Math.pow(2, Math.floor(Math.log2(regFailCount))));
      if (regFailCount % retryEvery !== 0) return;
      await registerProbe();
      if (!registered) {
        if (regFailCount <= 1) {
          console.debug('[ProbeX] ProbeX hub unreachable (' + hubUrl + '), will retry with backoff');
        }
        // Don't let buffer grow unbounded when server is unreachable
        if (resultBuffer.length > 50) resultBuffer = resultBuffer.slice(-20);
        return;
      }
      regFailCount = 0;
    }

    const batch = resultBuffer.splice(0);
    const probeResults = mergeBatch(batch);
    if (probeResults.length === 0) return;

    try {
      const result = await probexFetch(
        `${hubUrl}/api/v1/probes/${encodeURIComponent(probeName)}/push`,
        {
          method: 'POST',
          body: JSON.stringify({
            task_id: `ext_${probeName}`,
            agent_id: agentId,
            results: probeResults,
          }),
        }
      );
      if (result.ok) {
        pushOk += probeResults.length;
        lastPushAt = Date.now();
        console.log('[ProbeX] pushed %d results OK', probeResults.length);
      } else {
        pushFail++;
        console.error('[ProbeX] push HTTP %d', result.status);
      }
      if (result.status === 404) registered = false;
      activeConnections = batch[batch.length - 1]?.connectionCount || 0;
    } catch (e) {
      pushFail++;
      console.error('[ProbeX] push error:', e.message);
      resultBuffer.unshift(...batch.slice(-20));
    }
  }

  function mergeBatch(batch) {
    const probeResults = [];
    const groups = new Map();
    for (const item of batch) {
      const key = item.timestamp;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [ts, items] of groups) {
      const result = { timestamp: ts, success: true, extra: {} };
      let totalDown = 0, hasDown = false, totalUp = 0, hasUp = false;
      let totalDecoded = 0, hasDecoded = false, totalDropped = 0, hasDropped = false;
      let worstLoss = 0;
      for (const item of items) {
        const r = item.metrics;
        if (result.latency_ms == null && r.latencyMs != null) result.latency_ms = r.latencyMs;
        if (!result.extra.audio_jitter && r.audioJitter != null) result.extra.audio_jitter = r.audioJitter;
        if (!result.extra.video_jitter && r.videoJitter != null) result.extra.video_jitter = r.videoJitter;
        if (!result.extra.video_fps && r.videoFps != null) result.extra.video_fps = r.videoFps;
        if (!result.extra.quality_limitation || result.extra.quality_limitation === 'none') {
          if (r.qualityLimitation) result.extra.quality_limitation = r.qualityLimitation;
        }
        if (!result.extra.available_outgoing_bitrate && r.availableOutgoingBitrate != null)
          result.extra.available_outgoing_bitrate = r.availableOutgoingBitrate;
        // Jitter buffer delay (first-wins)
        if (result.extra.audio_jb_delay_ms == null && r.audioJbDelayMs != null)
          result.extra.audio_jb_delay_ms = Math.round(r.audioJbDelayMs * 100) / 100;
        if (result.extra.video_jb_delay_ms == null && r.videoJbDelayMs != null)
          result.extra.video_jb_delay_ms = Math.round(r.videoJbDelayMs * 100) / 100;
        if (result.extra.av_sync_diff_ms == null && r.avSyncDiffMs != null)
          result.extra.av_sync_diff_ms = r.avSyncDiffMs;
        if (r.packetLossPct != null && r.packetLossPct > worstLoss) worstLoss = r.packetLossPct;
        if (r.downloadBps != null) { totalDown += r.downloadBps; hasDown = true; }
        if (r.uploadBps != null) { totalUp += r.uploadBps; hasUp = true; }
        if (r.videoFramesDecoded != null) { totalDecoded += r.videoFramesDecoded; hasDecoded = true; }
        if (r.videoFramesDropped != null) { totalDropped += r.videoFramesDropped; hasDropped = true; }
      }
      result.packet_loss_pct = worstLoss;
      if (hasDown) result.download_bps = totalDown;
      if (hasUp) result.upload_bps = totalUp;
      if (hasDecoded) result.extra.video_frames_decoded = totalDecoded;
      if (hasDropped) result.extra.video_frames_dropped = totalDropped;
      result.extra.page_url = items[0].pageUrl || '';
      result.extra.connection_count = items[0].connectionCount || 0;
      probeResults.push(result);
    }
    return probeResults;
  }

  // ====== Metric Extraction (unchanged logic) ======

  function statsToMap(statsReport) {
    const map = new Map();
    statsReport.forEach(r => map.set(r.id, { ...r }));
    return map;
  }

  function extractMetrics(currentReport, prevMap) {
    const now = {};
    const inboundAudio = [], inboundVideo = [], outboundAudio = [], outboundVideo = [], remoteInbound = [];
    let selectedPair = null;

    currentReport.forEach(report => {
      if (report.type === 'inbound-rtp') {
        if (report.kind === 'audio') inboundAudio.push(report);
        else if (report.kind === 'video') inboundVideo.push(report);
      } else if (report.type === 'outbound-rtp') {
        if (report.kind === 'audio') outboundAudio.push(report);
        else if (report.kind === 'video') outboundVideo.push(report);
      } else if (report.type === 'remote-inbound-rtp') {
        remoteInbound.push(report);
      } else if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        if (!selectedPair || report.nominated || report.bytesReceived > (selectedPair.bytesReceived || 0))
          selectedPair = report;
      }
    });

    if (inboundAudio.length === 0 && inboundVideo.length === 0 && remoteInbound.length === 0)
      return null;

    // RTT
    let rttMs = null;
    for (const r of remoteInbound) { if (r.roundTripTime != null) { rttMs = r.roundTripTime * 1000; break; } }
    if (rttMs == null && selectedPair?.currentRoundTripTime != null) rttMs = selectedPair.currentRoundTripTime * 1000;
    now.latencyMs = rttMs;

    // Audio jitter
    for (const r of inboundAudio) { if (r.jitter != null) { now.audioJitter = r.jitter * 1000; break; } }
    // Video jitter
    for (const r of inboundVideo) { if (r.jitter != null) { now.videoJitter = r.jitter * 1000; break; } }

    // Jitter buffer delay (for audio/video sync analysis)
    // Use INCREMENTAL calculation for instantaneous delay (not cumulative average)
    let audioJbDelay = null, videoJbDelay = null;
    for (const r of inboundAudio) {
      if (r.jitterBufferDelay != null && r.jitterBufferEmittedCount > 0) {
        if (prevMap) {
          const prev = prevMap.get(r.id);
          if (prev && prev.jitterBufferEmittedCount != null) {
            const dDelay = r.jitterBufferDelay - (prev.jitterBufferDelay || 0);
            const dCount = r.jitterBufferEmittedCount - (prev.jitterBufferEmittedCount || 0);
            if (dCount > 0) audioJbDelay = (dDelay / dCount) * 1000; // ms, instantaneous
          }
        }
        if (audioJbDelay == null) {
          audioJbDelay = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000; // fallback: cumulative
        }
        break;
      }
    }
    for (const r of inboundVideo) {
      if (r.jitterBufferDelay != null && r.jitterBufferEmittedCount > 0) {
        if (prevMap) {
          const prev = prevMap.get(r.id);
          if (prev && prev.jitterBufferEmittedCount != null) {
            const dDelay = r.jitterBufferDelay - (prev.jitterBufferDelay || 0);
            const dCount = r.jitterBufferEmittedCount - (prev.jitterBufferEmittedCount || 0);
            if (dCount > 0) videoJbDelay = (dDelay / dCount) * 1000;
          }
        }
        if (videoJbDelay == null) {
          videoJbDelay = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000;
        }
        break;
      }
    }
    now.audioJbDelayMs = audioJbDelay != null ? Math.round(audioJbDelay * 100) / 100 : null;
    now.videoJbDelayMs = videoJbDelay != null ? Math.round(videoJbDelay * 100) / 100 : null;
    // Instantaneous A/V sync: positive = video delayed more (mouth lags behind voice)
    now.avSyncDiffMs = (audioJbDelay != null && videoJbDelay != null) ? Math.round((videoJbDelay - audioJbDelay) * 100) / 100 : null;

    // Debug: log first non-null JB values
    if ((audioJbDelay != null || videoJbDelay != null) && !now._jbLogged) {
      console.log('[ProbeX] JB delay: audio=' + (audioJbDelay?.toFixed(1) || '-') + 'ms video=' + (videoJbDelay?.toFixed(1) || '-') + 'ms sync=' + (now.avSyncDiffMs ?? '-') + 'ms');
      now._jbLogged = true;
    }

    // Packet loss
    let totalLostDelta = 0, totalRecvDelta = 0;
    const allInbound = [...inboundAudio, ...inboundVideo];
    if (prevMap) {
      for (const r of allInbound) {
        const prev = prevMap.get(r.id);
        if (prev) {
          totalLostDelta += (r.packetsLost || 0) - (prev.packetsLost || 0);
          totalRecvDelta += (r.packetsReceived || 0) - (prev.packetsReceived || 0);
        }
      }
    }
    const totalPkt = totalRecvDelta + totalLostDelta;
    now.packetLossPct = totalPkt > 0 ? (totalLostDelta / totalPkt) * 100 : 0;

    // Download bitrate
    let bytesRecvDelta = 0, timeDelta = 0;
    if (prevMap) {
      for (const r of allInbound) {
        const prev = prevMap.get(r.id);
        if (prev) { bytesRecvDelta += (r.bytesReceived || 0) - (prev.bytesReceived || 0); if (!timeDelta) timeDelta = (r.timestamp - prev.timestamp) / 1000; }
      }
    }
    now.downloadBps = timeDelta > 0 ? (bytesRecvDelta * 8) / timeDelta : null;

    // Upload bitrate
    let bytesSentDelta = 0, sendDelta = 0;
    if (prevMap) {
      for (const r of [...outboundAudio, ...outboundVideo]) {
        const prev = prevMap.get(r.id);
        if (prev) { bytesSentDelta += (r.bytesSent || 0) - (prev.bytesSent || 0); if (!sendDelta) sendDelta = (r.timestamp - prev.timestamp) / 1000; }
      }
    }
    now.uploadBps = sendDelta > 0 ? (bytesSentDelta * 8) / sendDelta : null;

    // Video frames
    let framesDecodedDelta = 0, framesDroppedDelta = 0, videoFps = null;
    for (const r of inboundVideo) {
      if (prevMap) {
        const prev = prevMap.get(r.id);
        if (prev) { framesDecodedDelta += (r.framesDecoded || 0) - (prev.framesDecoded || 0); framesDroppedDelta += (r.framesDropped || 0) - (prev.framesDropped || 0); }
      }
      if (r.framesPerSecond != null) videoFps = r.framesPerSecond;
    }
    now.videoFramesDecoded = framesDecodedDelta;
    now.videoFramesDropped = framesDroppedDelta;
    now.videoFps = videoFps;

    // Quality limitation
    now.qualityLimitation = 'none';
    for (const r of outboundVideo) { if (r.qualityLimitationReason && r.qualityLimitationReason !== 'none') { now.qualityLimitation = r.qualityLimitationReason; break; } }

    // Available outgoing bitrate
    now.availableOutgoingBitrate = selectedPair?.availableOutgoingBitrate ?? null;

    return now;
  }

  // ====== Auto-Test: Audio Loading ======

  let audioLoadPromise = null;

  function loadAudioFromDataUrl(dataUrl) {
    if (!dataUrl) return Promise.resolve();
    audioLoadPromise = (async () => {
      try {
        ensureAudioCtx();
        // Decode Base64 data URL directly (avoids fetch which can be blocked by CSP)
        const base64 = dataUrl.split(',')[1];
        if (!base64) throw new Error('Invalid data URL');
        const binaryStr = atob(base64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        audioBuffer = await audioCtx.decodeAudioData(bytes.buffer);
        console.log('[ProbeX] Audio loaded: ' + audioBuffer.duration.toFixed(1) + 's, ' + audioBuffer.numberOfChannels + ' ch, ' + audioBuffer.sampleRate + ' Hz');
      } catch (e) {
        console.debug('[ProbeX] Audio decode skipped:', e.message);
        audioBuffer = null;
      }
    })();
    return audioLoadPromise;
  }

  // ====== Auto-Test: Element Capture ======

  function generateSelector(el) {
    // Try id first
    if (el.id) return '#' + CSS.escape(el.id);

    // Try unique class name (filter out framework-generated ones like data-v-xxx)
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(c =>
        c && !/^[\d]/.test(c) && !/^data-v-/.test(c) && c.length > 2
      );
      for (const cls of classes) {
        const sel = el.tagName.toLowerCase() + '.' + CSS.escape(cls);
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      // Try class combination
      if (classes.length >= 2) {
        const sel = el.tagName.toLowerCase() + '.' + classes.slice(0, 3).map(c => CSS.escape(c)).join('.');
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // Try unique attribute (aria-label, title, alt, role, etc.)
    for (const attr of ['aria-label', 'title', 'alt', 'role', 'name']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = el.tagName.toLowerCase() + '[' + attr + '="' + CSS.escape(val) + '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // Try src attribute for images
    if (el.tagName === 'IMG' && el.src) {
      // Use the filename part of src for a partial match
      const filename = el.src.split('/').pop()?.split('?')[0];
      if (filename) {
        const sel = 'img[src*="' + CSS.escape(filename) + '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // Fallback: short path (max 3 levels, no nth-child)
    const parts = [];
    let node = el;
    while (node && node !== document.body && parts.length < 3) {
      let seg = node.tagName.toLowerCase();
      if (node.className && typeof node.className === 'string') {
        const cls = node.className.trim().split(/\s+/).filter(c =>
          c && c.length > 2 && !/^data-v-/.test(c)
        ).slice(0, 2);
        if (cls.length) seg += '.' + cls.map(c => CSS.escape(c)).join('.');
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' ');
  }

  window.__probexStartCapture = function () {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = '__probex-capture-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
      zIndex: '2147483647', cursor: 'crosshair', background: 'rgba(0,0,0,0.15)',
    });

    const highlight = document.createElement('div');
    highlight.id = '__probex-capture-highlight';
    Object.assign(highlight.style, {
      position: 'fixed', border: '2px solid #3b82f6', borderRadius: '4px',
      background: 'rgba(59,130,246,0.15)', pointerEvents: 'none', zIndex: '2147483647',
      display: 'none', transition: 'all 0.1s',
    });

    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: '#1e293b', color: '#e2e8f0', padding: '8px 16px', borderRadius: '8px',
      fontSize: '13px', zIndex: '2147483647', fontFamily: 'system-ui',
    });
    label.textContent = 'Click on the target button to capture it. Press Esc to cancel.';

    document.body.appendChild(overlay);
    document.body.appendChild(highlight);
    document.body.appendChild(label);

    let lastTarget = null;

    function onMove(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay || el === highlight || el === label) {
        highlight.style.display = 'none';
        lastTarget = null;
        return;
      }
      lastTarget = el;
      const rect = el.getBoundingClientRect();
      Object.assign(highlight.style, {
        display: 'block', top: rect.top + 'px', left: rect.left + 'px',
        width: rect.width + 'px', height: rect.height + 'px',
      });
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      // Temporarily hide overlay to get the real element underneath
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = '';
      cleanup();
      if (el) {
        const selector = generateSelector(el);
        console.log('[ProbeX] Captured element:', selector, el);
        // Report back via postMessage
        window.postMessage({ type: 'probex-capture-result', selector }, '*');
      }
    }

    function onKeydown(e) {
      if (e.key === 'Escape') { cleanup(); }
    }

    function cleanup() {
      overlay.remove();
      highlight.remove();
      label.remove();
      document.removeEventListener('keydown', onKeydown, true);
    }

    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeydown, true);
  };

  // ====== Guidex Interaction Probe: Timing Metrics ======

  let interactionProbeRegistered = false;
  const INTERACTION_PROBE_NAME = 'guidex-interaction';

  async function registerInteractionProbe() {
    try {
      const result = await probexFetch(`${hubUrl}/api/v1/probes/register`, {
        method: 'POST',
        body: JSON.stringify({
          name: INTERACTION_PROBE_NAME,
          description: 'Guidex auto-test: end-to-end voice interaction timing metrics',
          output_schema: {
            standard_fields: ['latency_ms'],
            extra_fields: [
              { name: 'success', type: 'boolean', description: 'Whether ASR recognized speech', chartable: false },
              { name: 'asr_text', type: 'string', description: 'Recognized text from ASR' },
              { name: 'audio_duration_ms', type: 'number', unit: 'ms', description: 'Duration of injected test audio', chartable: true },
              { name: 'click_to_vd_ready_ms', type: 'number', unit: 'ms', description: 'Button click → voiceDictation WS init', chartable: true },
              { name: 'audio_start_to_first_asr_ms', type: 'number', unit: 'ms', description: 'Audio send start → first word recognized', chartable: true },
              { name: 'audio_end_to_final_asr_ms', type: 'number', unit: 'ms', description: 'Audio send end → final ASR result', chartable: true },
              { name: 'audio_end_to_tts_ms', type: 'number', unit: 'ms', description: 'User done speaking → first TTS synthesis event', chartable: true },
              { name: 'tts_to_avatar_speak_ms', type: 'number', unit: 'ms', description: 'TTS synthesis → avatar starts speaking', chartable: true },
              { name: 'avatar_speak_duration_ms', type: 'number', unit: 'ms', description: 'Avatar speaking duration (all segments)', chartable: true },
              { name: 'tts_total_duration_ms', type: 'number', unit: 'ms', description: 'Total TTS audio duration (sum of segments)', chartable: true },
              { name: 'lip_move_ms', type: 'number', unit: 'ms', description: 'Total mouth-moving time (sum of vmr_status 1→2)', chartable: true },
              { name: 'lip_sync_diff_ms', type: 'number', unit: 'ms', description: 'TTS audio duration minus lip-move time (>0 = mouth moves less than audio)', chartable: true },
              { name: 'audio_end_to_playback_ms', type: 'number', unit: 'ms', description: 'User done speaking → client hears reply audio', chartable: true },
              { name: 'actual_audio_duration_ms', type: 'number', unit: 'ms', description: 'Actual client-side audio playback duration', chartable: true },
              { name: 'vmr_to_actual_audio_ms', type: 'number', unit: 'ms', description: 'vmr_status=1 → client hears audio (server-client delay)', chartable: true },
              { name: 'total_interaction_ms', type: 'number', unit: 'ms', description: 'Button click → avatar finishes speaking', chartable: true },
              { name: 'cycle', type: 'number', description: 'Auto-test cycle number' },
              { name: 'page_url', type: 'string', description: 'Source page URL' },
            ],
          },
        }),
      });
      interactionProbeRegistered = result.ok || result.status === 409;
    } catch (e) { interactionProbeRegistered = false; }
  }

  async function pushInteractionResult(metrics) {
    if (!interactionProbeRegistered) {
      await registerInteractionProbe();
      if (!interactionProbeRegistered) return;
    }
    try {
      await probexFetch(`${hubUrl}/api/v1/probes/${encodeURIComponent(INTERACTION_PROBE_NAME)}/push`, {
        method: 'POST',
        body: JSON.stringify({
          task_id: 'ext_' + INTERACTION_PROBE_NAME,
          agent_id: agentId,
          results: [{
            timestamp: new Date().toISOString(),
            success: metrics.success,
            latency_ms: metrics.totalInteractionMs || null,
            extra: metrics,
          }],
        }),
      });
      console.log('[ProbeX] Interaction probe: ' + (metrics.success ? 'OK' : 'FAIL') +
        ' total=' + (metrics.total_interaction_ms || '-') + 'ms' +
        ' firstASR=' + (metrics.audio_start_to_first_asr_ms || '-') + 'ms' +
        ' speakToTts=' + (metrics.audio_end_to_tts_ms || '-') + 'ms' +
        ' avatarSpeak=' + (metrics.avatar_speak_duration_ms || '-') + 'ms' +
        ' lipMove=' + (metrics.lip_move_ms || '-') + 'ms' +
        ' endToPlay=' + (metrics.audio_end_to_playback_ms || '-') + 'ms' +
        ' playDur=' + (metrics.actual_audio_duration_ms || '-') + 'ms' +
        ' vmrToPlay=' + (metrics.vmr_to_actual_audio_ms != null ? metrics.vmr_to_actual_audio_ms : '-') + 'ms');
    } catch (e) {}
  }

  // ====== Auto-Test: Loop ======

  let autoTestTimer = null;
  let autoTestRunning = false;
  let autoTestSelector = '';
  let autoTestInterval = 30000;
  let autoTestCycleCount = 0;

  async function autoTestCycle() {
    if (!autoTestRunning) return;

    const btn = document.querySelector(autoTestSelector);
    if (!btn) return; // silently skip on wrong page
    if (!audioBuffer) {
      console.warn('[ProbeX] Auto-test: no audio loaded');
      return;
    }

    autoTestCycleCount++;
    const cycleNum = autoTestCycleCount;

    // ---- Timing: t_click ----
    const tClick = performance.now();

    // Reset voiceDictation tracking for this cycle
    vdSendCount = 0;
    const prevVdWs = voiceDictationWs;

    // ASR tracking state for this cycle
    let firstAsrText = null;
    let firstAsrTime = 0;
    let finalAsrText = '';
    let finalAsrTime = 0;
    let ttsStartTime = 0;       // first tts_duration event after ASR
    let avatarSpeakStart = 0;   // first vmr_status=1 (avatar mouth starts moving)
    let avatarSpeakEnd = 0;     // last vmr_status=2 (avatar finished all segments)
    let ttsTotalDuration = 0;   // sum of all tts_duration values in this cycle
    let lipMoveMs = 0;          // total time mouth is moving (sum of vmr_status 1→2 segments)
    let lastLipStart = 0;       // timestamp of most recent vmr_status=1
    let ttsSegmentCount = 0;    // number of tts_duration events received
    let lipSegmentCount = 0;    // number of vmr_status=2 events (completed lip segments)
    let actualAudioStart = 0;   // client-side: first moment audio energy detected
    let actualAudioEnd = 0;     // client-side: last moment audio energy dropped to silence
    let audioEnergyMonitor = null; // cleanup handle for energy detection
    let asrListener = null;
    let interactListener = null;

    // ---- Client-side audio playback detection via AnalyserNode ----
    // Taps into the WebRTC audio receiver track to detect when sound actually plays.
    function setupAudioEnergyDetector() {
      // Find the audio receiver track from active PeerConnections
      let audioTrack = null;
      for (const [, entry] of connections) {
        const pc = entry.pc;
        if (!pc.getReceivers) continue;
        for (const recv of pc.getReceivers()) {
          if (recv.track?.kind === 'audio' && recv.track.readyState === 'live') {
            audioTrack = recv.track;
            break;
          }
        }
        if (audioTrack) break;
      }
      if (!audioTrack) { console.warn('[ProbeX] No live audio receiver track for energy detection'); return; }

      console.log('[ProbeX] Audio energy detector: attached to track id=' + audioTrack.id + ' readyState=' + audioTrack.readyState);

      try {
        const detectCtx = new AudioContext();
        const source = detectCtx.createMediaStreamSource(new MediaStream([audioTrack]));
        const analyser = detectCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const SILENCE_THRESHOLD = 10; // RMS energy threshold (0-255 scale)
        let wasPlaying = false;
        let peakRms = 0;

        const pollInterval = setInterval(() => {
          analyser.getByteFrequencyData(dataArray);
          // Calculate RMS energy
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i] * dataArray[i];
          const rms = Math.sqrt(sum / dataArray.length);
          if (rms > peakRms) peakRms = rms;

          const isPlaying = rms > SILENCE_THRESHOLD;
          if (isPlaying && !wasPlaying) {
            // Silence → Sound transition
            if (!actualAudioStart && finalAsrTime) { // only after ASR (ignore pre-existing audio)
              actualAudioStart = performance.now();
              console.log('[ProbeX] Audio energy: SOUND detected (rms=' + rms.toFixed(1) + ' peak=' + peakRms.toFixed(1) + ')');
            }
            wasPlaying = true;
          } else if (!isPlaying && wasPlaying) {
            // Sound → Silence transition
            actualAudioEnd = performance.now();
            console.log('[ProbeX] Audio energy: SILENCE (rms=' + rms.toFixed(1) + ' peak=' + peakRms.toFixed(1) + ')');
            wasPlaying = false;
          }
        }, 50); // 50ms polling = 20Hz, very lightweight

        audioEnergyMonitor = () => {
          clearInterval(pollInterval);
          source.disconnect();
          detectCtx.close().catch(() => {});
        };
      } catch (e) {
        console.debug('[ProbeX] Audio energy detector setup failed:', e.message);
      }
    }

    // Listen for ASR responses on the voiceDictation WS
    function setupAsrListener(ws) {
      asrListener = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.code !== 0 || !msg.data?.result) return;
          const result = msg.data.result;
          // Extract recognized words
          const words = (result.ws || []).flatMap(w => (w.cw || []).map(c => c.w)).join('').trim();

          if (words && !firstAsrTime) {
            firstAsrTime = performance.now();
            firstAsrText = words;
          }
          if (result.ls === true && msg.data.status === 2) {
            finalAsrTime = performance.now();
            finalAsrText = words || firstAsrText || '';
          }
        } catch (e) {}
      };
      ws.addEventListener('message', asrListener);
    }

    // Listen for TTS/avatar response on the interact WS
    // iFlytek interact protocol: event_type "tts_duration" signals TTS start,
    // event_type "driver_status" with vmr_status=1 signals avatar starts speaking
    function setupTtsListener() {
      const interactWs = window.__probexWsList.find(ws =>
        ws.url?.includes('/v1/interact') && ws.readyState === WebSocket.OPEN
      );
      if (!interactWs) return;
      interactListener = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const msg = JSON.parse(ev.data);
          const avatar = msg.payload?.avatar;
          if (!avatar || !finalAsrTime) return; // only track events after ASR ends

          if (avatar.event_type === 'tts_duration') {
            if (!ttsStartTime) ttsStartTime = performance.now();
            ttsTotalDuration += (avatar.tts_duration || 0);
            ttsSegmentCount++;
          }
          if (avatar.event_type === 'driver_status') {
            if (avatar.vmr_status === 1) {
              if (!avatarSpeakStart) avatarSpeakStart = performance.now();
              // Only set lastLipStart on the FIRST vmr=1 of each segment.
              // vmr=1 can fire multiple times within a segment (progress updates).
              if (!lastLipStart) lastLipStart = performance.now();
            }
            if (avatar.vmr_status === 2) {
              avatarSpeakEnd = performance.now();
              lipSegmentCount++;
              if (lastLipStart) { lipMoveMs += (avatarSpeakEnd - lastLipStart); lastLipStart = 0; }
            }
          }
        } catch (e) {}
      };
      interactWs.addEventListener('message', interactListener);
    }

    console.log('[ProbeX] Auto-test cycle #' + cycleNum + ': clicking button');

    // Click to start conversation
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // Wait for voiceDictation WS ready
    const vdReady = await new Promise((resolve) => {
      let checks = 0;
      const check = setInterval(() => {
        checks++;
        if (voiceDictationWs && voiceDictationWs !== prevVdWs && vdSendCount >= 1) {
          clearInterval(check);
          resolve(true);
        }
        if (checks > 50) { clearInterval(check); resolve(false); }
      }, 100);
    });

    // ---- Timing: t_vd_ready ----
    const tVdReady = performance.now();

    if (!vdReady) {
      console.warn('[ProbeX] Auto-test cycle #' + cycleNum + ': VD not ready, skipping');
      await pushInteractionResult({
        success: false, cycle: cycleNum, page_url: location.href,
        audio_duration_ms: Math.round(audioBuffer.duration * 1000),
        click_to_vd_ready_ms: null,
      });
      return;
    }

    // Setup listeners before sending audio
    setupAsrListener(voiceDictationWs);
    setupTtsListener();
    setupAudioEnergyDetector();

    await new Promise(r => setTimeout(r, 800));

    // ---- Timing: t_audio_start ----
    const tAudioStart = performance.now();
    console.log('[ProbeX] Auto-test cycle #' + cycleNum + ': VD ready, playing audio');

    await playTestAudio();

    // ---- Timing: t_audio_end ----
    const tAudioEnd = performance.now();

    await new Promise(r => setTimeout(r, 300));
    sendVoiceDictationEnd();

    // Wait for avatar to finish ALL TTS segments or timeout.
    // Done condition: lipSegmentCount >= ttsSegmentCount (each TTS segment has a matching vmr_status:2)
    await new Promise((resolve) => {
      let checks = 0;
      const check = setInterval(() => {
        checks++;
        const elapsed = checks * 100;
        // Phase 1: no ASR after 15s → give up
        if (!finalAsrTime && elapsed > 15000) { clearInterval(check); resolve(); return; }
        // Phase 2: ASR done but no TTS after 10s → give up on TTS
        if (finalAsrTime && !ttsStartTime && elapsed > 25000) { clearInterval(check); resolve(); return; }
        // Phase 3: all TTS segments have completed (vmr_status:2 count matches tts_duration count)
        if (ttsSegmentCount > 0 && lipSegmentCount >= ttsSegmentCount) {
          clearInterval(check); resolve(); return;
        }
        // Hard timeout: 60 seconds total (long TTS can be 10-15s per segment)
        if (elapsed > 60000) { clearInterval(check); resolve(); return; }
      }, 100);
    });

    // ---- Collect metrics ----
    const asrSuccess = !!firstAsrText;
    const metrics = {
      success: asrSuccess,
      asr_text: finalAsrText || firstAsrText || '',
      cycle: cycleNum,
      page_url: location.href,
      audio_duration_ms: Math.round(audioBuffer.duration * 1000),
      click_to_vd_ready_ms: Math.round(tVdReady - tClick),
      audio_start_to_first_asr_ms: firstAsrTime ? Math.round(firstAsrTime - tAudioStart) : null,
      audio_end_to_final_asr_ms: finalAsrTime ? Math.round(finalAsrTime - tAudioEnd) : null,
      audio_end_to_tts_ms: ttsStartTime ? Math.round(ttsStartTime - tAudioEnd) : null,
      tts_to_avatar_speak_ms: (ttsStartTime && avatarSpeakStart) ? Math.round(avatarSpeakStart - ttsStartTime) : null,
      avatar_speak_duration_ms: (avatarSpeakStart && avatarSpeakEnd) ? Math.round(avatarSpeakEnd - avatarSpeakStart) : null,
      tts_total_duration_ms: ttsTotalDuration || null,
      lip_move_ms: lipMoveMs ? Math.round(lipMoveMs) : null,
      lip_sync_diff_ms: (ttsTotalDuration && lipMoveMs) ? Math.round(ttsTotalDuration - lipMoveMs) : null,
      audio_end_to_playback_ms: (actualAudioStart && tAudioEnd) ? Math.round(actualAudioStart - tAudioEnd) : null,
      actual_audio_duration_ms: (actualAudioStart && actualAudioEnd) ? Math.round(actualAudioEnd - actualAudioStart) : null,
      vmr_to_actual_audio_ms: (avatarSpeakStart && actualAudioStart) ? Math.round(actualAudioStart - avatarSpeakStart) : null,
      total_interaction_ms: actualAudioEnd ? Math.round(actualAudioEnd - tClick)
        : avatarSpeakEnd ? Math.round(avatarSpeakEnd - tClick)
        : ttsStartTime ? Math.round(ttsStartTime - tClick)
        : finalAsrTime ? Math.round(finalAsrTime - tClick)
        : null,
    };

    // Cleanup listeners and audio detector
    if (asrListener && voiceDictationWs) voiceDictationWs.removeEventListener('message', asrListener);
    if (interactListener) {
      const iws = window.__probexWsList.find(ws => ws.url?.includes('/v1/interact'));
      if (iws) iws.removeEventListener('message', interactListener);
    }
    if (audioEnergyMonitor) audioEnergyMonitor();

    // Push to ProbeX
    await pushInteractionResult(metrics);

    console.log('[ProbeX] Auto-test cycle #' + cycleNum + ': complete (' +
      (asrSuccess ? 'ASR="' + finalAsrText + '"' : 'no ASR') +
      ' total=' + (metrics.total_interaction_ms || '?') + 'ms)');
  }

  async function startAutoTest(selector, interval) {
    autoTestSelector = selector;
    autoTestInterval = (interval || 30) * 1000;
    autoTestRunning = true;

    // Wait for audio to finish loading if it's still being decoded
    if (audioLoadPromise) await audioLoadPromise;
    autoTestCycleCount = 0;

    console.log('[ProbeX] Auto-test started: selector=' + selector + ' interval=' + (autoTestInterval / 1000) + 's hasAudio=' + !!audioBuffer);

    // Run cycles sequentially: wait for each cycle to complete, then wait interval
    (async function loop() {
      while (autoTestRunning) {
        await autoTestCycle();
        if (!autoTestRunning) break;
        // Wait interval AFTER cycle completes (not overlapping)
        await new Promise(r => { autoTestTimer = setTimeout(r, autoTestInterval); });
      }
    })();
  }

  function stopAutoTest() {
    autoTestRunning = false;
    if (autoTestTimer) { clearTimeout(autoTestTimer); autoTestTimer = null; }
    if (currentSource) { try { currentSource.stop(); } catch (e) {} }
    if (micGainNode) micGainNode.gain.value = 1;
    if (injectGainNode) injectGainNode.gain.value = 0;
    console.log('[ProbeX] Auto-test stopped after ' + autoTestCycleCount + ' cycles');
  }

  // ====== Timers ======

  let flushTimer = null;

  function startCollectLoop() {
    if (collectTimer) clearInterval(collectTimer);
    if (flushTimer) clearInterval(flushTimer);
    // Sub-sample every 500ms for fine-grained sync data
    collectTimer = setInterval(collectSubSample, SUBSAMPLE_INTERVAL);
    // Flush aggregated result every 2s (report interval)
    flushTimer = setInterval(flushSubSamples, REPORT_INTERVAL);
  }

  function startPushLoop() {
    if (pushTimer) clearInterval(pushTimer);
    pushTimer = setInterval(pushResults, pushInterval);
  }

  function stopAll() {
    stopped = true;
    if (collectTimer) { clearInterval(collectTimer); collectTimer = null; }
    if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
    if (pushTimer) { clearInterval(pushTimer); pushTimer = null; }
  }

  // ====== Diagnostic (call window.__probexDiag() in console during active call) ======

  window.__probexDiag = () => {
    console.log('=== ProbeX Diagnostic ===');
    console.log('Connections tracked:', connections.size);
    for (const [id, entry] of connections) {
      const pc = entry.pc;
      console.log('--- PC #' + id + ' state=' + pc.connectionState + ' ice=' + pc.iceConnectionState + ' ---');
      if (pc.getSenders) {
        const senders = pc.getSenders();
        console.log('  Senders (' + senders.length + '):');
        senders.forEach((s, i) => {
          console.log('    [' + i + '] kind=' + (s.track?.kind || 'null') + ' id=' + (s.track?.id || 'null') + ' enabled=' + s.track?.enabled + ' readyState=' + s.track?.readyState);
        });
      } else {
        console.log('  getSenders() not available');
      }
      if (pc.getReceivers) {
        const receivers = pc.getReceivers();
        console.log('  Receivers (' + receivers.length + '):');
        receivers.forEach((r, i) => {
          console.log('    [' + i + '] kind=' + (r.track?.kind || 'null') + ' id=' + (r.track?.id || 'null'));
        });
      }
      if (pc.getTransceivers) {
        const transceivers = pc.getTransceivers();
        console.log('  Transceivers (' + transceivers.length + '):');
        transceivers.forEach((t, i) => {
          console.log('    [' + i + '] mid=' + t.mid + ' direction=' + t.direction + ' currentDir=' + t.currentDirection + ' sender.track=' + (t.sender.track?.kind || 'null') + ' receiver.track=' + (t.receiver.track?.kind || 'null'));
        });
      }
    }
    console.log('audioBuffer:', audioBuffer ? (audioBuffer.duration.toFixed(1) + 's') : 'null');

    // Check for iframes
    const iframes = document.querySelectorAll('iframe');
    console.log('Iframes on page:', iframes.length);
    iframes.forEach((f, i) => {
      console.log('  [' + i + '] src=' + (f.src || '(empty)') + ' name=' + (f.name || ''));
    });

    // Check for active WebSocket connections (hook was applied at startup)
    console.log('Active WebSockets tracked:', (window.__probexWsList || []).length);
    (window.__probexWsList || []).forEach((ws, i) => {
      console.log('  [' + i + '] url=' + ws.url + ' state=' + ws.readyState);
    });

    console.log('=== End Diagnostic ===');
  };

  // ====== API for popup (called via chrome.scripting.executeScript with world: MAIN) ======

  window.__probexStats = () => ({
    connections: connections.size,
    pushOk,
    pushFail,
    lastPushAt,
    latest: latestMetrics,
    bufferSize: resultBuffer.length,
    stopped,
    autoTest: {
      running: autoTestRunning,
      selector: autoTestSelector,
      cycles: autoTestCycleCount,
      hasAudio: !!audioBuffer,
      audioDuration: audioBuffer?.duration || 0,
    },
  });

  // ====== Resume (called when extension re-injects content-script) ======

  window.__probexResume = () => {
    stopped = false;
    startCollectLoop();
    startPushLoop();
  };

  // ====== Start ======

  console.log('[ProbeX] injected.js started, hubUrl=%s, collectInterval=%d, pushInterval=%d', hubUrl, collectInterval, pushInterval);
  startCollectLoop();
  startPushLoop();
})();
