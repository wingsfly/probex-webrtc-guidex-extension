const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, decode, connectionInfo, schema } = require('../guidex-runtime.js');

// Synthetic fixtures reflecting chat-wire.ts/runtime-wire-codec.ts, no captured conversations.
const WS = 'ws://localhost/chat/api/chat/aichain/instance-a?runId=sample';
const control = new Set(['instance.open', 'instance.ready', 'instance.closed', 'session.start',
  'session.started', 'session.end', 'session.ending', 'session.ended', 'event.idle_timeout', 'event.user_speech_stopped', 'event.interrupt',
  'event.interrupted', 'avatar.speak.started', 'avatar.speak.ended', 'guidance.trigger', 'error']);
function wire(event, payload = {}, context = {}, direction = 'receive', profile = 'guidex-chat-v1') {
  return JSON.stringify({
    header: { version: '1.0', event, channel: control.has(event) || event.endsWith('.error') ? 'control' : 'data',
      sendAt: 1800000000000, context: { instanceId: 'instance-a', ...context } },
    payload: direction === 'receive' && profile === 'guidex-chat-v1' ? { data: payload } : payload,
  });
}
function harness(options = {}) {
  let time = 0;
  const results = [];
  const tracker = createTracker({ now: () => time, wallNow: () => 1800000000000 + time,
    onResult: r => results.push(r), ...options });
  tracker.connect('socket', WS);
  time = 10; tracker.open('socket');
  const emit = (at, event, payload = {}, context = {}, direction = 'receive', socket = 'socket') => {
    time = at; tracker.observe(socket, direction, wire(event, payload, context, direction));
  };
  emit(20, 'instance.open', {}, {}, 'send');
  emit(40, 'instance.ready');
  const ready = () => {
    emit(50, 'session.start', {}, {}, 'send');
    emit(80, 'session.started', { ready: true }, { sid: 'session-a' });
  };
  const context = cid => ({ sid: 'session-a', cid });
  const audio = (at, cid = 'turn-a') => emit(at, 'conversation.user.append',
    { items: [{ type: 'audio', data: 'AAAAAA==' }] }, context(cid), 'send');
  const text = (at, cid = 'turn-a') => emit(at, 'conversation.user.append',
    { input: { type: 'text', text: 'synthetic prompt' } }, context(cid), 'send');
  const answer = (at, final = false, cid = 'turn-a', value = 'sample') => emit(at, 'nlu.answer',
    { operation: 'append', text: value, format: 'plain_text', final }, context(cid));
  const event = (at, name, data = {}, cid = 'turn-a') => emit(at, name, data, context(cid));
  return { tracker, results, emit, ready, audio, text, answer, event, context, setTime: t => { time = t; } };
}

test('connection selection excludes legacy, device bridge and unrelated sockets', () => {
  assert.equal(connectionInfo('wss://example.test/voiceDictation'), null);
  assert.equal(connectionInfo('ws://localhost:47171/audio'), null);
  assert.equal(connectionInfo('ws://localhost:47171/h5'), null);
  assert.equal(connectionInfo('wss://example.test/chat/api/chat/aichain'), null);
  assert.deepEqual(connectionInfo(WS), { profile: 'guidex-chat-v1', instanceId: 'instance-a' });
  assert.equal(connectionInfo('wss://example.test/prefix/chat/api/chat/aichain/i?runId=r').profile, 'guidex-chat-v1');
});

test('directional chat wrappers, strict headers and payload fields', () => {
  const raw = wire('stt.result', { text: 'test', isFinal: true }, { sid: 's', cid: 'c' });
  assert.equal(decode(raw, 'receive', 'guidex-chat-v1').text, 'test');
  assert.equal(decode(raw, 'receive', 'runtime-v1-draft'), null);
  const changed = JSON.parse(raw);
  changed.header.channel = 'control';
  assert.equal(decode(JSON.stringify(changed), 'receive', 'guidex-chat-v1'), null);
  changed.header.channel = 'data'; changed.header.version = '2.0';
  assert.equal(decode(JSON.stringify(changed), 'receive', 'guidex-chat-v1'), null);
  changed.header.version = '1.0'; changed.header.sentAt = changed.header.sendAt;
  assert.equal(decode(JSON.stringify(changed), 'receive', 'guidex-chat-v1'), null);
  assert.equal(decode('{', 'receive', 'guidex-chat-v1'), null);
  assert.equal(decode(new Uint8Array([1]), 'receive', 'guidex-chat-v1'), null);
  assert.equal(decode(wire('stt.result', { text: 'x', isFinal: 'true' }), 'receive', 'guidex-chat-v1'), null);
});

