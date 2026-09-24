import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installCursor } from '../dist/computer/browser-init.js';
import { CURSOR } from '../dist/computer/cursor.js';

test('cursor eases to exact targets, settles without idle frames, and respects reduced motion', () => {
  const listeners = new Map();
  const frames = [];
  const media = { matches: false };
  let time = 0;
  let pulses = 0;
  let idle;
  const state = { textContent: '' };
  const badge = { style: {}, querySelector: () => state };
  class TestElement {
    getBoundingClientRect() { return { x: 10, y: 20, width: 180, height: 30 }; }
  }
  const cursor = {
    style: {}, isConnected: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    attachShadow() { return { innerHTML: '', appendChild() {}, querySelector: () => ({ animate: () => { pulses++; return { cancel() {} }; } }) }; },
  };
  runInNewContext(`(${installCursor.toString()})(${JSON.stringify(CURSOR)})`, {
    document: {
      createElement: (name) => name === 'rookery-cursor' ? cursor : badge,
      documentElement: { appendChild: () => { cursor.isConnected = true; } },
      addEventListener: (event, handler) => listeners.set(event, handler),
    },
    matchMedia: () => media,
    performance: { now: () => time },
    requestAnimationFrame: (handler) => { frames.push(handler); return 1; },
    window: { innerWidth: 800, innerHeight: 600, setTimeout: (callback) => { idle = callback; return 1; } },
    clearTimeout() {},
    Element: TestElement,
  });
  const move = (x, y, type = 'mousemove') => listeners.get(type)({ clientX: x, clientY: y, type });
  const frame = () => { time += 16; frames.shift()?.(time); };
  const position = () => cursor.style.transform.match(/[\d.]+/g).slice(1, 3).map(Number);

  move(20, 30); frame();
  assert.deepEqual(position(), [20, 30], 'first observation starts at the actual pointer');
  move(400, 220, 'mousedown'); frame();
  const intermediate = position();
  assert.ok(intermediate[0] > 20 && intermediate[0] < 400, 'movement has intermediate positions');
  assert.equal(pulses, 0, 'the click marker must wait until the visible cursor reaches its target');
  for (let i = 0; i < 30 && frames.length; i++) frame();
  assert.deepEqual(position(), [400, 220], 'the tip settles on the exact input coordinate');
  assert.equal(frames.length, 0, 'no animation loop when idle');
  assert.equal(pulses, 1);
  assert.equal(cursor.attributes['aria-hidden'], 'true');
  assert.equal(state.textContent, 'Clicking');
  idle();
  assert.equal(state.textContent, 'Waiting');
  assert.equal(cursor.style.display, 'block', 'the cursor stays visible between model calls');

  media.matches = true;
  move(50, 60, 'mousedown'); frame();
  assert.deepEqual(position(), [50, 60]);
  assert.equal(frames.length, 0);
  assert.equal(pulses, 1, 'reduced motion suppresses the click ripple');
  listeners.get('input')({ type: 'input', target: new TestElement() }); frame();
  assert.deepEqual(position(), [100, 35], 'semantic form filling moves the cursor without a mouse event');
  assert.equal(state.textContent, 'Typing');
  move(790, 590); frame();
  assert.equal(badge.style.left, '-174px');
  assert.equal(badge.style.top, '-30px', 'the badge stays inside the viewport');
});
