// GuideX Runtime v4 wire observer. Keeps approved timing/counts and the latest STT
// snapshot, never audio, prompts, answers or RTC credentials.
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
    'session.start': 'control', 'session.end': 'control', 'session.started': 'control', 'session.ending': 'control',
    'event.idle_timeout': 'control',
    'session.ended': 'control', 'conversation.user.append': 'data',
    'event.user_speech_started': 'data', 'event.user_speech_stopped': 'control',
    'stt.result': 'data', 'event.stt_revocation': 'data', 'nlu.answer': 'data',
    'nlu.postprocess': 'data', 'event.cid_end': 'data', 'event.interrupt': 'control',
    'event.interrupted': 'control', 'avatar.speak.started': 'control',
    'avatar.speak.ended': 'control', 'guidance.trigger': 'control',
    'guidance.accepted': 'control', 'guidance.completed': 'control', 'error': 'control',
  };
  const outbound = new Set(['instance.open', 'session.start', 'session.end', 'conversation.user.append',
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
        if (audio.length) return { ...base, input: 'audio' };
        if (p.input?.type === 'text' && typeof p.input.text === 'string' && p.input.text.trim())
          return { ...base, input: 'text' };
        return null;
      }
      case 'session.started': return p.ready === true && base.sid ? base : null;
      case 'session.end':
      case 'session.ending':
      case 'session.ended':
        return base.sid && !base.cid ? { ...base,
          reason: typeof p.reason === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(p.reason) ? p.reason : null,
          reasonProvided: Object.hasOwn(p, 'reason'),
        } : null;
      case 'stt.result': return typeof p.text === 'string' && typeof p.isFinal === 'boolean'
        ? { ...base, text: p.text, final: p.isFinal } : null;
      case 'event.stt_revocation': return p.text === undefined || typeof p.text === 'string'
        ? { ...base } : null;
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
    last_audio_to_final_asr: 'LastAudio_To_STT: last successful audio append in this turn to final STT; signed local-time delta',
    last_audio_to_first_answer: 'LastAudio_To_Answer: last successful audio append in this turn to first nonempty NLU answer; signed delta',
    last_audio_to_avatar_start: 'LastAudio_To_Play: last successful audio append in this turn to avatar.speak.started, including auto-tests; not audible playback',
    final_asr_to_first_answer: 'STT_To_Answer: final STT to first nonempty NLU answer; signed delta',
    first_answer: 'Audio_To_Answer: first outbound input to first nonempty NLU answer; text/guidance use their first input',
    answer_stream: 'Answer_Dur: first nonempty NLU answer to model final',
    avatar_speak_duration: 'Play_Dur: avatar.speak.started to avatar.speak.ended, business events only',
    cid_end: 'CID_End: first outbound input to event.cid_end; separate statistics event',
    total_interaction: 'Audio_To_End: first outbound input to natural completion or confirmed interruption; text/guidance use their first input; distinguish completion_reason',
    observed: 'Input_To_Observed_End: first outbound input to observation end, including timeout/interruption/disconnection',
    interrupt_ack: 'Interrupt_ACK: first observed interrupt request to confirmation; null without a matching request',
    test_audio_duration: 'Test_Audio_Start_To_End: decoded synthetic sample length, not a measured upload or wall-clock interval',
  };
  const timelineFields = {
    mic_ready: 'Mic_Ready: start_at to observed H5 microphone UI readiness; not a sum of preparation offsets',
    upload: '1st_Audio: first valid outbound input (audio append for audio turns)',
    speech: 'Speech_Started: server user_speech_started notification',
    asr: '1st_STT: first nonempty stt.result',
    upload_end: 'Last_Audio: last audio append, not physical end of speech',
    input_end: 'Speech_Stopped: server user_speech_stopped notification',
    asr_end: 'Last_STT: final STT result, excluding revoked finals',
    reply: '1st_Answer: first nonempty nlu.answer',
    reply_end: 'Last_Answer: model completion',
    speak: '1st_Play: avatar.speak.started business notification, not acoustic playback',
    speak_end: 'Last_Play: avatar.speak.ended business notification',
    interrupt: 'Trig_Interrupt: first successful event.interrupt send for this old turn',
    interrupted: 'Interrupted: matching nonempty-stages event.interrupted confirmation, not measured silence',
    end: 'End: observation completed, interrupted or failed',
  };
  const fieldOrder = {
    start_at: 0, start_by: 0, press_kind: 0, input_source: 0,
    mic_ready: 1, upload: 2, speech: 3, asr: 4,
    upload_end: 5, input_end: 6, asr_end: 7, stt_text: 7, stt_revocations: 7, reply: 8, reply_end: 9,
    answer_characters: 9, answer_stream: 9,
    speak: 10, speak_end: 11, avatar_ended: 11, avatar_speak_duration: 11,
    interrupt: 12, interrupt_at: 12, interrupted: 13, interrupted_at: 13, interrupt_ack: 13,
    end: 14, success: 14, completion_reason: 14, error_code: 14, total_interaction: 14, observed: 14,
    last_audio_to_final_asr: 7,
    last_audio_to_first_answer: 8, last_audio_to_avatar_start: 10, final_asr_to_first_answer: 8,
    first_answer: 8, cid_end: 14,
    test_audio_duration: 5,
  };
  const descriptions = {
    start_at: 'Start_At: local ISO8601 origin from a real press, auto-test or first input; T=0 is implicit',
    start_by: 'Start_By: press, auto_test or first_input; never infer multimodal VAD from unknown audio',
    press_kind: 'Press_Kind: pointer, keyboard or click; null for non-press origins',
    input_source: 'Source: browser_mic, multimodal_box, unknown or not_applicable',
    interrupt_at: 'Trig_At: old-turn interrupt request send time (ISO8601)',
    interrupted_at: 'Interrupted_At: old-turn confirmation arrival time (ISO8601)',
    success: 'OK: natural completion, confirmed interruption or confirmed normal presence-left session closure',
    completion_reason: 'End_By: independent of Start_By; successful session_ended is excluded from timing charts',
  };
  const describe = name => descriptions[name] ?? name;
  const schema = {
    standard_fields: ['latency_ms'],
    extra_fields: [
      ...Object.entries(timelineFields).map(([name, description]) => ({ name, description, type: 'number', unit: 'ms', chartable: true })),
      ...Object.entries(timingFields).map(([name, description]) => ({ name, description, type: 'number', unit: 'ms', chartable: true, default_hidden: true })),
      ...['client_adapter', 'instance_id', 'sid', 'cid', 'input_type',
        'input_source', 'start_at', 'start_by', 'press_kind', 'interrupt_at', 'interrupted_at',
        'interaction_mode', 'completion_reason', 'error_code', 'page_url'].map(name => ({ name, type: 'string', description: describe(name),
          ...(name.endsWith('_at') ? { unit: 'ISO8601' } : {}) })),
      { name: 'stt_text', type: 'string', description: 'STT Text: latest valid STT snapshot; cleared after stt_revocation', chartable: false },
      ...Object.entries({ answer_characters: 'characters', stt_revocations: 'count', cycle: 'count' }).map(([name, unit]) => ({ name, type: 'number', unit, description: describe(name) })),
      ...['success', 'avatar_ended'].map(name => ({ name, type: 'boolean', description: describe(name) })),
    ].sort((a, b) => (fieldOrder[a.name] ?? 99) - (fieldOrder[b.name] ?? 99)),
  };

  function createTracker({ now = () => performance.now(), wallNow = () => Date.now(), onResult = () => {}, onTurnStart = () => {},
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
      const origin = t.inputInfo?.pressAt ?? t.test?.clickAt ?? t.start;
      // Use the upload wall clock only to anchor the same local monotonic origin; never subtract server clocks.
      const startWall = t.inputInfo?.pressWall ?? t.startWall - (t.start - origin);
      const interactionCompleted = reason === 'completed' || reason === 'interrupted';
      const success = interactionCompleted || (reason === 'session_ended' && t.normalSessionEnd === true);
      const metrics = {
        client_adapter: 'guidex-runtime-v4', instance_id: t.instanceId,
        sid: t.sid, cid: t.cid, input_type: t.input, interaction_mode: t.test ? 'auto-test' : 'passive',
        input_source: t.inputInfo?.source ?? (t.input === 'audio' ? 'unknown' : 'not_applicable'),
        start_by: t.inputInfo?.pressAt != null ? 'press' : t.test?.clickAt != null ? 'auto_test' : 'first_input',
        start_at: new Date(startWall).toISOString(),
        press_kind: t.inputInfo?.pressKind ?? null,
        interrupt_at: t.interruptWall == null ? null : new Date(t.interruptWall).toISOString(),
        interrupted_at: reason === 'interrupted' ? new Date(wallNow()).toISOString() : null,
        mic_ready: elapsed(t.inputInfo?.readyAt, origin), upload: elapsed(t.start, origin),
        speech: elapsed(t.speechStart, origin), asr: elapsed(t.firstAsr, origin),
        upload_end: elapsed(t.lastAudio, origin), input_end: elapsed(t.speechStop, origin),
        asr_end: elapsed(t.asrEnd, origin), reply: elapsed(t.firstAnswer, origin),
        reply_end: elapsed(t.modelEnd, origin), speak: elapsed(t.avatarStart, origin),
        speak_end: elapsed(t.avatarEnd, origin), end: elapsed(at, origin),
        interrupt: elapsed(t.interruptAt, origin),
        interrupted: reason === 'interrupted' ? elapsed(at, origin) : null,
        interrupt_ack: reason === 'interrupted' ? elapsed(at, t.interruptAt) : null,
        completion_reason: reason, success, error_code: t.errorCode ?? null,
        avatar_ended: t.avatarEnd != null,
        stt_text: t.input === 'audio' ? t.sttText ?? '' : null,
        answer_characters: t.answerChars, stt_revocations: t.revocations,
        last_audio_to_final_asr: elapsed(t.asrEnd, t.lastAudio),
        last_audio_to_first_answer: elapsed(t.firstAnswer, t.lastAudio),
        last_audio_to_avatar_start: elapsed(t.avatarStart, t.lastAudio),
        final_asr_to_first_answer: elapsed(t.firstAnswer, t.asrEnd),
        first_answer: elapsed(t.firstAnswer, t.start),
        answer_stream: elapsed(t.modelEnd, t.firstAnswer),
        avatar_speak_duration: elapsed(t.avatarEnd, t.avatarStart), cid_end: elapsed(t.cidEnd, t.start),
        // Confirmed interruption settles the turn successfully, without inventing natural playback completion.
        total_interaction: interactionCompleted ? elapsed(at, t.start) : null,
        observed: elapsed(at, t.start), cycle: t.test?.cycle ?? null,
        test_audio_duration: t.test?.durationMs ?? null,
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
          if (s.sid !== e.sid) { s.endRequest = null; s.sessionFailed = false; }
          s.sid = e.sid; s.sessionMs = elapsed(at, s.sessionRequestAt); s.sessionRequestAt = null;
          return;
        }
        if (e.event === 'instance.closed') {
          flush(s, 'instance_closed', at); s.sid = null; s.endRequest = null; return;
        }
        if (e.event === 'session.end') {
          if (s.sid === e.sid) s.endRequest = { sid: e.sid, reason: e.reason };
          return;
        }
        if (e.event === 'event.idle_timeout') {
          if (s.sid === e.sid) s.sessionFailed = true;
          return;
        }
        if (e.event === 'session.ending') {
          if (s.sid === e.sid && e.reasonProvided && e.reason !== 'presence_left') s.sessionFailed = true;
          return;
        }
        if (e.event === 'session.ended') {
          // An explicit server reason takes precedence, including unknown/malformed reasons.
          // A local end request alone never settles a turn or implies completed playback.
          const endReason = e.reasonProvided ? e.reason
            : s.endRequest?.sid === e.sid ? s.endRequest.reason : null;
          const normal = s.sid === e.sid && endReason === 'presence_left' && !s.sessionFailed;
          for (const [key, t] of s.turns) if (t.sid === e.sid) {
            t.normalSessionEnd = normal;
            finish(s, key, t, at - t.start >= timeoutMs ? 'timeout' : 'session_ended', at);
          }
          if (s.sid === e.sid) { s.sid = null; s.endRequest = null; s.sessionFailed = false; }
          return;
        }
        if (e.event === 'error' && (e.scope === 'session' || e.scope === 'instance')) {
          if (e.scope === 'instance' || e.sid === s.sid) s.sessionFailed = true;
          for (const [key, t] of s.turns) if (e.scope === 'instance' || (e.sid && t.sid === e.sid)) {
            t.errorCode = e.code;
            finish(s, key, t, 'error', at);
          }
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
            start: at, startWall: wallNow(), sessionMs: s.sessionMs ?? null, sttText: null,
            answerChars: 0, revocations: 0, sttRevoked: false };
          s.turns.set(key, t);
          onTurnStart({ socketId, instanceId: t.instanceId, sid: t.sid, cid: t.cid, input: t.input });
        }
        if (!t) return;
        switch (e.event) {
          case 'conversation.user.append':
            if (e.input === 'audio') {
              t.lastAudio = at;
            }
            break;
          case 'event.user_speech_started': first(t, 'speechStart', at); break;
          case 'event.user_speech_stopped': first(t, 'speechStop', at); break;
          case 'stt.result':
            if (t.sttRevoked || t.asrEnd != null) break;
            t.sttText = e.text;
            if (e.text.trim()) first(t, 'firstAsr', at);
            if (e.final) first(t, 'asrEnd', at);
            break;
          case 'event.stt_revocation':
            t.sttText = '';
            t.asrEnd = null;
            t.sttRevoked = true;
            t.revocations++;
            break;
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
          case 'event.interrupt':
            // The command carries the interrupted turn's ids, not the newly pressed turn's ids.
            if (t.interruptAt == null) { t.interruptAt = at; t.interruptWall = wallNow(); }
            break;
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
      annotateInput(socketId, context, info) {
        const t = sockets.get(socketId)?.turns.get(keyOf(context));
        if (!t || !['browser_mic', 'multimodal_box', 'unknown', 'not_applicable'].includes(info.source)) return;
        const clean = { source: info.source };
        if (info.source === 'browser_mic' && Number.isFinite(info.pressAt) && info.pressAt >= 0 && info.pressAt <= t.start) {
          clean.pressAt = info.pressAt;
          if (Number.isSafeInteger(info.pressWall) && info.pressWall >= 0 && info.pressWall < 8640000000000000)
            clean.pressWall = info.pressWall;
          if (['pointer', 'keyboard', 'click'].includes(info.pressKind)) clean.pressKind = info.pressKind;
          for (const field of ['micRequestAt', 'micAt', 'readyAt'])
            if (Number.isFinite(info[field]) && info[field] >= info.pressAt && info[field] <= now()) clean[field] = info[field];
        }
        t.inputInfo = clean;
      },
      sweep() { const at = now(); for (const s of sockets.values()) flush(s, 'timeout', at, t => at - t.start >= timeoutMs); },
      disconnect(socketId) {
        const s = sockets.get(socketId);
        if (s) { flush(s, 'disconnected', now()); sockets.delete(socketId); }
      },
      reset() { sockets.clear(); lastResult = null; completed = 0; },
      setEnabled(value) {
        enabled = value;
        if (!value) for (const s of sockets.values()) {
          s.turns.clear(); s.closed.clear(); s.endRequest = null;
        }
      },
      snapshot() {
        return { connections: sockets.size, activeTurns: [...sockets.values()].reduce((n, s) => n + s.turns.size, 0),
          ready: [...sockets.values()].some(s => s.readyAt != null), completed, lastResult };
      },
    };
  }
  return { PROBE_NAME, schema, fieldOrder, connectionInfo, decode, createTracker };
});