test('last-audio intervals preserve zero and negative deltas even without a speech-stop event', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(150, 'stt.result', { text: 'final', isFinal: true });
  h.answer(160); h.event(170, 'avatar.speak.started');
  h.audio(170);
  h.setTime(200); h.tracker.disconnect('socket');
  const m = h.results[0];
  assert.equal(m.success, false);
  assert.equal(m.input_end, null);
  assert.equal(m.last_audio_to_final_asr, -20);
  assert.equal(m.last_audio_to_first_answer, -10);
  assert.equal(m.last_audio_to_avatar_start, 0);
});

test('last-audio anchor is isolated per cid and never borrowed by text or guidance turns', () => {
  const h = harness(); h.ready(); h.audio(100, 'a'); h.audio(110, 'b');
  h.text(120, 'text');
  h.emit(130, 'guidance.trigger', { kind: 'welcome' }, h.context('guidance'), 'send');
  h.audio(140, 'a'); h.audio(150, 'b');
  for (const cid of ['a', 'b', 'text', 'guidance']) {
    h.event(200, 'stt.result', { text: 'final', isFinal: true }, cid);
  }
  for (const cid of ['a', 'b', 'text', 'guidance']) h.answer(220, true, cid);
  for (const cid of ['a', 'b', 'text', 'guidance']) h.event(240, 'avatar.speak.started', {}, cid);
  h.setTime(250); h.tracker.disconnect('socket');
  const byCid = Object.fromEntries(h.results.map(m => [m.cid, m]));
  const keys = ['last_audio_to_final_asr', 'last_audio_to_first_answer', 'last_audio_to_avatar_start'];
  assert.deepEqual(keys.map(key => byCid.a[key]), [60, 80, 100]);
  assert.deepEqual(keys.map(key => byCid.b[key]), [50, 70, 90]);
  for (const cid of ['text', 'guidance']) assert.deepEqual(keys.map(key => byCid[cid][key]), [null, null, null]);
});

test('passive microphone, box and auto-test use the same last-audio anchor', () => {
  for (const mode of ['browser_mic', 'multimodal_box', 'auto-test']) {
    const h = harness(); h.ready(); h.audio(100);
    const context = { instanceId: 'instance-a', ...h.context('turn-a') };
    if (mode === 'auto-test') h.tracker.annotate('socket', context, { clickAt: 90, audioEnd: 190 });
    else h.tracker.annotateInput('socket', context, { source: mode });
    h.audio(195);
    h.event(200, 'event.user_speech_stopped');
    h.event(210, 'stt.result', { text: 'final', isFinal: true });
    h.answer(220, true); h.event(230, 'avatar.speak.started');
    h.event(400, 'avatar.speak.ended');
    const m = h.results[0];
    assert.deepEqual([m.last_audio_to_final_asr, m.last_audio_to_first_answer, m.last_audio_to_avatar_start], [15, 25, 35], mode);
  }
});

test('instance registration never stands in for a ready business session', () => {
  const h = harness(); h.audio(60);
  h.emit(70, 'session.started', { ready: false }, { sid: 'session-a' }); h.audio(75);
  assert.equal(h.tracker.snapshot().activeTurns, 0);
  h.ready(); h.audio(100);
  assert.equal(h.tracker.snapshot().activeTurns, 1);
});

test('audio turn metrics use local arrival times and three independent completion boundaries', () => {
  const h = harness(); h.ready(); h.audio(100); h.audio(160);
  h.event(180, 'event.user_speech_started');
  h.event(250, 'stt.result', { text: 'one', isFinal: false });
  h.event(350, 'event.user_speech_stopped');
  h.event(400, 'stt.result', { text: 'one two', isFinal: true });
  h.answer(500); h.event(550, 'avatar.speak.started'); h.event(600, 'event.cid_end');
  h.answer(700, true, 'turn-a', '');
  assert.equal(h.results.length, 0);
  h.event(950, 'avatar.speak.ended');
  const m = h.results[0];
  assert.equal(m.success, true); assert.equal(m.total_interaction, 850);
  assert.equal(m.speech, 80);
  assert.equal(Object.hasOwn(m, 'audio_start_to_speech_started'), false);
  assert.equal(m.stt_text, 'one two'); assert.equal(m.last_audio_to_final_asr, 240);
  assert.equal(m.last_audio_to_first_answer, 340); assert.equal(m.avatar_speak_duration, 400);
  assert.equal(m.last_audio_to_avatar_start, 390);
  assert.equal(m.answer_stream, 200); assert.equal(m.cid_end, 500); assert.equal(m.answer_characters, 6);
  for (const field of ['audio_upload_window', 'audio_bytes', 'audio_frames', 'audio_start_to_first_asr',
    'click_to_first_audio']) assert.equal(Object.hasOwn(m, field), false, field);
});

