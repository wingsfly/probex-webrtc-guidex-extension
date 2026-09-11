const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function page({ microphone = true } = {}) {
  const context = vm.createContext({ URL, Blob, AbortController, queueMicrotask, atob, crypto: require('node:crypto').webcrypto, console: { log() {}, debug() {}, warn() {}, error() {} } });
  vm.runInContext(`
    var window = globalThis, time = 0, requests = [], sent = [], timers = new Map(), nextTimer = 0, audioContexts = 0;
    var pushStatus = 200, holdPush = false, heldRequests = [];
    var location = { href: 'http://localhost/#/interaction-app/test?token=URL_SECRET' };
    var performance = { now: () => time };
    class Events {
      listeners = new Map();
      addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
      removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
      emit(name, data) { for (const fn of this.listeners.get(name) || []) fn({ data, source: window }); }
    }
    const bus = new Events();
    window.addEventListener = bus.addEventListener.bind(bus);
    window.postMessage = data => {
      if (data.type === 'probex-bridge-discover-v2') {
        bus.emit('message', { type: 'probex-bridge-ready-v2', id: data.id, bridgeId: 'test-bridge' });
      } else if (data.type === 'probex-fetch-request-v2') {
        requests.push(data);
        if (holdPush && data.url.endsWith('/push')) { heldRequests.push(data); return; }
        const status = data.url.endsWith('/push') ? pushStatus : 200;
        bus.emit('message', { type: 'probex-fetch-response-v2', id: data.id, bridgeId: data.bridgeId, ok: status === 200, status });
      } else bus.emit('message', data);
    };
    var setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms, interval: false }); return id; };
    var clearTimeout = id => timers.delete(id);
    var setInterval = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms, interval: true }); return id; };
    var clearInterval = clearTimeout;
    class WebSocket extends Events {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      constructor(url) { super(); this.url = String(url); }
      send(data) { if (this.readyState !== 1) throw new Error('socket not open'); sent.push(data); }
      close() { this.readyState = 3; this.emit('close'); }
    }
    window.WebSocket = WebSocket;
    class Track { kind = 'audio'; readyState = 'live'; stop() { this.readyState = 'ended'; } clone() { return new Track(); } }
    class MediaStream {
      constructor(tracks = []) { this.tracks = tracks; }
      addTrack(t) { this.tracks.push(t); }
      getTracks() { return this.tracks; }
      getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
      getVideoTracks() { return []; }
    }
    class AudioContext {
      constructor() { audioContexts++; }
      state = 'running';
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createMediaStreamDestination() { return { stream: new MediaStream([new Track()]) }; }
      createGain() { return { gain: { value: 1 }, connect() {} }; }
      resume() { return Promise.resolve(); }
      decodeAudioData() { return Promise.resolve({ duration: 0.1, numberOfChannels: 1, sampleRate: 16000 }); }
      createBufferSource() {
        window.lastAudioSource = { connect() {}, disconnect() {}, start() { this.started = true; }, stop() { this.stopped = true; } };
        return window.lastAudioSource;
      }
    }
    class KeyboardEvent { constructor(type, init) { this.type = type; Object.assign(this, init); } }
    class RTCPeerConnection extends Events { addTrack() {} close() {} }
    window.RTCPeerConnection = RTCPeerConnection;
    var navigator = {};
    var domListeners = new Map(), mutationListeners = [], denyMicrophone = false;
    var document = { location, querySelectorAll: () => [], querySelector: () => null,
      addEventListener(type, fn) { if (!domListeners.has(type)) domListeners.set(type, []); domListeners.get(type).push(fn); } };
    class MutationObserver { constructor(fn) { mutationListeners.push(fn); } observe() {} }
  `, context);
  if (microphone) vm.runInContext(`
    class MediaDevices { async getUserMedia() {
      if (denyMicrophone) { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; }
      window.lastNativeStream = new MediaStream([new Track()]);
      return window.lastNativeStream;
    } }
    window.MediaDevices = MediaDevices;
    navigator.mediaDevices = new MediaDevices();
  `, context);
  // Manifest order is the same path used by Chrome document_start.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  for (const file of manifest.content_scripts.find(x => x.world === 'MAIN').js)
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return { context, run: js => vm.runInContext(js, context) };
}
const setup = `
  window.postMessage({ type: 'probex-config', enabled: true, guidexProfile: 'auto', agentId: 'test-agent' });
  var ws = new window.WebSocket('ws://localhost/chat/api/chat/aichain/instance-a?runId=test');
  time = 10; ws.readyState = 1; ws.emit('open');
  function packet(event, payload, context = {}, receive = true) {
    const data = ['conversation.user.append', 'stt.result', 'nlu.answer', 'event.cid_end'].includes(event);
    return JSON.stringify({ header: { version: '1.0', sendAt: 1000, event, channel: data ? 'data' : 'control',
      context: { instanceId: 'instance-a', ...context } }, payload: receive ? { data: payload } : payload });
  }
  ws.send(packet('instance.open', {}, {}, false));
  time = 20; ws.emit('message', packet('instance.ready', {}));
  ws.send(packet('session.start', {}, {}, false));
  time = 30; ws.emit('message', packet('session.started', { ready: true }, { sid: 's' }));
  var round = { sid: 's', cid: 'c' };
`;

