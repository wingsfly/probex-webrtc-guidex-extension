const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createObserver } = require('../guidex-input.js');

function fixture() {
  let time = 10, selectedSocket = {}, enabled = true;
  const classes = new Set(), indicators = new Set(['gx-audio-waiting']);
  const indicator = { classList: { contains: key => indicators.has(key) } };
  const button = {
    disabled: false, isConnected: true, pressed: false, busy: false,
    getAttribute: name => name === 'aria-pressed' ? String(button.pressed)
      : name === 'aria-busy' ? String(button.busy) : null,
    querySelector: () => indicator,
    closest: selector => selector === '.gx-input' ? panel : button,
  };
  const panel = { isConnected: true, getClientRects: () => [1],
    classList: { contains: key => classes.has(key) }, querySelector: () => button };
  const panels = [panel], calls = [];
  const document = { location: { href: 'https://example.test/#/interaction-app/r' }, querySelectorAll: () => panels };
  const observer = createObserver({ document, now: () => time, wallNow: () => 1800000000000 + time,
    socket: () => selectedSocket, enabled: () => enabled, annotate: (context, info) => calls.push({ context, info }) });
  const event = (type, extra = {}) => observer.handle({ type, target: button, isTrusted: true,
    isPrimary: true, button: 0, ...extra });
  const context = cid => ({ socketId: selectedSocket, instanceId: 'i', sid: 's', cid, input: 'audio' });
  const capture = () => {
    event('pointerdown'); button.pressed = true; const token = observer.captureRequested();
    time = 30; observer.captureReady(token); return token;
  };
  return { observer, button, panels, document, classes, indicators, calls, event, context, capture,
    time: value => { time = value; }, socket: value => { selectedSocket = value; }, enabled: value => { enabled = value; } };
}

test('real microphone press, acquired mic and UI ready are separate milestones', () => {
  const f = fixture(); f.capture();
  f.time(50); f.observer.turnStarted(f.context('c'));
  assert.equal(f.calls[0].info.source, 'browser_mic');
  assert.equal(f.calls[0].info.pressAt, 10); assert.equal(f.calls[0].info.micAt, 30);
  assert.equal(f.calls[0].info.micRequestAt, 10);
  assert.equal(f.calls[0].info.readyAt, undefined);
  f.time(60); f.indicators.clear(); f.observer.refresh();
  assert.equal(f.calls[1].info.readyAt, 60);
  assert.equal(f.calls[1].info.pressWall, 1800000000010);
});

test('non-portrait microphone uses aria-busy when no waveform indicator is rendered', () => {
  const f = fixture();
  f.button.busy = true;
  f.button.querySelector = () => null;
  f.capture();
  f.observer.turnStarted(f.context('c'));
  assert.equal(f.calls[0].info.readyAt, undefined);
  f.time(40); f.button.busy = false; f.observer.refresh();
  assert.equal(f.calls[1].info.readyAt, 40);
});

test('synthetic UI events and unavailable or non-primary gestures do not become user presses', () => {
  for (const event of [{ isTrusted: false }, { button: 2 }, { isPrimary: false }]) {
    const f = fixture(); f.event('pointerdown', event);
    assert.equal(f.observer.captureRequested(), null);
  }
  const f = fixture(); f.button.disabled = true; f.event('pointerdown');
  assert.equal(f.observer.captureRequested(), null);
});

test('keyboard activation retains initial key time across a native click', () => {
  const f = fixture(); f.event('keydown', { key: 'Enter' }); f.time(20); f.event('click');
  f.button.pressed = true;
  f.observer.captureReady(f.observer.captureRequested()); f.observer.turnStarted(f.context('c'));
  assert.equal(f.calls[0].info.pressAt, 10); assert.equal(f.calls[0].info.pressKind, 'keyboard');
  assert.equal(f.calls[0].info.micRequestAt, 20);
});

test('held key repeats and composition do not start a pending gesture', () => {
  for (const extra of [{ key: 'Enter', repeat: true }, { key: 'Enter', isComposing: true }, { key: 'a' }]) {
    const f = fixture(); f.event('keydown', extra); assert.equal(f.observer.captureRequested(), null);
  }
});

test('click-to-stop is never mistaken for a new start', () => {
  const f = fixture(); f.button.pressed = true; f.event('pointerdown'); f.event('click');
  assert.equal(f.observer.captureRequested(), null);
});

test('multimodal identity comes from explicit Runtime local state, not absence of a press', () => {
  const f = fixture(); f.classes.add('gx-input-local'); f.event('pointerdown');
  f.observer.turnStarted(f.context('box'));
  assert.deepEqual(f.calls[0].info, { source: 'multimodal_box' });
  assert.equal(f.observer.captureRequested(), null);
  f.panels.length = 0; f.observer.turnStarted(f.context('unknown'));
  assert.deepEqual(f.calls[1].info, { source: 'unknown' });
});

test('ambiguous pages or sockets have unknown sources and cannot borrow a press', () => {
  for (const ambiguous of [f => f.panels.push(f.panels[0]), f => f.socket(null)]) {
    const f = fixture(); ambiguous(f); f.event('pointerdown'); f.observer.turnStarted(f.context('c'));
    assert.deepEqual(f.calls[0].info, { source: 'unknown' });
  }
});

test('cancel, timeout, navigation, source switch and disconnect discard pending gestures', () => {
  for (const cancel of [f => f.event('pointercancel'), f => f.event('keydown', { key: 'Escape' }),
    f => f.time(40000), f => { f.document.location.href += '/new'; },
    f => f.classes.add('gx-input-local'), f => f.socket({}), f => f.enabled(false),
    f => { f.button.isConnected = false; }, f => f.observer.clear()]) {
    const f = fixture(); f.capture(); cancel(f); f.observer.turnStarted(f.context('c'));
    assert.equal(f.calls.at(-1).info.pressAt, undefined);
  }
});

test('permission denial and late resolution of a cancelled request cannot annotate the next turn', () => {
  const f = fixture(); f.event('pointerdown'); const token = f.observer.captureRequested();
  f.observer.captureFailed(token); f.observer.captureReady(token); f.observer.turnStarted(f.context('c'));
  assert.equal(f.calls[0].info.pressAt, undefined);
});

test('one captured press cannot be assigned to two cids or leak after completion', () => {
  const f = fixture(); f.capture(); f.observer.turnStarted(f.context('a'));
  f.observer.turnStarted(f.context('b')); assert.equal(f.calls[1].info.pressAt, undefined);
  f.observer.turnEnded({ instance_id: 'i', sid: 's', cid: 'a' });
  f.observer.turnStarted(f.context('c')); assert.equal(f.calls[2].info.pressAt, undefined);
});

test('UI returning to idle before first upload cancels association', () => {
  const f = fixture(); f.capture(); f.observer.refresh(); f.button.pressed = false;
  f.observer.refresh(); f.button.pressed = true; f.observer.turnStarted(f.context('c'));
  assert.equal(f.calls[0].info.pressAt, undefined);
});