test('turn schema and results omit shared connection and session timings', () => {
  const h = harness(); h.ready(); h.text(100, 'a'); h.answer(200, true, 'a');
  h.event(300, 'avatar.speak.ended', {}, 'a');
  h.text(400, 'b'); h.answer(500, true, 'b'); h.event(600, 'avatar.speak.ended', {}, 'b');
  h.audio(700, 'c'); h.setTime(800); h.tracker.disconnect('socket');
  assert.deepEqual(h.results.map(m => m.completion_reason), ['completed', 'completed', 'disconnected']);
  const names = [...schema.standard_fields, ...schema.extra_fields.map(f => f.name)];
  for (const field of ['ws_connect_ms', 'instance_register_ms', 'session_start_ms']) {
    assert.equal(names.includes(field), false, field);
    for (const result of h.results) assert.equal(Object.hasOwn(result, field), false, field);
  }
});

test('unified start and unitless timing names are consistent in schema and every outcome', () => {
  const h = harness(); h.ready(); h.text(100, 'a'); h.answer(200, true, 'a');
  h.event(250, 'avatar.speak.ended', {}, 'a'); h.audio(300, 'b');
  h.event(400, 'event.interrupted', {}, 'b'); h.audio(500, 'c');
  h.setTime(600); h.tracker.disconnect('socket');
  const fields = schema.extra_fields;
  const forbidden = ['protocol_profile', 'source_evidence', 'press_at', 'timeline_origin', 'press_ms', 'start', 'mic_request', 'mic', 'ready',
    'speech_stop_to_final_asr', 'speech_stop_to_first_answer', 'speech_stop_to_avatar_start', 'test_audio_to_avatar_start',
    'audio_start_to_speech_started'];
  for (const m of h.results) {
    for (const key of forbidden) assert.equal(Object.hasOwn(m, key), false, key);
    assert.equal(Object.keys(m).some(key => key.endsWith('_ms')), false);
    assert.equal(m.start_by, 'first_input');
    assert.ok(Number.isFinite(Date.parse(m.start_at)));
    for (const key of Object.keys(m)) assert.ok(fields.some(field => field.name === key), key);
  }
  for (const key of forbidden) assert.equal(fields.some(field => field.name === key), false, key);
  assert.equal(fields.some(field => field.name.endsWith('_ms')), false);
  assert.deepEqual(schema.standard_fields, ['latency_ms']);
  assert.match(fields.find(field => field.name === 'mic_ready').description, /^Mic_Ready:/);
  assert.match(fields.find(field => field.name === 'upload').description, /^1st_Audio:/);
  for (const field of fields) {
    assert.doesNotMatch(field.description, /^\d+\.\s/);
    if (!['answer_stream', 'avatar_speak_duration'].includes(field.name)) assert.doesNotMatch(field.description, /_Dur\b/);
  }
  for (const [key, label] of Object.entries({
    last_audio_to_final_asr: 'LastAudio_To_STT',
    last_audio_to_first_answer: 'LastAudio_To_Answer', final_asr_to_first_answer: 'STT_To_Answer',
    answer_stream: 'Answer_Dur', last_audio_to_avatar_start: 'LastAudio_To_Play',
    avatar_speak_duration: 'Play_Dur',
    total_interaction: 'Audio_To_End', observed: 'Input_To_Observed_End', first_answer: 'Audio_To_Answer',
    test_audio_duration: 'Test_Audio_Start_To_End',
  })) assert.equal(fields.find(field => field.name === key).description.split(':')[0], label);
  assert.equal(fields.find(field => field.name === 'stt_text').type, 'string');
  assert.equal(fields.find(field => field.name === 'stt_text').chartable, false);
  assert.equal(fields.find(field => field.name === 'start_at').unit, 'ISO8601');
});

test('recognized audio can complete without speech-start and duplicate avatar starts do not reset timing', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(200, 'stt.result', { text: 'sample', isFinal: true });
  h.event(250, 'event.user_speech_stopped'); h.answer(300, true);
  h.event(350, 'avatar.speak.started'); h.event(375, 'avatar.speak.started');
  h.event(500, 'avatar.speak.ended');
  const m = h.results[0];
  assert.equal(m.success, true); assert.equal(m.stt_text, 'sample');
  assert.equal(m.speech, null);
  assert.equal(Object.hasOwn(m, 'audio_start_to_speech_started'), false);
  assert.equal(m.asr, 100);
  assert.equal(m.last_audio_to_avatar_start, 250);
  assert.equal(m.avatar_speak_duration, 150);
});