test('MAIN scripts intercept native sends, track results and register/push the V4 schema', async () => {
  const p = page(); p.run(setup);
  p.run(`
    time = 100; ws.send(packet('conversation.user.append', { input: { type: 'text', text: 'PRIVATE_PROMPT' } }, round, false));
    time = 200; ws.emit('message', packet('nlu.answer', { operation: 'append', text: 'PRIVATE_ANSWER', format: 'plain_text', final: true }, round));
    time = 300; ws.emit('message', packet('avatar.speak.ended', {}, round));
    for (const timer of [...timers.values()]) if (timer.interval && timer.ms === 5000) timer.fn();
  `);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const requests = JSON.parse(p.run('JSON.stringify(requests)'));
  const register = requests.find(r => r.url.endsWith('/probes/register'));
  const push = requests.find(r => r.url.endsWith('/guidex-runtime-v4/push'));
  assert.equal(JSON.parse(register.body).name, 'guidex-runtime-v4');
  const body = JSON.parse(push.body);
  assert.equal(body.agent_id, 'test-agent');
  assert.match(body.node_id, /^pg-/);
  assert.equal(body.results[0].latency_ms, 200);
  assert.equal(body.results[0].extra.total_interaction, 200);
  assert.equal(body.results[0].extra.start_by, 'first_input');
  assert.ok(Number.isFinite(Date.parse(body.results[0].extra.start_at)));
  assert.equal(body.results[0].extra.page_url, 'http://localhost/#/interaction-app/test');
  const registeredSchema = JSON.parse(register.body).output_schema.extra_fields;
  const registeredFields = registeredSchema.map(f => f.name);
  for (const [name, label] of [['answer_stream', 'Answer_Dur'], ['avatar_speak_duration', 'Play_Dur']]) {
    const field = registeredSchema.find(f => f.name === name);
    assert.equal(field.description.split(':')[0], label);
    assert.equal(field.unit, 'ms');
    assert.equal(Object.hasOwn(body.results[0].extra, name), true);
    assert.equal(Object.hasOwn(body.results[0].extra, label), false);
  }
  assert.equal(registeredFields.includes('stt_text'), true);
  for (const field of ['last_audio_to_final_asr', 'last_audio_to_first_answer', 'last_audio_to_avatar_start']) {
    assert.equal(registeredFields.includes(field), true, field);
    assert.equal(body.results[0].extra[field], null, field);
  }
  for (const field of ['ws_connect_ms', 'instance_register_ms', 'session_start_ms',
    'protocol_profile', 'source_evidence', 'press_at', 'timeline_origin', 'start', 'mic_request', 'mic', 'ready',
    'audio_bytes', 'audio_frames', 'audio_upload_window', 'audio_start_to_first_asr',
    'click_to_first_audio', 'input_ended', 'asr_final', 'asr_recognized', 'asr_characters',
    'model_completed', 'model_complete', 'audio_start_to_speech_started', 'speech_stop_to_final_asr', 'speech_stop_to_first_answer',
    'speech_stop_to_avatar_start', 'test_audio_to_avatar_start']) {
    assert.equal(registeredFields.includes(field), false, field);
    assert.equal(Object.hasOwn(body.results[0].extra, field), false, field);
  }
  assert.equal(registeredFields.some(field => field.endsWith('_ms')), false);
  assert.equal(Object.keys(body.results[0].extra).some(field => field.endsWith('_ms')), false);
  assert.equal(JSON.stringify(requests).includes('PRIVATE_ANSWER'), false);
  assert.equal(JSON.stringify(requests).includes('PRIVATE_PROMPT'), false);
  assert.equal(JSON.stringify(requests).includes('URL_SECRET'), false);
  assert.equal(p.run('sent.length'), 3); // Observer never sends business packets.
  assert.equal(p.run('window.__probexStats().runtime.completed'), 1);
});

