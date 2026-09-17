import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Assistant, ProviderRegistry, Store } from '@rookery/core';
import { buildServer } from '../dist/server.js';

/**
 * The assignment live log over the real server surface: a full buildServer
 * (websocket route, subscriber fan-out, REST snapshot) against a scripted
 * provider, driven by a raw ws client - no inject shortcuts on the socket
 * path, because the point is what actually arrives on the wire.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A provider whose output the test scripts by hand: `push` queues one event
 * for the running turn, `finish` lets the turn end. The assignment stays
 * mid-run for exactly as long as the test wants it to.
 */
function createScriptedProvider() {
  const queue = [];
  const waiters = [];
  let closed = false;
  const wake = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (closed) return;
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
  return {
    provider,
    push(event) {
      queue.push(event);
      wake();
    },
    finish() {
      closed = true;
      wake();
    },
  };
}

async function createFixture() {
  const home = mkdtempSync(join(tmpdir(), 'rookery-log-api-'));
  const script = createScriptedProvider();
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([script.provider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
    },
  });
  const app = await buildServer(assistant, { quiet: true });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'ws://127.0.0.1:' + app.server.address().port + '/ws';
  const org = assistant.org.activeOrganization();
  assistant.store.org.createAgent({ orgId: org.id, name: 'Mara', title: 'Engineer', instructions: 'Do the work.' });
  return { assistant, app, script, base, org, home };
}

async function dispose(fixture) {
  await fixture.app.close();
  fixture.assistant.close();
  rmSync(fixture.home, { recursive: true, force: true });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

/** Every parsed frame a socket receives, plus a bounded wait for one. */
function collect(socket) {
  const frames = [];
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  return {
    frames,
    async until(predicate, what) {
      const deadline = Date.now() + 5000;
      while (!predicate(frames)) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
        await sleep(10);
      }
    },
  };
}

/** The assignment row of the run just started, once the controller has it. */
async function runningAssignment(fixture) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const row = fixture.assistant.store.org
      .listAssignments(fixture.org.id, { status: ['pending', 'running'] })[0];
    if (row) return row;
    if (Date.now() > deadline) throw new Error('assignment never appeared');
    await sleep(10);
  }
}

/**
 * Wait until the server has actually registered the `watch`. Frames are
 * push-only - what happened before the registration is deliberately not
 * replayed on the wire; the client protocol covers that with the REST
 * snapshot - so a test that scripts the very next entry has to let the
 * watch land first. The map is keyed by the server-side socket, which the
 * client never sees, so the check goes by assignment id.
 */
async function untilWatched(app, assignmentId, watched = true) {
  const has = () => [...app.rookery.assignmentWatchers.values()].some((ids) => ids.has(assignmentId));
  const deadline = Date.now() + 5000;
  while (has() !== watched) {
    if (Date.now() > deadline) throw new Error(watched ? 'watch was never registered' : 'unwatch was never registered');
    await sleep(10);
  }
}