test('STT final and cid_end cannot close an audio input or invent model/playback final', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(200, 'stt.result', { text: 'x', isFinal: true }); h.event(220, 'event.cid_end');
  h.answer(300, true); h.event(400, 'avatar.speak.ended');
  assert.equal(h.results.length, 0);
  h.event(500, 'event.user_speech_stopped');
  assert.equal(h.results[0].last_audio_to_final_asr, 100);
  assert.equal(h.results[0].avatar_speak_duration, null);
});

test('empty final append retains accumulated answer, replace and postprocess are handled', () => {
  const h = harness(); h.ready(); h.text(100);
  h.answer(110, false, 'turn-a', 'abc'); h.answer(120, false, 'turn-a', 'def');
  h.event(130, 'nlu.answer', { operation: 'replace', text: 'xy', format: 'plain_text' });
  h.answer(140, true, 'turn-a', '');
  h.event(150, 'nlu.postprocess', { status: 'completed', finalText: 'late replacement', format: 'plain_text' });
  h.event(200, 'avatar.speak.ended');
  assert.equal(h.results[0].answer_characters, 2);
  assert.equal(h.results[0].reply_end, 40);
  assert.equal(h.results[0].input_type, 'text');
  h.text(300, 'turn-b');
  h.event(330, 'nlu.postprocess', { status: 'completed', finalText: 'post', format: 'plain_text' }, 'turn-b');
  h.event(340, 'avatar.speak.ended', {}, 'turn-b');
  assert.equal(h.results[1].answer_characters, 4);
});

test('overlapping cids, missing context, foreign instance/sid and late old final stay isolated', () => {
  const h = harness(); h.ready(); h.text(100, 'a'); h.text(110, 'b');
  h.answer(150, true, 'a'); h.answer(160, true, 'b');
  h.emit(170, 'avatar.speak.ended', {}, { sid: 'session-a', cid: null });
  h.emit(171, 'avatar.speak.ended', {}, { instanceId: 'foreign', sid: 'session-a', cid: 'b' });
  h.emit(172, 'avatar.speak.ended', {}, { sid: 'wrong', cid: 'b' });
  assert.equal(h.results.length, 0);
  h.event(180, 'avatar.speak.ended', {}, 'a');
  h.event(185, 'avatar.speak.ended', {}, 'a');
  assert.equal(h.tracker.snapshot().activeTurns, 1);
  h.event(200, 'avatar.speak.ended', {}, 'b');
  assert.deepEqual(h.results.map(m => m.cid), ['a', 'b']);
});

test('STT revocation is a snapshot correction and not a new turn', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(150, 'stt.result', { text: 'wrong', isFinal: true });
  h.event(160, 'event.stt_revocation', { text: '' });
  h.event(170, 'stt.result', { text: 'late wrong text', isFinal: true });
  h.event(180, 'event.user_speech_stopped'); h.answer(200, true); h.event(250, 'avatar.speak.ended');
  assert.equal(h.results[0].stt_text, '');
  for (const field of ['asr_final', 'asr_recognized', 'asr_characters'])
    assert.equal(Object.hasOwn(h.results[0], field), false, field);
  assert.equal(h.results[0].stt_revocations, 1); assert.equal(h.results[0].last_audio_to_final_asr, null);
});

test('late partial STT cannot overwrite a finalized snapshot', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(150, 'stt.result', { text: 'final text', isFinal: true });
  h.event(160, 'stt.result', { text: 'late partial', isFinal: false });
  h.event(180, 'event.user_speech_stopped'); h.answer(200, true); h.event(250, 'avatar.speak.ended');
  assert.equal(h.results[0].stt_text, 'final text');
  assert.equal(h.results[0].asr_end, 50);
});

test('interrupt request is not confirmation; empty explicit stages is a no-op', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.emit(150, 'event.interrupt', { scope: ['nlu', 'avatar'] }, h.context('turn-a'), 'send');
  h.event(160, 'event.interrupted', { stages: [] }); assert.equal(h.results.length, 0);
  h.event(170, 'event.interrupted', {});
  assert.equal(h.results[0].completion_reason, 'interrupted');
  assert.equal(h.results[0].success, true);
  assert.equal(Object.hasOwn(h.results[0], 'input_ended'), false);
  assert.equal(h.results[0].total_interaction, 70);
  assert.equal(h.results[0].interrupt, 50); assert.equal(h.results[0].interrupted, 70);
  assert.equal(h.results[0].interrupt_ack, 20);
  h.event(180, 'avatar.speak.ended'); assert.equal(h.results.length, 1);
});

