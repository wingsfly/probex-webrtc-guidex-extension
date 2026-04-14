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
    const realStream = await origProtoGUM.call(this, constraints);
    if (!constraints?.audio) return realStream;

    ensureAudioCtx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    try {
      const micSource = audioCtx.createMediaStreamSource(realStream);
      micSource.connect(micGainNode);
    } catch (e) {
      console.warn('[ProbeX] mic source connect error:', e.message);
      return realStream;
    }

    const proxy = new MediaStream();
    realStream.getVideoTracks().forEach(t => proxy.addTrack(t));
    streamDest.stream.getAudioTracks().forEach(t => proxy.addTrack(t));

    console.log('[ProbeX] getUserMedia intercepted: proxy stream returned');
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
        console.warn('[ProbeX] getUserMedia prototype hook overwritten! Re-applying...');
        MediaDevices.prototype.getUserMedia = hookedGetUserMedia;
      }
      if (navigator.mediaDevices &&
          Object.prototype.hasOwnProperty.call(navigator.mediaDevices, 'getUserMedia') &&
          navigator.mediaDevices.getUserMedia !== hookedGetUserMedia) {
        console.warn('[ProbeX] getUserMedia instance-level override detected! Re-applying...');
        navigator.mediaDevices.getUserMedia = hookedGetUserMedia;
      }
      // Also protect WebSocket.prototype.send hook
      if (WebSocket.prototype.send !== hookedWsSend) {
        console.warn('[ProbeX] WebSocket.prototype.send hook overwritten! Re-applying...');
        WebSocket.prototype.send = hookedWsSend;
      }
    } catch (e) {}
  }, 200);
  setTimeout(() => clearInterval(hookCheckInterval), 30000);

  /** Play test audio into the hooked stream. Returns promise resolving when playback ends. */
  function playTestAudio() {
    return new Promise(async (resolve) => {
      if (!audioBuffer) { console.warn('[ProbeX] No audio buffer loaded'); resolve(); return; }

      ensureAudioCtx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // Mute real mic, enable injection path
      micGainNode.gain.value = 0;
      injectGainNode.gain.value = 1;

      if (currentSource) { try { currentSource.stop(); } catch (e) {} }

      currentSource = audioCtx.createBufferSource();
      currentSource.buffer = audioBuffer;
      currentSource.connect(injectGainNode);
      currentSource.onended = () => {
        // Restore: mic on, injection off
        micGainNode.gain.value = 1;
        injectGainNode.gain.value = 0;
        currentSource = null;
        console.log('[ProbeX] Test audio ended, mic restored');
        resolve();
      };
      currentSource.start();
      console.log('[ProbeX] Playing test audio (' + audioBuffer.duration.toFixed(1) + 's) via getUserMedia proxy');
    });
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

  // ====== Stats Collection ======

  async function collectAllStats() {
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
          resultBuffer.push({
            timestamp: new Date().toISOString(),
            pageUrl: location.href,
            connectionCount: connections.size,
            metrics,
          });
        }
        entry.prevStats = statsToMap(stats);
      } catch (e) { /* PC may have been closed */ }
    }

    // Bound buffer
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
    if (proxyResult) {
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
              { name: 'page_url', type: 'string', description: 'Source page URL' },
              { name: 'connection_count', type: 'number', description: 'Active PeerConnection count' },
            ],
          },
        }),
      });
      registered = result.ok || result.status === 409;
    } catch (e) { registered = false; }
  }

  async function pushResults() {
    if (!enabled || resultBuffer.length === 0) return;
    console.log('[ProbeX] push: buffer=%d conns=%d', resultBuffer.length, connections.size);
    if (!registered) { await registerProbe(); if (!registered) { console.warn('[ProbeX] registration failed'); return; } }

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
        const resp = await fetch(dataUrl);
        const arrayBuf = await resp.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuf);
        console.log('[ProbeX] Audio loaded: ' + audioBuffer.duration.toFixed(1) + 's, ' + audioBuffer.numberOfChannels + ' ch, ' + audioBuffer.sampleRate + ' Hz');
      } catch (e) {
        console.error('[ProbeX] Failed to decode audio:', e.message);
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

  // ====== Auto-Test: Loop ======

  let autoTestTimer = null;
  let autoTestRunning = false;
  let autoTestSelector = '';
  let autoTestInterval = 30000;
  let autoTestCycleCount = 0;

  async function autoTestCycle() {
    if (!autoTestRunning) return;

    const btn = document.querySelector(autoTestSelector);
    if (!btn) {
      console.warn('[ProbeX] Auto-test: button not found with selector:', autoTestSelector);
      return;
    }
    if (!audioBuffer) {
      console.warn('[ProbeX] Auto-test: no audio loaded');
      return;
    }

    autoTestCycleCount++;
    console.log('[ProbeX] Auto-test cycle #' + autoTestCycleCount + ': clicking button');

    // Click to start conversation
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    // Short delay for the app to start capturing audio
    await new Promise(r => setTimeout(r, 500));

    // Play audio into the hooked MediaStream
    await playTestAudio();

    // Extra silence delay for VAD to detect end-of-speech
    console.log('[ProbeX] Auto-test cycle #' + autoTestCycleCount + ': audio done, waiting for VAD');
  }

  async function startAutoTest(selector, interval) {
    autoTestSelector = selector;
    autoTestInterval = (interval || 30) * 1000;
    autoTestRunning = true;

    // Wait for audio to finish loading if it's still being decoded
    if (audioLoadPromise) await audioLoadPromise;
    autoTestCycleCount = 0;

    console.log('[ProbeX] Auto-test started: selector=' + selector + ' interval=' + (autoTestInterval / 1000) + 's hasAudio=' + !!audioBuffer);

    // Run first cycle immediately
    autoTestCycle();

    // Schedule subsequent cycles
    if (autoTestTimer) clearInterval(autoTestTimer);
    autoTestTimer = setInterval(autoTestCycle, autoTestInterval);
  }

  function stopAutoTest() {
    autoTestRunning = false;
    if (autoTestTimer) { clearInterval(autoTestTimer); autoTestTimer = null; }
    if (currentSource) { try { currentSource.stop(); } catch (e) {} }
    // Restore mic
    if (micGainNode) micGainNode.gain.value = 1;
    if (injectGainNode) injectGainNode.gain.value = 0;
    console.log('[ProbeX] Auto-test stopped after ' + autoTestCycleCount + ' cycles');
  }

  // ====== Timers ======

  function startCollectLoop() {
    if (collectTimer) clearInterval(collectTimer);
    collectTimer = setInterval(collectAllStats, collectInterval);
  }

  function startPushLoop() {
    if (pushTimer) clearInterval(pushTimer);
    pushTimer = setInterval(pushResults, pushInterval);
  }

  function stopAll() {
    stopped = true;
    if (collectTimer) { clearInterval(collectTimer); collectTimer = null; }
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
