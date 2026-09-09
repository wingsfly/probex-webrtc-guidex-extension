const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

function page({ microphone = true } = {}) {
  const context = vm.createContext({ URL, AbortController, queueMicrotask, atob, console: { log() {}, debug() {}, warn() {} } });
  vm.runInContext(`
    var window = globalThis, time = 0, requests = [], sent = [], timers = new Map(), nextTimer = 0;
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
      if (data.type === 'probex-fetch-request') {
        requests.push(data);
        bus.emit('message', { type: 'probex-fetch-response', id: data.id, ok: true, status: 200 });
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
    var document = { querySelectorAll: () => [], querySelector: () => null };
  `, context);
  if (microphone) vm.runInContext(`
    class MediaDevices { async getUserMedia() { return new MediaStream([new Track()]); } }
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
  assert.equal(body.results[0].extra.page_url, 'http://localhost/#/interaction-app/test');
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
  assert.deepEqual(manifest.content_scripts.find(x => x.world === 'MAIN').js, ['guidex-runtime.js', 'injected.js']);
  for (const script of manifest.content_scripts.flatMap(x => x.js)) assert.ok(fs.existsSync(path.join(root, script)));
  assert.match(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), /files: \['guidex-runtime.js', 'injected.js'\]/);
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
    time = 250; ws.emit('message', packet('event.user_speech_stopped', {}, round));
    time = 300; ws.emit('message', packet('nlu.answer', { operation: 'append', text: '', format: 'plain_text', final: true }, round));
    time = 400; ws.emit('message', packet('avatar.speak.ended', {}, round));`);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(p.run('window.__probexStats().runtime.lastResult.interaction_mode'), 'auto-test');
  assert.equal(p.run('window.__probexStats().runtime.lastResult.test_audio_duration_ms'), 100);
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