test('interrupt request and confirmation belong to the old cid with press-relative and wall timestamps', () => {
  const h = harness(); h.ready(); h.audio(100, 'old');
  h.tracker.annotateInput('socket', { instanceId: 'instance-a', ...h.context('old') },
    { source: 'browser_mic', pressAt: 40, pressWall: 1800000000040 });
  h.event(130, 'event.user_speech_stopped', {}, 'old'); h.answer(150, true, 'old');
  h.event(170, 'avatar.speak.started', {}, 'old');
  h.emit(200, 'event.interrupt', {}, h.context('old'), 'send');
  h.audio(210, 'new');
  h.emit(220, 'event.interrupt', {}, h.context('old'), 'send');
  h.event(250, 'event.interrupted', { stages: ['nlu', 'tts', 'avatar'] }, 'old');
  const m = h.results[0];
  assert.equal(m.cid, 'old'); assert.equal(m.success, true);
  assert.equal(m.interrupt, 160); assert.equal(m.interrupted, 210); assert.equal(m.end, 210);
  assert.equal(m.interrupt_ack, 50); assert.equal(m.total_interaction, 150);
  assert.equal(m.interrupt_at, new Date(1800000000200).toISOString());
  assert.equal(m.interrupted_at, new Date(1800000000250).toISOString());
  assert.equal(m.avatar_ended, false); assert.equal(m.speak_end, null);
  assert.equal(m.avatar_speak_duration, null);
  h.event(260, 'event.interrupted', {}, 'old'); h.event(270, 'avatar.speak.ended', {}, 'old');
  assert.equal(h.results.length, 1); assert.equal(h.tracker.snapshot().activeTurns, 1);
  h.event(300, 'event.user_speech_stopped', {}, 'new'); h.answer(320, true, 'new');
  h.event(400, 'avatar.speak.ended', {}, 'new');
  assert.equal(h.results[1].cid, 'new'); assert.equal(h.results[1].completion_reason, 'completed');
  for (const key of ['interrupt', 'interrupted', 'interrupt_ack', 'interrupt_at', 'interrupted_at'])
    assert.equal(h.results[1][key], null, key);
});

test('server interruption without a request never borrows another cid or invents request timing', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.emit(120, 'event.interrupt', {}, h.context('other'), 'send');
  h.emit(130, 'event.interrupt', {}, { sid: 'wrong', cid: 'turn-a' }, 'send');
  h.emit(140, 'event.interrupt', {}, { sid: 'session-a' }, 'send');
  h.event(200, 'event.interrupted', { stages: ['input'] });
  const m = h.results[0];
  assert.equal(m.success, true); assert.equal(m.interrupted, 100);
  assert.equal(m.interrupt, null); assert.equal(m.interrupt_at, null); assert.equal(m.interrupt_ack, null);
  assert.equal(Object.hasOwn(m, 'model_completed'), false);
  assert.equal(Object.hasOwn(m, 'input_ended'), false);
});

test('unconfirmed interrupt is not successful unless the turn completes naturally', () => {
  for (const ending of ['timeout', 'error', 'completed']) {
    const h = harness({ timeoutMs: 1000 }); h.ready(); h.text(100);
    h.emit(150, 'event.interrupt', {}, h.context('turn-a'), 'send');
    h.event(160, 'event.interrupted', { stages: [] });
    assert.equal(h.results.length, 0);
    if (ending === 'timeout') { h.setTime(1200); h.tracker.sweep(); }
    else if (ending === 'error') h.event(200, 'error', { scope: 'conversation', code: 'FAILED' });
    else { h.answer(200, true); h.event(250, 'avatar.speak.ended'); }
    const m = h.results[0];
    assert.equal(m.completion_reason, ending); assert.equal(m.success, ending === 'completed');
    assert.equal(m.interrupt, 50); assert.equal(m.interrupted, null);
    assert.equal(m.interrupted_at, null); assert.equal(m.interrupt_ack, null);
  }
});

test('wall clock adjustments do not change interrupt latency', () => {
  let wall = 1800000000000;
  const h = harness({ wallNow: () => wall }); h.ready(); h.text(100);
  h.emit(200, 'event.interrupt', {}, h.context('turn-a'), 'send');
  wall -= 5000;
  h.event(250, 'event.interrupted', {});
  assert.equal(h.results[0].interrupt_ack, 50);
  assert.equal(h.results[0].total_interaction, 150);
});

test('disconnect/reconnect isolates attempts with the same instance/session/cid', () => {
  const h = harness(); h.ready(); h.text(100); h.setTime(130); h.tracker.disconnect('socket');
  assert.equal(h.results[0].completion_reason, 'disconnected');
  h.tracker.connect('socket2', WS);
  h.emit(200, 'instance.ready', {}, {}, 'receive', 'socket2');
  h.emit(210, 'session.started', { ready: true }, { sid: 'session-a' }, 'receive', 'socket2');
  h.emit(220, 'conversation.user.append', { input: { type: 'text', text: 'new' } }, h.context('turn-a'), 'send', 'socket2');
  h.event(230, 'avatar.speak.ended');
  assert.equal(h.tracker.snapshot().activeTurns, 1); assert.equal(h.results.length, 1);
});

