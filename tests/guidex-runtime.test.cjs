const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTracker, decode, connectionInfo, schema } = require('../guidex-runtime.js');

// Synthetic fixtures reflecting chat-wire.ts/runtime-wire-codec.ts, no captured conversations.
const WS = 'ws://localhost/chat/api/chat/aichain/instance-a?runId=sample';
const control = new Set(['instance.open', 'instance.ready', 'instance.closed', 'session.start',
  'session.started', 'session.ended', 'event.user_speech_stopped', 'event.interrupt',
  'event.interrupted', 'avatar.speak.started', 'avatar.speak.ended', 'error']);
function wire(event, payload = {}, context = {}, direction = 'receive', profile = 'guidex-chat-v1') {
  return JSON.stringify({
    header: { version: '1.0', event, channel: control.has(event) ? 'control' : 'data',
      sendAt: 1800000000000, context: { instanceId: 'instance-a', ...context } },
    payload: direction === 'receive' && profile === 'guidex-chat-v1' ? { data: payload } : payload,
  });
}
function harness(options = {}) {
  let time = 0;
  const results = [];
  const tracker = createTracker({ now: () => time, onResult: r => results.push(r), ...options });
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
  assert.equal(decode(raw, 'receive', 'guidex-chat-v1').textLength, 4);
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
  assert.equal(m.success, true); assert.equal(m.total_interaction_ms, 850);
  assert.equal(m.audio_upload_window_ms, 60); assert.equal(m.audio_bytes, 8);
  assert.equal(m.ws_connect_ms, 10); assert.equal(m.instance_register_ms, 20); assert.equal(m.session_start_ms, 30);
  assert.equal(m.audio_start_to_first_asr_ms, 150); assert.equal(m.speech_stop_to_final_asr_ms, 50);
  assert.equal(m.speech_stop_to_first_answer_ms, 150); assert.equal(m.avatar_speak_duration_ms, 400);
  assert.equal(m.answer_stream_ms, 200); assert.equal(m.cid_end_ms, 500); assert.equal(m.answer_characters, 6);
  assert.equal(m.click_to_first_audio_ms, null);
});

test('STT final and cid_end cannot close an audio input or invent model/playback final', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(200, 'stt.result', { text: 'x', isFinal: true }); h.event(220, 'event.cid_end');
  h.answer(300, true); h.event(400, 'avatar.speak.ended');
  assert.equal(h.results.length, 0);
  h.event(500, 'event.user_speech_stopped');
  assert.equal(h.results[0].speech_stop_to_final_asr_ms, -300);
  assert.equal(h.results[0].avatar_speak_duration_ms, null);
});

test('empty final append retains accumulated answer, replace and postprocess are handled', () => {
  const h = harness(); h.ready(); h.text(100);
  h.answer(110, false, 'turn-a', 'abc'); h.answer(120, false, 'turn-a', 'def');
  h.event(130, 'nlu.answer', { operation: 'replace', text: 'xy', format: 'plain_text' });
  h.answer(140, true, 'turn-a', '');
  h.event(150, 'nlu.postprocess', { status: 'completed', finalText: 'late replacement', format: 'plain_text' });
  h.event(200, 'avatar.speak.ended');
  assert.equal(h.results[0].answer_characters, 2);
  assert.equal(h.results[0].model_complete_ms, 40);
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
  h.event(180, 'event.user_speech_stopped'); h.answer(200, true); h.event(250, 'avatar.speak.ended');
  assert.equal(h.results[0].asr_recognized, false); assert.equal(h.results[0].asr_final, false);
  assert.equal(h.results[0].stt_revocations, 1); assert.equal(h.results[0].speech_stop_to_final_asr_ms, null);
});

test('interrupt request is not confirmation; empty explicit stages is a no-op', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.emit(150, 'event.interrupt', { scope: ['nlu', 'avatar'] }, h.context('turn-a'), 'send');
  h.event(160, 'event.interrupted', { stages: [] }); assert.equal(h.results.length, 0);
  h.event(170, 'event.interrupted', {});
  assert.equal(h.results[0].completion_reason, 'interrupted');
  assert.equal(h.results[0].input_ended, false); assert.equal(h.results[0].total_interaction_ms, null);
  h.event(180, 'avatar.speak.ended'); assert.equal(h.results.length, 1);
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
  assert.equal(h.results[1].completion_reason, 'timeout'); assert.equal(h.results[1].total_interaction_ms, null);
  h.text(1400, 'c'); h.event(1500, 'error', { scope: 'conversation', code: 'MODEL_FAILED' }, 'c');
  assert.equal(h.results[2].error_code, 'MODEL_FAILED'); assert.equal(h.results[2].success, false);
});

test('disabled collection discards turns but observes session lifecycle for re-enable', () => {
  const h = harness(); h.ready(); h.audio(100); h.tracker.setEnabled(false); h.text(150);
  assert.equal(h.tracker.snapshot().activeTurns, 0); assert.equal(h.results.length, 0);
  h.tracker.setEnabled(true); h.text(200, 'b'); h.answer(300, true, 'b'); h.event(400, 'avatar.speak.ended', {}, 'b');
  assert.equal(h.results.length, 1);
});

test('observer keeps scalar metrics, not prompts, ASR text, PCM, tokens or RTC descriptions', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.event(200, 'stt.result', { text: 'PRIVATE_TRANSCRIPT', isFinal: true, token: 'SECRET_TOKEN' });
  h.event(220, 'event.user_speech_stopped'); h.answer(300, true, 'turn-a', 'PRIVATE_ANSWER');
  h.event(400, 'avatar.speak.ended', { streamInfo: { auth: 'RTC_SECRET' } });
  const json = JSON.stringify(h.tracker.snapshot());
  for (const value of ['PRIVATE_TRANSCRIPT', 'PRIVATE_ANSWER', 'SECRET_TOKEN', 'RTC_SECRET', 'AAAAAA=='])
    assert.equal(json.includes(value), false);
  const names = schema.extra_fields.map(f => f.name);
  for (const field of Object.keys(h.results[0])) assert.ok(names.includes(field), field);
  for (const field of ['audio_end_to_tts_ms', 'lip_move_ms', 'audio_end_to_playback_ms']) assert.equal(names.includes(field), false);
});

test('auto-test timing annotation preserves native ids and event timestamps', () => {
  const h = harness(); h.ready(); h.audio(100);
  h.tracker.annotate('socket', { instanceId: 'instance-a', ...h.context('turn-a') }, { clickAt: 90, cycle: 1, durationMs: 80 });
  h.tracker.annotate('socket', { instanceId: 'instance-a', ...h.context('turn-a') }, { audioEnd: 190 });
  h.event(200, 'event.user_speech_stopped'); h.answer(210, true);
  h.event(230, 'avatar.speak.started'); h.event(400, 'avatar.speak.ended');
  assert.equal(h.results[0].click_to_first_audio_ms, 10); assert.equal(h.results[0].test_audio_to_avatar_start_ms, 40);
  assert.equal(h.results[0].interaction_mode, 'auto-test'); assert.equal(h.results[0].cid, 'turn-a');
});