test('native failed sends are not counted and ordinary sockets pass through untouched', () => {
  const p = page(); p.run(setup);
  assert.throws(() => p.run(`ws.readyState = 3; ws.send(packet('conversation.user.append', { input: { type: 'text', text: 'x' } }, round, false));`));
  assert.equal(p.run('window.__probexStats().runtime.activeTurns'), 0);
  p.run(`var unrelated = new window.WebSocket('ws://localhost/h5'); unrelated.readyState = 1; unrelated.send('unchanged');`);
  assert.equal(p.run('sent.at(-1)'), 'unchanged');
});

test('MAIN reports last-audio intervals using the last successful send, not failed or unrelated sends', async () => {
  const p = page(); p.run(setup);
  p.run(`
    time = 100; ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, round, false));
    time = 150; ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, round, false));
  `);
  assert.throws(() => p.run(`time = 170; ws.readyState = 3;
    ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, round, false));`));
  p.run(`
    ws.readyState = 1;
    time = 180; ws.send(packet('conversation.user.append', {input: {type: 'text', text: 'text'}}, round, false));
    time = 190; ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, {sid: 's', cid: 'other'}, false));
    time = 200; ws.emit('message', packet('event.user_speech_stopped', {}, round));
    time = 220; ws.emit('message', packet('stt.result', {text: 'final', isFinal: true}, round));
    time = 240; ws.emit('message', packet('nlu.answer', {operation: 'append', text: 'answer', format: 'plain_text', final: true}, round));
    time = 260; ws.emit('message', packet('avatar.speak.started', {}, round));
    time = 400; ws.emit('message', packet('avatar.speak.ended', {}, round));
    for (const timer of [...timers.values()]) if (timer.interval && timer.ms === 5000) timer.fn();
  `);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const m = pushes(p, 'guidex-runtime-v4')[0].results[0].extra;
  assert.equal(m.cid, 'c'); assert.equal(m.upload_end, 50);
  assert.deepEqual([m.last_audio_to_final_asr, m.last_audio_to_first_answer, m.last_audio_to_avatar_start], [70, 90, 110]);
});

test('microphone tracks can be stopped and reacquired for successive runtime rounds', async () => {
  const p = page();
  await p.run(`navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => { stream.getAudioTracks()[0].stop(); });`);
  const state = await p.run(`navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getAudioTracks()[0].readyState);`);
  assert.equal(state, 'live');
});

test('missing secure-context microphone API does not prevent passive WS monitoring', () => {
  const p = page({ microphone: false }); p.run(setup);
  assert.equal(p.run('window.__probexStats().runtime.ready'), true);
});

