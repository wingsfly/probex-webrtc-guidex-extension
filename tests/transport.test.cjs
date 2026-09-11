const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
global.crypto ??= webcrypto;
const { createClient } = require('../transport.js');
const source = fs.readFileSync(path.join(__dirname, '../content-script.js'), 'utf8');

function fixture({ timeout = 60, replay = false } = {}) {
  const listeners = new Set(), calls = [], messages = [], contexts = [];
  const window = {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    postMessage(data) {
      messages.push(data);
      queueMicrotask(() => {
        for (const fn of [...listeners]) fn({ source: window, data });
        if (replay && data.type === 'probex-fetch-request-v2')
          for (const fn of [...listeners]) fn({ source: window, data });
      });
    },
  };
  function addBridge({ invalidated = false, delay = 0, status = 200, never = false } = {}) {
    const state = { invalidated, storageListeners: new Set() };
    const context = vm.createContext({ window, crypto: webcrypto, location: { origin: 'http://test.invalid' },
      chrome: {
        storage: {
          local: { get(keys, cb) { cb({}); }, set() {} },
          onChanged: { addListener(fn) { state.storageListeners.add(fn); }, removeListener(fn) { state.storageListeners.delete(fn); } },
        },
        runtime: { sendMessage(msg) {
          if (state.invalidated) throw new Error('Extension context invalidated.');
          if (msg.type === 'probex-bridge-ping-v2') return Promise.resolve({ ok: true });
          calls.push({ path: 'extension', body: msg.body });
          if (never) return new Promise(() => {});
          return new Promise(resolve => setTimeout(() => resolve({ ok: status === 200, status }), delay));
        } },
      },
    });
    vm.runInContext(source, context); contexts.push(context);
    return { state, reinject() { vm.runInContext(source, context); } };
  }
  const client = createClient({ window, discoveryTimeout: 20, requestTimeout: timeout,
    fetch: async (url, opts) => { calls.push({ path: 'page', body: opts.body }); return { ok: true, status: 200 }; },
  });
  const send = () => client('https://test.invalid/push', { method: 'POST', body: '{"results":[{"result_id":"stable","success":true}]}' });
  return { window, listeners, calls, messages, addBridge, send };
}

test('single live bridge sends once, with no page fallback', async () => {
  const f = fixture(); f.addBridge();
  assert.equal((await f.send()).ok, true);
  assert.deepEqual(f.calls.map(c => c.path), ['extension']);
});

test('same-world reinjection adds no listeners and forwards once', async () => {
  const f = fixture(); const bridge = f.addBridge(); const count = f.listeners.size;
  bridge.reinject(); bridge.reinject();
  assert.equal(f.listeners.size, count);
  assert.equal(bridge.state.storageListeners.size, 1);
  await f.send(); assert.equal(f.calls.length, 1);
});

test('invalidated old bridge retires silently while live bridge reports once', async () => {
  const f = fixture(); const old = f.addBridge({ invalidated: true }); f.addBridge({ delay: 15 });
  // Reproduce the old v1 failure response without allowing it to settle v2 RPC.
  f.window.addEventListener('message', e => {
    if (e.data.type === 'probex-fetch-request-v2')
      f.window.postMessage({ type: 'probex-fetch-response', id: e.data.id, status: 0 });
  });
  await f.send();
  assert.deepEqual(f.calls.map(c => c.path), ['extension']);
  assert.equal(old.state.storageListeners.size, 0);
});

test('multiple live isolated worlds select only one bridge', async () => {
  const f = fixture(); f.addBridge(); f.addBridge();
  await f.send(); assert.equal(f.calls.length, 1);
});

test('duplicate dispatch message shares one in-flight request', async () => {
  const f = fixture({ replay: true }); f.addBridge({ delay: 10 });
  await f.send(); assert.equal(f.calls.length, 1);
});

test('no bridge falls back before issuing any proxy POST', async () => {
  const f = fixture(); await f.send();
  assert.deepEqual(f.calls.map(c => c.path), ['page']);
  assert.equal(f.messages.some(m => m.type === 'probex-fetch-request-v2'), false);
});

test('only invalidated bridge permits safe discovery fallback', async () => {
  const f = fixture(); f.addBridge({ invalidated: true }); await f.send();
  assert.deepEqual(f.calls.map(c => c.path), ['page']);
});

test('late discovery response cannot dispatch after direct fallback', async () => {
  const f = fixture();
  f.window.addEventListener('message', e => {
    if (e.data.type === 'probex-bridge-discover-v2')
      setTimeout(() => f.window.postMessage({ type: 'probex-bridge-ready-v2', id: e.data.id, bridgeId: 'late' }), 30);
  });
  await f.send(); await new Promise(r => setTimeout(r, 35));
  assert.deepEqual(f.calls.map(c => c.path), ['page']);
  assert.equal(f.messages.some(m => m.type === 'probex-fetch-request-v2'), false);
});

test('timeout after dispatch never starts page fallback, even on late success', async () => {
  const f = fixture({ timeout: 20 }); f.addBridge({ delay: 40 });
  await assert.rejects(f.send(), /outcome unknown/);
  await new Promise(r => setTimeout(r, 45));
  assert.deepEqual(f.calls.map(c => c.path), ['extension']);
});

test('network error after dispatch does not retry through the page', async () => {
  const f = fixture(); f.addBridge({ status: 0 });
  await assert.rejects(f.send(), /outcome unknown/);
  assert.deepEqual(f.calls.map(c => c.path), ['extension']);
});

test('HTTP rejection is returned without a second POST', async () => {
  const f = fixture(); f.addBridge({ status: 503 });
  assert.equal((await f.send()).status, 503); assert.equal(f.calls.length, 1);
});

test('unselected bridge cannot settle an in-flight request', async () => {
  const f = fixture(); f.addBridge({ delay: 10 });
  f.window.addEventListener('message', e => {
    if (e.data.type === 'probex-fetch-request-v2')
      f.window.postMessage({ type: 'probex-fetch-response-v2', id: e.data.id, bridgeId: 'wrong', status: 503 });
  });
  assert.equal((await f.send()).status, 200); assert.equal(f.calls.length, 1);
});

test('bridge invalidated after discovery fails without a competing page POST', async () => {
  const f = fixture(); const bridge = f.addBridge();
  f.window.addEventListener('message', e => {
    if (e.data.type === 'probex-bridge-ready-v2') bridge.state.invalidated = true;
  });
  await assert.rejects(f.send(), /outcome unknown/);
  assert.equal(f.calls.length, 0);
  assert.equal(bridge.state.storageListeners.size, 0);
  await f.send();
  assert.deepEqual(f.calls.map(c => c.path), ['page']);
});

test('direct transport has a timeout so an offline request does not stall its queue', async () => {
  const listeners = [];
  const window = { addEventListener(type, fn) { listeners.push(fn); }, postMessage() {} };
  const client = createClient({ window, discoveryTimeout: 1, requestTimeout: 5,
    fetch: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(client('https://test.invalid/push', { method: 'POST' }), /aborted/);
});