test('live-log frames reach only the watching socket, and /log mirrors the buffer', async (t) => {
  const fixture = await createFixture();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
    await dispose(fixture);
  });
  const { assistant, app, script, base } = fixture;

  const events = [];
  const run = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'watch me' })) events.push(event);
  })();
  const assignment = await runningAssignment(fixture);
  script.push({ type: 'text', delta: 'first line' });

  // The REST snapshot: what has happened so far, in order, not overflowed.
  const watcher = await openSocket(base);
  const bystander = await openSocket(base);
  sockets.push(watcher, bystander);
  const watched = collect(watcher);
  const seen = collect(bystander);
  bystander.send(JSON.stringify({ type: 'ping' }));
  await seen.until((frames) => frames.some((frame) => frame.type === 'pong'), 'pong');

  let response = await app.inject({ url: '/api/org/assignments/' + assignment.id + '/log' });
  assert.equal(response.statusCode, 200);
  const snapshot = response.json();
  assert.equal(snapshot.overflowed, false);
  assert.deepEqual(
    snapshot.events.map((entry) => [entry.seq, entry.event.type, entry.event.delta]),
    [[1, 'text', 'first line']],
  );

  // Opting in is per socket: the watcher gets the entries as they happen, a
  // socket that never asked gets nothing of the log - only the broadcasts.
  watcher.send(JSON.stringify({ type: 'watch', assignmentId: assignment.id }));
  await untilWatched(app, assignment.id);
  script.push({ type: 'text', delta: 'second line' });
  await watched.until(
    (frames) => frames.some((frame) => frame.type === 'assignment-log' && frame.seq === 2),
    'frame seq 2 on the watcher',
  );
  await sleep(100);
  const logFrames = seen.frames.filter((frame) => frame.type === 'assignment-log');
  assert.equal(logFrames.length, 0, 'a socket that did not watch gets no live-log frames');
  const frame = watched.frames.find((item) => item.type === 'assignment-log' && item.seq === 2);
  assert.equal(frame.assignmentId, assignment.id);
  assert.deepEqual(frame.event, { type: 'text', delta: 'second line' });

  // End of the run: the run's own broadcast reaches everyone, the buffer is
  // gone, and /log answers from the durable row instead.
  script.push({ type: 'done', text: 'first line second line' });
  script.finish();
  await run;
  await watched.until(
    (frames) => frames.some((item) => item.type === 'assignment' && item.event.assignment?.status === 'done'),
    'the final assignment broadcast',
  );
  assert.ok(
    seen.frames.some((item) => item.type === 'assignment' && item.event.assignment?.status === 'done'),
    'broadcasts still reach the bystander',
  );

  response = await app.inject({ url: '/api/org/assignments/' + assignment.id + '/log' });
  // The journal answers after the end: nothing more is coming, and the
  // transcript stands where the buffer used to vanish.
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().active, false);
  assert.ok(
    response.json().events.some((entry) => entry.event.delta === 'first line'),
    'the transcript is still there in full',
  );

  response = await app.inject({ url: '/api/org/assignments/nope/log' });
  assert.equal(response.statusCode, 404);
});

test('unwatch stops the frames without touching the run', async (t) => {
  const fixture = await createFixture();
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // already gone
      }
    }
    await dispose(fixture);
  });
  const { assistant, app, script, base } = fixture;

  const events = [];
  const run = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'stop watching' })) events.push(event);
  })();
  const assignment = await runningAssignment(fixture);

  const watcher = await openSocket(base);
  sockets.push(watcher);
  const watched = collect(watcher);
  watcher.send(JSON.stringify({ type: 'watch', assignmentId: assignment.id }));
  await untilWatched(app, assignment.id);

  script.push({ type: 'text', delta: 'before' });
  await watched.until(
    (frames) => frames.some((frame) => frame.type === 'assignment-log' && frame.seq === 1),
    'frame seq 1 while watching',
  );

  watcher.send(JSON.stringify({ type: 'unwatch', assignmentId: assignment.id }));
  await untilWatched(app, assignment.id, false);
  script.push({ type: 'text', delta: 'after' });
  await sleep(150);
  assert.equal(
    watched.frames.filter((frame) => frame.type === 'assignment-log').length,
    1,
    'no live-log frames after unwatch',
  );

  // The run itself is unharmed by the watching ending either way.
  script.push({ type: 'done', text: 'before after' });
  script.finish();
  await run;
  assert.equal(assistant.store.org.getAssignment(assignment.id).status, 'done');
  const response = await app.inject({ url: '/api/org/assignments/' + assignment.id + '/log' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().active, false, 'ended, and the journal still answers');
});

test('a closed watcher socket is dropped from the map and the run goes on', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await dispose(fixture);
  });
  const { assistant, script, base, app } = fixture;

  const events = [];
  const run = (async () => {
    for await (const event of assistant.assign({ agent: 'mara', task: 'survive the close' })) events.push(event);
  })();
  const assignment = await runningAssignment(fixture);

  const watcher = await openSocket(base);
  const watched = collect(watcher);
  watcher.send(JSON.stringify({ type: 'watch', assignmentId: assignment.id }));
  await untilWatched(app, assignment.id);
  script.push({ type: 'text', delta: 'still here' });
  await watched.until(
    (frames) => frames.some((frame) => frame.type === 'assignment-log' && frame.seq === 1),
    'frame seq 1 before closing',
  );
  assert.equal(app.rookery.assignmentWatchers.size, 1, 'the socket is registered as a watcher');

  watcher.close();
  await untilWatched(app, assignment.id, false);
  assert.equal(app.rookery.assignmentWatchers.size, 0, 'closing the socket emptied the watchers map');

  // Watching ending never ended a run (Workstream E.1): this must not throw
  // anywhere and the assignment must still finish normally.
  script.push({ type: 'done', text: 'still here' });
  script.finish();
  await run;
  assert.equal(assistant.store.org.getAssignment(assignment.id).status, 'done');
});