test('Legacy selection disables Runtime business collection without blocking application traffic', () => {
  const p = page(); p.run(setup);
  p.run(`window.postMessage({ type: 'probex-config', enabled: true, guidexProfile: 'legacy' });
    ws.send(packet('conversation.user.append', { input: { type: 'text', text: 'x' } }, round, false));`);
  assert.equal(p.run('window.__probexStats().runtime.activeTurns'), 0);
  assert.equal(p.run('sent.length'), 3);
});

test('manifest and service-worker reinjection both include the protocol adapter first', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.deepEqual(manifest.content_scripts.find(x => x.world === 'MAIN').js, ['transport.js', 'guidex-runtime.js', 'guidex-input.js', 'injected.js']);
  for (const script of manifest.content_scripts.flatMap(x => x.js)) assert.ok(fs.existsSync(path.join(root, script)));
  assert.match(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), /files: \['transport.js', 'guidex-runtime.js', 'guidex-input.js', 'injected.js'\]/);
});

async function startTestPage(hold) {
  const p = page(); p.run(setup);
  p.context.hold = hold;
  p.run(`
    var button = {
      pressed: false,
      getAttribute(name) { return name === 'aria-pressed' ? String(this.pressed) : null; },
      start() {
        if (this.pressed) return;
        this.pressed = true;
        ws.send(packet('conversation.user.append', { items: [{ type: 'audio', data: 'AAAAAA==' }] }, round, false));
      },
      click() { if (!hold) { if (this.pressed) this.pressed = false; else this.start(); } },
      dispatchEvent(e) {
        if (e.key === 'Escape') this.pressed = false;
        else if (hold && e.type === 'keydown') this.start();
        else if (hold && e.type === 'keyup') this.pressed = false;
      },
    };
    document.querySelector = () => button;
    window.postMessage({ type: 'probex-audio', dataUrl: 'data:audio/wav;base64,AAAA' });
    time = 100;
    window.postMessage({ type: 'probex-autotest-start', selector: '.gx-microphone', interval: 30 });
    window.postMessage({ type: 'probex-autotest-start', selector: '.gx-microphone', interval: 30 });
  `);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  return p;
}