test('malformed/empty audio and wrong direction cannot create phantom rounds', () => {
  const h = harness(); h.ready();
  for (const data of ['', 'not-base64!!']) h.emit(100, 'conversation.user.append',
    { items: [{ type: 'audio', data }], status: 2 }, h.context('a'), 'send');
  h.emit(110, 'conversation.user.append', { items: [{ type: 'audio', data: 'AAAA' }] }, h.context('a'));
  assert.equal(h.tracker.snapshot().activeTurns, 0);
});

test('timeouts/capacity/errors report partial facts instead of successful end-to-end latency', () => {
  const h = harness({ timeoutMs: 1000, maxTurns: 1 }); h.ready(); h.text(100, 'a'); h.text(200, 'b');
  assert.equal(h.results[0].completion_reason, 'capacity');
  h.setTime(1300); h.tracker.sweep();
  assert.equal(h.results[1].completion_reason, 'timeout'); assert.equal(h.results[1].total_interaction, null);
  h.text(1400, 'c'); h.event(1500, 'error', { scope: 'conversation', code: 'MODEL_FAILED' }, 'c');
  assert.equal(h.results[2].error_code, 'MODEL_FAILED'); assert.equal(h.results[2].success, false);
});

test('disabled collection discards turns but observes session lifecycle for re-enable', () => {
  const h = harness(); h.ready(); h.audio(100); h.tracker.setEnabled(false); h.text(150);
  assert.equal(h.tracker.snapshot().activeTurns, 0); assert.equal(h.results.length, 0);
  h.tracker.setEnabled(true); h.text(200, 'b'); h.answer(300, true, 'b'); h.event(400, 'avatar.speak.ended', {}, 'b');
  assert.equal(h.results.length, 1);
});

test('observer keeps scalar metrics and the latest STT text, not prompts, answers, PCM, tokens or RTC descriptions', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(200, 'stt.result', { text: 'PRIVATE_TRANSCRIPT', isFinal: true, token: 'SECRET_TOKEN' });
  h.event(220, 'event.user_speech_stopped'); h.answer(300, true, 'turn-a', 'PRIVATE_ANSWER');
  h.event(400, 'avatar.speak.ended', { streamInfo: { auth: 'RTC_SECRET' } });
  const json = JSON.stringify(h.tracker.snapshot());
  assert.equal(h.results[0].stt_text, 'PRIVATE_TRANSCRIPT');
  for (const value of ['PRIVATE_ANSWER', 'SECRET_TOKEN', 'RTC_SECRET', 'AAAAAA=='])
    assert.equal(json.includes(value), false);
  const names = schema.extra_fields.map(f => f.name);
  for (const field of Object.keys(h.results[0])) assert.ok(names.includes(field), field);
  for (const field of ['audio_end_to_tts_ms', 'lip_move_ms', 'audio_end_to_playback_ms']) assert.equal(names.includes(field), false);
});

test('auto-test timing annotation preserves native ids and event timestamps', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.tracker.annotate('socket', { instanceId: 'instance-a', ...h.context('turn-a') }, { clickAt: 90, cycle: 1, durationMs: 80 });
  h.tracker.annotate('socket', { instanceId: 'instance-a', ...h.context('turn-a') }, { audioEnd: 190 });
  h.audio(195);
  h.event(200, 'event.user_speech_stopped'); h.answer(210, true);
  h.event(230, 'avatar.speak.started'); h.event(400, 'avatar.speak.ended');
  assert.equal(h.results[0].last_audio_to_avatar_start, 35);
  assert.equal(h.results[0].last_audio_to_first_answer, 15);
  assert.equal(Object.hasOwn(h.results[0], 'test_audio_to_avatar_start'), false);
  assert.equal(h.results[0].interaction_mode, 'auto-test'); assert.equal(h.results[0].cid, 'turn-a');
  assert.equal(h.results[0].start_by, 'auto_test'); assert.equal(h.results[0].upload, 10);
  assert.equal(h.results[0].start_at, new Date(1800000000090).toISOString()); assert.equal(Object.hasOwn(h.results[0], 'start'), false);
});

