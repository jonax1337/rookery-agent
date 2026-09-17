import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnHub } from '../dist/services/turns.js';

/**
 * The turn hub: routing without ownership.
 *
 * What a rejoin stands on: a socket that attaches hears the turn of that
 * conversation from its own position onward; a socket that leaves ends
 * nothing; an `abort` from any connection - including one that only re-joined
 * - is the one way a turn stops early. And every event frame carries the
 * journal position, so a client can merge live frames onto a REST replay
 * without assuming continuity.
 */

const OPEN = 1;

/** A websocket that records what it was sent. */
function fakeSocket() {
  const frames = [];
  return {
    readyState: OPEN,
    frames,
    send(raw) {
      frames.push(JSON.parse(raw));
    },
  };
}

/** A generator that emits what a test pushes, and ends when told to. */
function scriptedTurn() {
  const queue = [];
  let wake = () => {};
  let ended = false;
  const events = (async function* () {
    while (true) {
      while (queue.length) yield queue.shift();
      if (ended) return;
      await new Promise((resolve) => (wake = resolve));
    }
  })();
  return {
    events,
    emit(event) {
      queue.push(event);
      const resume = wake;
      wake = () => {};
      resume();
    },
    end() {
      ended = true;
      const resume = wake;
      wake = () => {};
      resume();
    },
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };
const text = (delta) => ({ type: 'text', delta });

test('an attached socket hears the running turn, numbered like the journal', async () => {
  const hub = new TurnHub(log);
  const script = scriptedTurn();
  const controller = new AbortController();
  const starter = fakeSocket();

  hub.start({ id: 't1', sessionId: 's1', controller, events: script.events });
  hub.attach('s1', starter);

  assert.deepEqual(starter.frames.at(-1), { type: 'attached', id: 't1', seq: 0 }, 'the reply names the turn');

  script.emit(text('one'));
  script.emit(text('two'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const late = fakeSocket();
  hub.attach('s1', late);
  assert.equal(late.frames.at(-1).seq, 2, 'a late attacher is told where the turn already stands');

  script.emit(text('three'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The starter saw the whole turn; the late attacher saw its live tail - the
  // events before its position are the REST replay's job, which is exactly
  // why the attached reply said where the turn stood.
  const starterFrames = starter.frames.filter((frame) => frame.type === 'event');
  assert.deepEqual(
    starterFrames.map((frame) => [frame.seq, frame.event.delta]),
    [
      [1, 'one'],
      [2, 'two'],
      [3, 'three'],
    ],
    'the starter saw the whole turn, journal-numbered',
  );
  const lateFrames = late.frames.filter((frame) => frame.type === 'event');
  assert.deepEqual(
    lateFrames.map((frame) => [frame.seq, frame.event.delta]),
    [[3, 'three']],
    'the late attacher saw only what came after its position',
  );

  script.end();
});

test('a socket that attaches to nothing running is told so, plainly', async () => {
  const hub = new TurnHub(log);
  const socket = fakeSocket();
  hub.attach('s-empty', socket);
  assert.deepEqual(socket.frames, [{ type: 'attached', id: null, seq: 0 }]);
});

test('a leaving socket ends nothing; an abort from any connection stops the turn', async () => {
  const hub = new TurnHub(log);
  const script = scriptedTurn();
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener('abort', () => (aborted = true));

  const watcher = fakeSocket();
  hub.start({ id: 't2', sessionId: 's2', controller, events: script.events });
  hub.attach('s2', watcher);

  // The watcher walks away (tab closed). The turn must keep going.
  hub.detach(watcher);
  script.emit(text('still here'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(watcher.frames.filter((frame) => frame.type === 'event').length, 0, 'the gone socket hears nothing');
  assert.equal(hub.has('t2'), true, 'but the turn itself never noticed');

  // A different connection - one that only re-joined elsewhere - aborts it.
  assert.equal(hub.abort('t2'), true);
  assert.equal(aborted, true, 'the AbortController the starter owns fired');
  // The generator honours the signal and runs out, like assistant.chat does;
  // the hub then forgets the turn.
  script.end();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hub.abort('t2'), false, 'a settled turn cannot be aborted twice');
});
