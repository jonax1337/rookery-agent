import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { Assistant, ProviderRegistry, Store } from '@rookery/core';
import { buildServer } from '../dist/server.js';

/**
 * The question surface of the server: `GET /api/questions`, the REST answer,
 * the `answer` websocket frame, and the broadcast that puts the card on every
 * connection instead of only the one that started the turn.
 *
 * The registry is driven directly - no provider, no tool call - because what
 * is under test is the wiring around it, not the tool that asks.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A provider that is never run; the registry just refuses to be empty. */
const idleProvider = {
  id: 'claude',
  displayName: 'Fake Claude',
  models: () => ['fake'],
  async status() {
    return { id: 'claude', available: true, binary: 'fake', authenticated: true };
  },
  async *run() {
    // Nothing: no turn is started in this file.
  },
};

async function createFixture() {
  const home = mkdtempSync(join(tmpdir(), 'rookery-questions-'));
  const assistant = new Assistant({
    store: new Store(':memory:'),
    registry: new ProviderRegistry([idleProvider]),
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
  return { assistant, app, base, home };
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

function askSomething(assistant, header = 'Deploy target') {
  return assistant.questions.ask(
    {
      header,
      question: 'Where should this go?',
      options: [{ label: 'Staging' }, { label: 'Production', description: 'The real one.' }],
      multiSelect: false,
    },
    { timeoutMs: 10_000 },
  );
}

test('an open question is listed, answered over REST, and gone afterwards', async (t) => {
  const fixture = await createFixture();
  t.after(() => dispose(fixture));
  const { assistant, app } = fixture;

  const pending = askSomething(assistant);

  let response = await app.inject({ url: '/api/questions' });
  assert.equal(response.statusCode, 200);
  const open = response.json();
  assert.equal(open.length, 1);
  assert.equal(open[0].type, 'question', 'a reload reads the same shape the live frame carries');
  assert.equal(open[0].header, 'Deploy target');
  assert.equal(open[0].multiSelect, false);
  assert.equal(open[0].options.length, 2);
  assert.ok(open[0].expiresAt > Date.now());
  const id = open[0].id;

  // An id nobody is waiting on: the stale-card case, not a crash.
  response = await app.inject({
    method: 'POST',
    url: '/api/questions/nope/answer',
    payload: { selected: [0] },
  });
  assert.equal(response.statusCode, 404);

  // Neither a choice nor text says nothing at all, and must not reach the
  // waiting tool call as if somebody had spoken.
  response = await app.inject({ method: 'POST', url: '/api/questions/' + id + '/answer', payload: {} });
  assert.equal(response.statusCode, 400);

  response = await app.inject({
    method: 'POST',
    url: '/api/questions/' + id + '/answer',
    payload: { selected: [1], text: '  with a note  ' },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().answered, true);

  const answer = await pending;
  assert.deepEqual(answer.selected, [1]);
  assert.equal(answer.text, 'with a note');
  assert.equal(answer.source, 'api');

  response = await app.inject({ url: '/api/questions' });
  assert.deepEqual(response.json(), [], 'an answered question is no longer open');

  // Answering it a second time finds nothing to answer.
  response = await app.inject({
    method: 'POST',
    url: '/api/questions/' + id + '/answer',
    payload: { selected: [0] },
  });
  assert.equal(response.statusCode, 404);
});

test('any connection may answer, and a stale answer frame is told so', async (t) => {
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
  const { assistant, app, base } = fixture;

  const pending = askSomething(assistant, 'Branch');
  const id = (await app.inject({ url: '/api/questions' })).json()[0].id;

  // Deliberately a socket that never started a turn: the question belongs to
  // the person, not to the connection that provoked it.
  const bystander = await openSocket(base);
  sockets.push(bystander);
  const seen = collect(bystander);

  bystander.send(JSON.stringify({ type: 'answer', id, selected: [0] }));
  const answer = await pending;
  assert.deepEqual(answer.selected, [0]);
  assert.equal(answer.source, 'web');

  // The same frame again: the card was stale, and saying so beats dropping it.
  bystander.send(JSON.stringify({ type: 'answer', id, selected: [0] }));
  await seen.until(
    (frames) => frames.some((frame) => frame.type === 'error' && /No open question/.test(frame.message)),
    'an error frame for the closed question',
  );
  assert.ok(
    seen.frames.every((frame) => frame.type !== 'error' || frame.id === undefined),
    'the error frame carries no id - that field means a turn id to every client',
  );

  // An answer with nothing in it is refused at the edge as well.
  bystander.send(JSON.stringify({ type: 'answer', id, selected: [] }));
  await seen.until(
    (frames) => frames.some((frame) => frame.type === 'error' && /selected option or some text/.test(frame.message)),
    'an error frame for the empty answer',
  );
});

test('question and question-closed reach every open socket', async (t) => {
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
  const { assistant, base } = fixture;

  const first = await openSocket(base);
  const second = await openSocket(base);
  sockets.push(first, second);
  const a = collect(first);
  const b = collect(second);

  const event = {
    type: 'question',
    id: 'q-broadcast',
    header: 'Deploy target',
    question: 'Where should this go?',
    options: [{ label: 'Staging' }, { label: 'Production' }],
    multiSelect: false,
    expiresAt: Date.now() + 60_000,
  };
  assistant.emit('question', event);
  await a.until((frames) => frames.some((frame) => frame.type === 'question'), 'the question on the first socket');
  await b.until((frames) => frames.some((frame) => frame.type === 'question'), 'the question on the second socket');
  assert.deepEqual(b.frames.find((frame) => frame.type === 'question').event, event);

  const closed = { type: 'question-closed', id: 'q-broadcast', reason: 'answered' };
  assistant.emit('question-closed', closed);
  await a.until(
    (frames) => frames.some((frame) => frame.type === 'question-closed'),
    'the close on the first socket',
  );
  await b.until(
    (frames) => frames.some((frame) => frame.type === 'question-closed'),
    'the close on the second socket',
  );
  assert.deepEqual(a.frames.find((frame) => frame.type === 'question-closed').event, closed);
});