for (const hold of [false, true]) test('v4 auto-test uses native input (' + (hold ? 'hold' : 'click') + ')', async () => {
  const p = await startTestPage(hold);
  assert.equal(p.run('window.lastAudioSource.started'), true);
  assert.equal(p.run('sent.length'), 3); // Two setup packets plus app audio. No extension WS audio/end packets.
  p.run(`time = 200; window.lastAudioSource.onended();
    time = 210; ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, round, false));
    time = 250; ws.emit('message', packet('event.user_speech_stopped', {}, round));
    time = 300; ws.emit('message', packet('nlu.answer', { operation: 'append', text: '', format: 'plain_text', final: true }, round));
    time = 350; ws.emit('message', packet('avatar.speak.started', {}, round));
    time = 400; ws.emit('message', packet('avatar.speak.ended', {}, round));`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(p.run('window.__probexStats().runtime.lastResult.interaction_mode'), 'auto-test');
  assert.equal(p.run('window.__probexStats().runtime.lastResult.test_audio_duration'), 100);
  assert.equal(p.run('window.__probexStats().runtime.lastResult.last_audio_to_avatar_start'), 140);
  assert.equal(p.run("Object.hasOwn(window.__probexStats().runtime.lastResult, 'test_audio_to_avatar_start')"), false);
  p.run(`window.postMessage({ type: 'probex-autotest-stop' });`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(p.run('window.__probexStats().autoTest.running'), false);
  assert.equal(p.run('[...timers.values()].filter(t => !t.interval && t.ms === 30000).length'), 0);
});

test('v4 stop during audio cancels its own capture and source', async () => {
  const p = await startTestPage(false);
  p.run(`window.postMessage({type: 'probex-autotest-stop'});`);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(p.run('window.lastAudioSource.stopped'), true);
  assert.equal(p.run('button.pressed'), false);
  assert.equal(p.run('window.__probexStats().autoTest.running'), false);
});

test('MAIN script binds trusted gesture, real acquisition and DOM readiness to native audio cid', async () => {
  const p = page(); p.run(setup);
  p.run(`
    var waiting = true;
    var mic = { pressed: false, isConnected: true, disabled: false,
      getAttribute: name => name === 'aria-pressed' ? String(mic.pressed) : null,
      querySelector: () => ({ classList: { contains: () => waiting } }),
      closest: selector => selector === '.gx-input' ? panel : mic };
    var panel = { isConnected: true, getClientRects: () => [1],
      classList: { contains: () => false }, querySelector: () => mic };
    document.querySelectorAll = () => [panel];
    time = 40;
    for (const fn of domListeners.get('pointerdown')) fn({ target: mic, type: 'pointerdown', isTrusted: true, isPrimary: true, button: 0 });
    mic.pressed = true;
    time = 60;
  `);
  await p.run('navigator.mediaDevices.getUserMedia({audio: true})');
  p.run(`
    time = 100; ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, round, false));
    time = 110; waiting = false; for (const fn of mutationListeners) fn();
    time = 200; ws.emit('message', packet('event.user_speech_stopped', {}, round));
    time = 250; ws.emit('message', packet('nlu.answer', {operation: 'append', text: 'sample', format: 'plain_text', final: true}, round));
    time = 300; ws.emit('message', packet('avatar.speak.started', {}, round));
    time = 500; ws.emit('message', packet('avatar.speak.ended', {}, round));
    for (const timer of [...timers.values()]) if (timer.interval && timer.ms === 5000) timer.fn();
  `);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const requests = JSON.parse(p.run('JSON.stringify(requests)'));
  const push = requests.find(r => r.url.endsWith('/guidex-runtime-v4/push'));
  const m = JSON.parse(push.body).results[0].extra;
  assert.equal(m.input_source, 'browser_mic'); assert.equal(m.press_kind, 'pointer');
  assert.equal(m.mic_ready, 70);
  for (const key of ['start', 'mic_request', 'mic', 'ready']) assert.equal(Object.hasOwn(m, key), false);
  assert.equal(m.upload, 60); assert.equal(m.speak_end, 460);
  assert.equal(m.interaction_mode, 'passive'); assert.equal(m.cid, 'c');
  assert.equal(p.run('sent.length'), 3);
});

test('passive v4 capture returns native stream identity without constructing a mixer', async () => {
  const p = page(); p.run(setup);
  assert.equal(await p.run(`navigator.mediaDevices.getUserMedia({audio: true}).then(stream => {
    const same = stream === lastNativeStream;
    stream.getAudioTracks()[0].stop();
    return same && lastNativeStream.getAudioTracks()[0].readyState === 'ended';
  })`), true);
  assert.equal(p.run('audioContexts'), 0);
  assert.equal(await p.run(`navigator.mediaDevices.getUserMedia({audio: true}).then(stream =>
    stream === lastNativeStream && stream.getAudioTracks()[0].readyState === 'live')`), true);
});

test('MAIN scripts push interruption as success with timestamps on the old round only', async () => {
  const p = page(); p.run(setup);
  p.run(`
    time = 100; ws.send(packet('conversation.user.append', {input: {type: 'text', text: 'sample'}}, round, false));
    time = 200; ws.send(packet('event.interrupt', {}, round, false));
    time = 210; ws.send(packet('conversation.user.append', {input: {type: 'text', text: 'next'}}, {sid:'s', cid:'new'}, false));
    time = 250; ws.emit('message', packet('event.interrupted', {stages:['avatar']}, round));
    for (const timer of [...timers.values()]) if (timer.interval && timer.ms === 5000) timer.fn();
  `);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const requests = JSON.parse(p.run('JSON.stringify(requests)'));
  const push = requests.find(r => r.url.endsWith('/guidex-runtime-v4/push'));
  const row = JSON.parse(push.body).results[0];
  assert.equal(row.success, true); assert.equal(row.latency_ms, 150);
  assert.equal(row.extra.cid, 'c'); assert.equal(row.extra.completion_reason, 'interrupted');
  assert.equal(row.extra.interrupt, 100); assert.equal(row.extra.interrupted, 150);
  assert.equal(row.extra.interrupt_ack, 50);
  assert.ok(Number.isFinite(Date.parse(row.extra.interrupt_at)));
  assert.ok(Number.isFinite(Date.parse(row.extra.interrupted_at)));
  assert.equal(row.extra.speak_end, null);
  assert.equal(p.run('window.__probexStats().runtime.activeTurns'), 1);
});

test('interrupted auto-test completes its result but stops owned synthetic audio and capture', async () => {
  const p = await startTestPage(false);
  p.run(`time = 200; ws.emit('message', packet('event.interrupted', {stages:['avatar']}, round));`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(p.run('window.__probexStats().runtime.lastResult.success'), true);
  assert.equal(p.run('window.__probexStats().runtime.lastResult.completion_reason'), 'interrupted');
  assert.equal(p.run('button.pressed'), false);
  assert.equal(p.run('window.lastAudioSource.stopped'), true);
  p.run(`window.postMessage({type: 'probex-autotest-stop'});`);
});

test('passive Runtime capture preserves native microphone denial instead of returning silent success', async () => {
  const p = page(); p.run(setup); p.run('denyMicrophone = true');
  await assert.rejects(p.run('navigator.mediaDevices.getUserMedia({audio: true})'), { name: 'NotAllowedError' });
  assert.equal(p.run('window.__probexStats().runtime.activeTurns'), 0);
});

test('DOM observer failure does not break native microphone acquisition or business tracking', async () => {
  const p = page(); p.run(setup);
  p.run(`document.querySelectorAll = () => { throw new Error('unmounted'); };`);
  await p.run('navigator.mediaDevices.getUserMedia({audio: true})');
  p.run(`ws.send(packet('conversation.user.append', {items: [{type: 'audio', data: 'AAAAAA=='}]}, round, false));`);
  assert.equal(p.run('window.__probexStats().runtime.activeTurns'), 1);
});

async function drain() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function tick(p, ms) {
  p.run(`for (const timer of [...timers.values()]) if (timer.interval && timer.ms === ${ms}) timer.fn();`);
}
function pushes(p, name) {
  return JSON.parse(p.run('JSON.stringify(requests)')).filter(r => r.url.endsWith('/' + name + '/push')).map(r => JSON.parse(r.body));
}
function completeRuntime(p, cid = 'c') {
  p.run(`
    time = 100; ws.send(packet('conversation.user.append', { input: { type: 'text', text: 'test' } }, { sid: 's', cid: '${cid}' }, false));
    time = 150; ws.emit('message', packet('nlu.answer', { operation: 'append', text: 'test', format: 'plain_text', final: true }, { sid: 's', cid: '${cid}' }));
    time = 200; ws.emit('message', packet('avatar.speak.ended', {}, { sid: 's', cid: '${cid}' }));
  `);
}
function completeLegacy(p) {
  p.run(`
    time = 100;
    var legacy = new window.WebSocket('ws://localhost/voiceDictation'); legacy.readyState = 1;
    legacy.send(JSON.stringify({ status: 1, message: 'AAAA' }));
    time = 200; legacy.send(JSON.stringify({ status: 2, message: '' }));
    for (const timer of [...timers.values()]) if (!timer.interval && timer.ms === 45000) timer.fn();
  `);
}
async function sampleWebrtc(p) {
  p.run(`var rtc = new window.RTCPeerConnection(); rtc.getStats = async () => new Map([
    ['a', { id: 'a', type: 'inbound-rtp', kind: 'audio', jitter: 0.002, packetsLost: 0, packetsReceived: 10 }]
  ]);`);
  tick(p, 500); await drain(); tick(p, 2000);
}

for (const kind of ['runtime', 'legacy', 'webrtc']) {
  test(kind + ' retries preserve result_id and timestamp without overlapping pushes', async () => {
    const p = page(); p.run(setup); p.run('pushStatus = 0;');
    const name = kind === 'runtime' ? 'guidex-runtime-v4' : kind === 'legacy' ? 'guidex-interaction' : 'webrtc-browser';
    if (kind === 'runtime') completeRuntime(p);
    if (kind === 'legacy') completeLegacy(p);
    if (kind === 'webrtc') await sampleWebrtc(p);
    tick(p, 5000); await drain();
    const first = pushes(p, name);
    assert.equal(first.length, 1);
    assert.match(first[0].results[0].result_id, /^[a-f0-9]{32}$/);
    p.run('pushStatus = 200; holdPush = true;'); tick(p, 5000); await drain();
    tick(p, 5000); tick(p, 5000); await drain();
    const pending = pushes(p, name);
    assert.equal(pending.length, 2);
    assert.deepEqual(pending[0], pending[1]);
    p.run(`holdPush = false; for (const data of heldRequests.splice(0))
      bus.emit('message', { type: 'probex-fetch-response-v2', id: data.id, bridgeId: data.bridgeId, ok: true, status: 200 });`);
    await drain(); tick(p, 5000); await drain();
    assert.equal(pushes(p, name).length, 2);
  });
}

test('Runtime distinct turns with identical metrics get different result IDs', async () => {
  const p = page(); p.run(setup); completeRuntime(p, 'c1'); completeRuntime(p, 'c2');
  tick(p, 5000); await drain();
  const rows = pushes(p, 'guidex-runtime-v4')[0].results;
  assert.equal(rows.length, 2); assert.notEqual(rows[0].result_id, rows[1].result_id);
});

test('config change cannot requeue old WebRTC data under a new identity', async () => {
  const p = page(); p.run(setup); await sampleWebrtc(p);
  p.run('holdPush = true;'); tick(p, 5000); await drain();
  p.run(`window.postMessage({ type: 'probex-config', agentId: 'new-agent', hubUrl: 'http://new-hub' });
    holdPush = false; for (const data of heldRequests.splice(0))
      bus.emit('message', { type: 'probex-fetch-response-v2', id: data.id, bridgeId: data.bridgeId, ok: false, status: 0 });`);
  await drain(); tick(p, 5000); await drain();
  assert.equal(pushes(p, 'webrtc-browser').length, 1);
});

test('WebRTC samples in the same millisecond are not merged by timestamp', async () => {
  const p = page(); p.run(setup);
  p.run(`Date = class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-10T04:27:22.989Z'])); } };`);
  await sampleWebrtc(p);
  tick(p, 500); await drain(); tick(p, 2000); tick(p, 5000); await drain();
  const rows = pushes(p, 'webrtc-browser')[0].results;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].timestamp, rows[1].timestamp);
  assert.notEqual(rows[0].result_id, rows[1].result_id);
});

test('native presence-left request plus confirmation reports success with no latency and only once', async () => {
  const p = page(); p.run(setup);
  p.run(`
    time = 100; ws.send(packet('guidance.trigger', { kind: 'farewell' }, round, false));
    time = 110; ws.send(packet('session.end', { reason: 'presence_left' }, { sid: round.sid }, false));
    time = 173; ws.emit('message', packet('session.ended', {}, { sid: round.sid }));
    time = 180; ws.emit('message', packet('session.ended', {}, { sid: round.sid }));
    for (const timer of [...timers.values()]) if (timer.interval && timer.ms === 5000) timer.fn();
  `);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const pushes = JSON.parse(p.run('JSON.stringify(requests)')).filter(r => r.url.endsWith('/guidex-runtime-v4/push'));
  const rows = pushes.flatMap(push => JSON.parse(push.body).results);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].success, true);
  assert.equal(rows[0].latency_ms, null);
  assert.equal(rows[0].extra.completion_reason, 'session_ended');
  assert.equal(rows[0].extra.observed, 73);
  assert.equal(rows[0].extra.avatar_ended, false);
});