test('manual timeline uses the press origin without changing legacy upload-based metrics', () => {
  const h = harness(); h.ready(); h.audio(100);
  const context = { instanceId: 'instance-a', ...h.context('turn-a') };
  const info = { source: 'browser_mic', pressAt: 40, pressWall: 1800000000040, pressKind: 'pointer', micRequestAt: 55, micAt: 70 };
  h.tracker.annotateInput('socket', context, info);
  h.setTime(110); h.tracker.annotateInput('socket', context, { ...info, readyAt: 110 });
  h.event(130, 'stt.result', { text: 'sample', isFinal: true });
  h.event(140, 'event.user_speech_stopped'); h.answer(200, true);
  h.event(250, 'avatar.speak.started'); h.event(400, 'avatar.speak.ended');
  const m = h.results[0];
  assert.equal(m.start_by, 'press'); assert.equal(Object.hasOwn(m, 'start'), false);
  assert.equal(m.mic_ready, 70); assert.equal(m.upload, 60);
  assert.equal(m.asr, 90); assert.equal(m.input_end, 100); assert.equal(m.reply, 160);
  assert.equal(m.speak, 210); assert.equal(m.speak_end, 360); assert.equal(m.end, 360);
  assert.equal(m.first_answer, 100); assert.equal(m.total_interaction, 300);
  assert.equal(m.interaction_mode, 'passive');
  assert.equal(m.start_at, new Date(1800000000040).toISOString());
});

test('mic readiness is observed directly, preserves zero and never falls back to acquisition', () => {
  for (const readyAt of [undefined, 40, 90]) {
    const h = harness(); h.ready(); h.audio(100);
    h.tracker.annotateInput('socket', { instanceId: 'instance-a', ...h.context('turn-a') }, {
      source: 'browser_mic', pressAt: 40, micRequestAt: 55, micAt: 70, readyAt,
    });
    h.setTime(200); h.tracker.disconnect('socket');
    const m = h.results[0];
    assert.equal(m.mic_ready, readyAt == null ? null : readyAt - 40);
    for (const field of ['start', 'mic_request', 'mic', 'ready']) assert.equal(Object.hasOwn(m, field), false);
  }
});

test('multimodal and unknown rounds keep upload origin, including partial failures', () => {
  for (const source of ['multimodal_box', 'unknown']) {
    const h = harness(); h.ready(); h.audio(100);
    h.tracker.annotateInput('socket', { instanceId: 'instance-a', ...h.context('turn-a') }, { source, pressAt: 20 });
    h.setTime(200); h.tracker.disconnect('socket');
    const m = h.results[0];
    assert.equal(m.input_source, source); assert.equal(m.start_by, 'first_input');
    assert.equal(Object.hasOwn(m, 'start'), false); assert.equal(m.upload, 0); assert.equal(m.end, 100);
    assert.equal(m.start_at, new Date(1800000000100).toISOString());
    assert.equal(m.total_interaction, null); assert.equal(m.speak_end, null);
  }
});

