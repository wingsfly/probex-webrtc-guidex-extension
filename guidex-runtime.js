// GuideX Runtime v4 wire observer. Keeps only timing/counts, never audio, text or RTC credentials.
// Loaded before injected.js in MAIN world; the CommonJS export supports offline protocol replay.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProbeXGuideXRuntime = api;
})(globalThis, function () {
  'use strict';

  const PROBE_NAME = 'guidex-runtime-v4';
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const id = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
  const elapsed = (end, start) => end == null || start == null ? null : Math.round(end - start);
  const channels = {
    'instance.open': 'control', 'instance.ready': 'control', 'instance.closed': 'control',
    'session.start': 'control', 'session.started': 'control', 'session.ending': 'control',
    'session.ended': 'control', 'conversation.user.append': 'data',
    'event.user_speech_started': 'data', 'event.user_speech_stopped': 'control',
    'stt.result': 'data', 'event.stt_revocation': 'data', 'nlu.answer': 'data',
    'nlu.postprocess': 'data', 'event.cid_end': 'data', 'event.interrupt': 'control',
    'event.interrupted': 'control', 'avatar.speak.started': 'control',
    'avatar.speak.ended': 'control', 'guidance.trigger': 'control',
    'guidance.accepted': 'control', 'guidance.completed': 'control', 'error': 'control',
  };
  const outbound = new Set(['instance.open', 'session.start', 'conversation.user.append',
    'event.interrupt', 'guidance.trigger']);

  function connectionInfo(address) {
    try {
      const url = new URL(address);
      if (!['ws:', 'wss:'].includes(url.protocol)) return null;
      const chat = url.pathname.match(/^(?:\/[A-Za-z0-9_-]+)*\/chat\/api\/chat\/aichain\/([^/]+)$/);
      if (chat) {
        const instanceId = decodeURIComponent(chat[1]);
        return id(instanceId) ? { profile: 'guidex-chat-v1', instanceId } : null;
      }
      if (url.pathname === '/api/runtime/v1/ws') return { profile: 'runtime-v1-draft' };
    } catch (_) { /* Unrelated sockets do not belong to this observer. */ }
    return null;
  }

  function decode(raw, direction, profile) {
    if (typeof raw !== 'string' || raw.length > 2 * 1024 * 1024) return null;
    let message;
    try { message = JSON.parse(raw); } catch (_) { return null; }
    const h = message?.header;
    if (!object(h) || h.version !== '1.0' || !object(h.context) || !id(h.context.instanceId) ||
        !Number.isSafeInteger(h.sendAt) || h.sendAt < 0 || h.sentAt !== undefined ||
        h.context.onlineId !== undefined || !object(message.payload)) return null;
    const event = h.event;
    const isError = typeof event === 'string' && event.endsWith('.error');
    if (!Object.hasOwn(channels, event) && !isError) return null;
    if (h.channel !== (isError ? 'control' : channels[event])) return null;
    if (direction === 'send' ? !outbound.has(event) : outbound.has(event)) return null;
    const c = h.context;
    if ([c.sid, c.cid].some(v => v != null && !id(v))) return null;
    if (c.interactionScope !== undefined && c.interactionScope !== 'session') return null;
    const p = direction === 'receive' && profile === 'guidex-chat-v1' ? message.payload.data : message.payload;
    if (!object(p)) return null;
    const base = { event, instanceId: c.instanceId, sid: c.sid ?? null, cid: c.cid ?? null };
    // Pick approved scalar fields only. Never retain the parsed envelope or arbitrary payload data.
    switch (event) {
      case 'conversation.user.append': {
        const audio = Array.isArray(p.items) ? p.items.filter(item =>
          object(item) && item.type === 'audio' && typeof item.data === 'string' &&
          item.data.length > 0 && item.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) : [];
        if (audio.length) return { ...base, input: 'audio', bytes: audio.reduce((sum, item) =>
          sum + item.data.length * 3 / 4 - (item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0), 0) };
        if (p.input?.type === 'text' && typeof p.input.text === 'string' && p.input.text.trim())
          return { ...base, input: 'text' };
        return null;
      }
      case 'session.started': return p.ready === true && base.sid ? base : null;
      case 'stt.result': return typeof p.text === 'string' && typeof p.isFinal === 'boolean'
        ? { ...base, textLength: p.text.trim().length, final: p.isFinal } : null;
      case 'event.stt_revocation': return typeof p.text === 'string'
        ? { ...base, textLength: p.text.trim().length } : null;
      case 'nlu.answer': return ['append', 'replace'].includes(p.operation) && typeof p.text === 'string' &&
        id(p.format) && (p.final === undefined || typeof p.final === 'boolean')
        ? { ...base, textLength: p.text.length, operation: p.operation, final: p.final === true } : null;
      case 'nlu.postprocess': return p.status === 'completed' && typeof p.finalText === 'string' && id(p.format)
        ? { ...base, textLength: p.finalText.length } : null;
      case 'event.interrupted': {
        const stages = p.stages === undefined && profile === 'guidex-chat-v1' ? ['nlu', 'tts', 'avatar'] : p.stages;
        return Array.isArray(stages) && stages.every(s => ['input', 'nlu', 'tts', 'avatar'].includes(s))
          ? { ...base, stages } : null;
      }
      case 'guidance.trigger':
      case 'guidance.accepted':
      case 'guidance.completed': return ['welcome', 'invitation', 'farewell'].includes(p.kind) ? base : null;
      default:
        if (event === 'error' || isError) return { ...base, event: 'error',
          scope: ['instance', 'session', 'conversation', 'audio_input', 'nlu', 'tts', 'avatar', 'guidance'].includes(p.scope) ? p.scope : null,
          code: typeof p.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(p.code) ? p.code : null };
        return base;
    }
  }

  const timingFields = {
    ws_connect_ms: 'Socket creation to open; not a per-turn voiceDictation handshake',
    instance_register_ms: 'instance.open sent to instance.ready received; registration only',
    session_start_ms: 'session.start sent to session.started(ready=true); session may be reused',
    audio_upload_window_ms: 'Last audio append minus first audio append; includes uploaded silence',
    audio_start_to_first_asr_ms: 'First audio append to first nonempty stt.result',
    audio_start_to_speech_started_ms: 'First audio append to server speech-start notification',
    speech_stop_to_final_asr_ms: 'Server speech-stop notification to final STT; signed arrival-time delta',
    speech_stop_to_first_answer_ms: 'Server speech-stop notification to first nonempty NLU answer; signed delta',
    speech_stop_to_avatar_start_ms: 'Server speech-stop notification to avatar.speak.started; not audible playback',
    final_asr_to_first_answer_ms: 'Final STT to first nonempty NLU answer; signed delta',
    first_answer_ms: 'First outbound input to first nonempty NLU answer',
    model_complete_ms: 'First outbound input to nlu.answer(final=true) or nlu.postprocess',
    answer_stream_ms: 'First nonempty NLU answer to model final',
    avatar_speak_duration_ms: 'avatar.speak.started to avatar.speak.ended, business events only',
    cid_end_ms: 'First outbound input to event.cid_end; separate statistics event',
    total_interaction_ms: 'First outbound input to all observed input/model/avatar terminal events; complete turns only',
    observed_ms: 'Observed turn window, including timeout/interruption/disconnection',
    click_to_first_audio_ms: 'Auto-test UI click to first application audio append',
    test_audio_duration_ms: 'Decoded synthetic audio duration',
    test_audio_to_avatar_start_ms: 'Synthetic audio playback ended to avatar.speak.started; signed delta',
  };
  const schema = {
    standard_fields: ['latency_ms'],
    extra_fields: [
      ...Object.entries(timingFields).map(([name, description]) => ({ name, description, type: 'number', unit: 'ms', chartable: true })),
      ...['protocol_profile', 'client_adapter', 'instance_id', 'sid', 'cid', 'input_type',
        'interaction_mode', 'completion_reason', 'error_code', 'page_url'].map(name => ({ name, type: 'string' })),
      ...['audio_bytes', 'audio_frames', 'asr_characters', 'answer_characters', 'stt_revocations', 'cycle'].map(name => ({ name, type: 'number' })),
      ...['success', 'input_ended', 'model_completed', 'avatar_ended', 'asr_final', 'asr_recognized'].map(name => ({ name, type: 'boolean' })),
    ],
  };

  function createTracker({ now = () => performance.now(), onResult = () => {}, onTurnStart = () => {},
    timeoutMs = 60000, maxTurns = 64 } = {}) {
    const sockets = new Map();
    let completed = 0, lastResult = null, enabled = true;
    const keyOf = e => JSON.stringify([e.instanceId, e.sid, e.cid]);
    const first = (t, field, at) => { if (t[field] == null) t[field] = at; };
    function finish(s, key, t, reason, at) {
      s.turns.delete(key);
      // Bounded tombstones isolate duplicate/late events without retaining historical envelopes.
      s.closed.add(key);
      if (s.closed.size > maxTurns * 4) s.closed.delete(s.closed.values().next().value);
      const metrics = {
        protocol_profile: s.profile, client_adapter: 'guidex-runtime-v4', instance_id: t.instanceId,
        sid: t.sid, cid: t.cid, input_type: t.input, interaction_mode: t.test ? 'auto-test' : 'passive',
        completion_reason: reason, success: reason === 'completed', error_code: t.errorCode ?? null,
        input_ended: t.input !== 'audio' || t.speechStop != null, model_completed: t.modelEnd != null,
        avatar_ended: t.avatarEnd != null, asr_final: t.asrEnd != null, asr_recognized: t.asrChars > 0,
        audio_bytes: t.bytes, audio_frames: t.frames, asr_characters: t.asrChars,
        answer_characters: t.answerChars, stt_revocations: t.revocations,
        ws_connect_ms: elapsed(s.openAt, s.createdAt), instance_register_ms: elapsed(s.readyAt, s.registerAt),
        session_start_ms: t.sessionMs, audio_upload_window_ms: elapsed(t.lastAudio, t.audioStart),
        audio_start_to_first_asr_ms: elapsed(t.firstAsr, t.audioStart),
        audio_start_to_speech_started_ms: elapsed(t.speechStart, t.audioStart),
        speech_stop_to_final_asr_ms: elapsed(t.asrEnd, t.speechStop),
        speech_stop_to_first_answer_ms: elapsed(t.firstAnswer, t.speechStop),
        speech_stop_to_avatar_start_ms: elapsed(t.avatarStart, t.speechStop),
        final_asr_to_first_answer_ms: elapsed(t.firstAnswer, t.asrEnd),
        first_answer_ms: elapsed(t.firstAnswer, t.start), model_complete_ms: elapsed(t.modelEnd, t.start),
        answer_stream_ms: elapsed(t.modelEnd, t.firstAnswer),
        avatar_speak_duration_ms: elapsed(t.avatarEnd, t.avatarStart), cid_end_ms: elapsed(t.cidEnd, t.start),
        total_interaction_ms: reason === 'completed' ? elapsed(at, t.start) : null,
        observed_ms: elapsed(at, t.start), cycle: t.test?.cycle ?? null,
        click_to_first_audio_ms: elapsed(t.audioStart, t.test?.clickAt),
        test_audio_duration_ms: t.test?.durationMs ?? null,
        test_audio_to_avatar_start_ms: elapsed(t.avatarStart, t.test?.audioEnd),
      };
      completed++; lastResult = metrics;
      onResult(metrics);
    }
    function flush(s, reason, at, predicate = () => true) {
      for (const [key, t] of s.turns) if (predicate(t)) finish(s, key, t, reason, at);
    }
    return {
      connect(socketId, address) {
        const info = connectionInfo(address);
        if (!info || sockets.has(socketId)) return false;
        sockets.set(socketId, { ...info, createdAt: now(), turns: new Map(), closed: new Set() });
        return true;
      },
      open(socketId) { const s = sockets.get(socketId); if (s) s.openAt = now(); },
      observe(socketId, direction, raw) {
        const s = sockets.get(socketId);
        if (!s) return;
        const e = decode(raw, direction, s.profile);
        if (!e || (s.instanceId && e.instanceId !== s.instanceId)) return;
        s.instanceId = e.instanceId;
        const at = now();
        if (e.event === 'instance.open') { s.registerAt = at; return; }
        if (e.event === 'instance.ready') { if (s.readyAt == null) s.readyAt = at; return; }
        if (e.event === 'session.start') { s.sessionRequestAt = at; return; }
        if (e.event === 'session.started') {
          if (s.sid === e.sid && s.sessionRequestAt == null) return;
          if (s.sid && s.sid !== e.sid) flush(s, 'session_replaced', at);
          s.sid = e.sid; s.sessionMs = elapsed(at, s.sessionRequestAt); s.sessionRequestAt = null;
          return;
        }
        if (e.event === 'instance.closed') { flush(s, 'instance_closed', at); s.sid = null; return; }
        if (e.event === 'session.ended') {
          flush(s, 'session_ended', at, t => t.sid === e.sid);
          if (s.sid === e.sid) s.sid = null;
          return;
        }
        if (e.event === 'error' && !e.cid) {
          if (e.scope === 'session' && e.sid) flush(s, 'error', at, t => t.sid === e.sid);
          else if (e.scope === 'instance') flush(s, 'error', at);
          return;
        }
        if (!enabled) return;
        // Never borrow a current cid/sid for incomplete notifications or RTC requestId fields.
        if (!e.sid || !e.cid || e.sid !== s.sid || s.readyAt == null) return;
        const key = keyOf(e);
        let t = s.turns.get(key);
        if (!t && direction === 'send' && ['conversation.user.append', 'guidance.trigger'].includes(e.event) && !s.closed.has(key)) {
          if (s.turns.size >= maxTurns) {
            const [oldKey, old] = s.turns.entries().next().value;
            finish(s, oldKey, old, 'capacity', at);
          }
          t = { instanceId: e.instanceId, sid: e.sid, cid: e.cid, input: e.input ?? 'guidance',
            start: at, sessionMs: s.sessionMs ?? null, bytes: 0, frames: 0, asrChars: 0,
            answerChars: 0, revocations: 0 };
          s.turns.set(key, t);
          onTurnStart({ socketId, instanceId: t.instanceId, sid: t.sid, cid: t.cid, input: t.input });
        }
        if (!t) return;
        switch (e.event) {
          case 'conversation.user.append':
            if (e.input === 'audio') {
              first(t, 'audioStart', at); t.lastAudio = at; t.bytes += e.bytes; t.frames++;
            }
            break;
          case 'event.user_speech_started': first(t, 'speechStart', at); break;
          case 'event.user_speech_stopped': first(t, 'speechStop', at); break;
          case 'stt.result':
            t.asrChars = e.textLength;
            if (e.textLength) first(t, 'firstAsr', at);
            if (e.final) first(t, 'asrEnd', at);
            break;
          case 'event.stt_revocation': t.asrChars = e.textLength; t.asrEnd = null; t.revocations++; break;
          case 'nlu.answer':
            if (t.modelEnd != null) break;
            t.answerChars = e.operation === 'replace' ? e.textLength : t.answerChars + e.textLength;
            if (e.textLength) first(t, 'firstAnswer', at);
            if (e.final) first(t, 'modelEnd', at);
            break;
          case 'nlu.postprocess':
            if (t.modelEnd == null) { t.answerChars = e.textLength; first(t, 'modelEnd', at); }
            break;
          case 'avatar.speak.started': first(t, 'avatarStart', at); break;
          case 'avatar.speak.ended': first(t, 'avatarEnd', at); break;
          case 'event.cid_end': first(t, 'cidEnd', at); break;
          case 'event.interrupted':
            if (e.stages.length) { finish(s, key, t, 'interrupted', at); return; }
            break;
          case 'error':
            if (e.scope) { t.errorCode = e.code; finish(s, key, t, 'error', at); return; }
            break;
        }
        if (t.modelEnd != null && t.avatarEnd != null && (t.input !== 'audio' || t.speechStop != null))
          finish(s, key, t, 'completed', at);
      },
      annotate(socketId, context, test) {
        const t = sockets.get(socketId)?.turns.get(keyOf(context));
        if (t) t.test = { ...t.test, ...test };
      },
      sweep() { const at = now(); for (const s of sockets.values()) flush(s, 'timeout', at, t => at - t.start >= timeoutMs); },
      disconnect(socketId) {
        const s = sockets.get(socketId);
        if (s) { flush(s, 'disconnected', now()); sockets.delete(socketId); }
      },
      reset() { sockets.clear(); lastResult = null; completed = 0; },
      setEnabled(value) {
        enabled = value;
        if (!value) for (const s of sockets.values()) { s.turns.clear(); s.closed.clear(); }
      },
      snapshot() {
        return { connections: sockets.size, activeTurns: [...sockets.values()].reduce((n, s) => n + s.turns.size, 0),
          ready: [...sockets.values()].some(s => s.readyAt != null), completed, lastResult };
      },
    };
  }
  return { PROBE_NAME, schema, connectionInfo, decode, createTracker };
});