test('two guidance turns settle together on confirmed presence-left without fabricated completion', () => {
  const h = harness(); h.ready();
  h.emit(100, 'guidance.trigger', { kind: 'welcome' }, h.context('welcome'), 'send');
  h.emit(17322, 'guidance.trigger', { kind: 'farewell' }, h.context('farewell'), 'send');
  h.emit(17323, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
  assert.equal(h.results.length, 0);
  h.emit(17395, 'session.ended', {}, { sid: 'session-a' });
  assert.deepEqual(h.results.map(r => r.observed), [17295, 73]);
  for (const m of h.results) {
    assert.equal(m.success, true);
    assert.equal(m.completion_reason, 'session_ended');
    assert.equal(m.input_type, 'guidance');
    assert.equal(m.total_interaction, null);
    assert.equal(m.avatar_ended, false);
    for (const key of ['asr_end', 'reply_end', 'speak_end', 'speech', 'interrupted']) assert.equal(m[key], null);
  }
  h.emit(17400, 'session.ended', { reason: 'presence_left' }, { sid: 'session-a' });
  h.setTime(17401); h.tracker.disconnect('socket');
  assert.equal(h.results.length, 2);
});

test('explicit server presence-left confirmation settles audio/text too but does not complete their milestones', () => {
  for (const input of ['audio', 'text']) {
    const h = harness(); h.ready(); h[input](100);
    h.answer(150);
    h.emit(200, 'session.ended', { reason: 'presence_left' }, { sid: 'session-a' });
    const m = h.results[0];
    assert.equal(m.success, true);
    assert.equal(m.reply, 50);
    assert.equal(m.reply_end, null);
    assert.equal(m.speak_end, null);
    assert.equal(m.total_interaction, null);
    assert.equal(m.observed, 100);
  }
});

test('only presence_left is normal; explicit server reasons override a local request', () => {
  for (const payload of [{}, { reason: 'idle' }, { reason: 'timeout' }, { reason: 'error' },
    { reason: 'input_cancelled' }, { reason: null }, { reason: {} }, { reason: 'unknown_reason' }]) {
    const h = harness(); h.ready(); h.audio(100);
    h.emit(200, 'session.ended', payload, { sid: 'session-a' });
    assert.equal(h.results[0].success, false, JSON.stringify(payload));
    assert.equal(h.results[0].completion_reason, 'session_ended');
    if (Object.hasOwn(payload, 'reason')) {
      const other = harness(); other.ready(); other.audio(100);
      other.emit(150, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
      other.emit(200, 'session.ended', payload, { sid: 'session-a' });
      assert.equal(other.results[0].success, false, JSON.stringify(payload));
    }
  }
});

test('absence of confirmation remains timeout/disconnected; elapsed deadline cannot be hidden by a late end', () => {
  for (const action of ['sweep', 'disconnect', 'lateEnd']) {
    const h = harness({ timeoutMs: 500 }); h.ready(); h.audio(100);
    h.emit(150, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
    assert.equal(h.results.length, 0);
    h.setTime(600);
    if (action === 'sweep') h.tracker.sweep();
    else if (action === 'disconnect') h.tracker.disconnect('socket');
    else h.emit(600, 'session.ended', { reason: 'presence_left' }, { sid: 'session-a' });
    assert.equal(h.results[0].success, false);
    assert.equal(h.results[0].completion_reason, action === 'disconnect' ? 'disconnected' : 'timeout');
  }
});

test('session/instance/conversation errors are never reclassified by a later normal end', () => {
  for (const scope of ['session', 'instance', 'conversation', 'guidance']) {
    const h = harness(); h.ready(); h.audio(100);
    h.emit(120, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
    h.event(150, scope + '.error', { scope, code: 'UPSTREAM_FAILURE' });
    h.emit(200, 'session.ended', { reason: 'presence_left' }, { sid: 'session-a' });
    assert.equal(h.results.length, 1);
    assert.equal(h.results[0].success, false);
    assert.equal(h.results[0].error_code, 'UPSTREAM_FAILURE');
    assert.equal(h.results[0].completion_reason, 'error');
  }
});

test('session idle timeout and abnormal ending block a presence-left success', () => {
  for (const event of ['event.idle_timeout', 'session.ending']) {
    const h = harness(); h.ready(); h.audio(100);
    h.emit(120, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
    h.emit(150, event, { reason: 'timeout' }, { sid: 'session-a' });
    h.emit(200, 'session.ended', { reason: 'presence_left' }, { sid: 'session-a' });
    assert.equal(h.results[0].success, false);
  }
});

test('presence-left evidence never crosses session, socket or invalid event context', () => {
  for (const context of [{ sid: 'other-session' }, { sid: 'session-a', cid: 'turn-a' }, {}]) {
    const h = harness(); h.ready(); h.audio(100);
    h.emit(150, 'session.end', { reason: 'presence_left' }, context, 'send');
    h.emit(200, 'session.ended', {}, { sid: 'session-a' });
    assert.equal(h.results[0].success, false);
  }
  const h = harness(); h.ready(); h.audio(100);
  h.tracker.connect('other-socket', WS);
  h.emit(120, 'instance.ready', {}, {}, 'receive', 'other-socket');
  h.emit(130, 'session.started', { ready: true }, { sid: 'session-a' }, 'receive', 'other-socket');
  h.emit(150, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send', 'other-socket');
  h.emit(200, 'session.ended', {}, { sid: 'session-a' });
  assert.equal(h.results[0].success, false);

  const replacement = harness(); replacement.ready(); replacement.audio(100);
  replacement.emit(150, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
  replacement.emit(200, 'session.started', { ready: true }, { sid: 'new-session' });
  replacement.emit(250, 'conversation.user.append', { input: { type: 'text', text: 'test' } },
    { sid: 'new-session', cid: 'new-turn' }, 'send');
  replacement.emit(260, 'session.end', { reason: 'presence_left' }, { sid: 'session-a' }, 'send');
  replacement.emit(300, 'session.ended', {}, { sid: 'new-session' });
  assert.deepEqual(replacement.results.map(r => r.success), [false, false]);
});

test('normal reason parsing respects profile and direction without retaining arbitrary payloads', () => {
  for (const profile of ['guidex-chat-v1', 'runtime-v1-draft']) {
    const payload = { reason: 'presence_left', private_field: 'not retained' };
    const command = wire('session.end', payload, { sid: 's' }, 'send', profile);
    const confirmation = wire('session.ended', payload, { sid: 's' }, 'receive', profile);
    assert.equal(decode(command, 'send', profile).reason, 'presence_left');
    assert.equal(decode(confirmation, 'receive', profile).reason, 'presence_left');
    assert.equal(Object.hasOwn(decode(confirmation, 'receive', profile), 'private_field'), false);
    assert.equal(decode(command, 'receive', profile), null);
    assert.equal(decode(confirmation, 'send', profile), null);
  }
});
