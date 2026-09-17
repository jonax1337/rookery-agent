import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Assistant, ProviderRegistry, Store } from '../dist/index.js';

/**
 * The running-turn journal: what a client that arrives late reads back.
 *
 * The claims worth a test are the ones a reload stands on: everything a live
 * client saw is in the journal, in order, numbered once each; a turn still
 * running reads back as running; a turn orphaned by a restart reads back as
 * interrupted until the conversation has moved on past it.
 */

const openAssistants = [];
after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed by the test
    }
  }
});

/** A provider that streams a scripted answer: two deltas, then done. */
function fakeProvider() {
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run() {
      yield { type: 'text', delta: 'Working ' };
      yield { type: 'text', delta: 'on it.' };
      yield { type: 'done', text: 'Working on it.' };
    },
  };
  return provider;
}

function createAssistant(store) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-journal-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fakeProvider()]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: false, autoExtract: false },
      org: { autoReview: false },
    },
  });
  openAssistants.push(assistant);
  return assistant;
}

test('a finished turn is journalled whole, in order, numbered once each', async () => {
  const store = new Store(':memory:');
  const assistant = createAssistant(store);
  const session = assistant.createSession({ title: 't', kind: 'chat', provider: 'claude', model: 'fake', cwd: '.' });
  const events = [];
  for await (const event of assistant.chat({ text: 'hello', sessionId: session.id, turnId: 'ws-42' })) {
    events.push(event);
  }

  assert.equal(store.turns.rejoinable(session.id), null, 'a settled turn is history, not a rejoin');

  // The journal keeps the turn's own record: same events the live client saw.
  const rows = store.turns.events('ws-42');
  const yielded = events.map((event) => JSON.stringify(event));
  const journalled = rows.map((row) => JSON.stringify(row.event));
  assert.deepEqual(journalled, yielded, 'the journal is the turn, verbatim');
  assert.deepEqual(
    rows.map((row) => row.seq),
    rows.map((row, index) => index + 1),
    'sequence numbers are 1..n with no gaps',
  );
  const turn = store.db.prepare('SELECT status FROM turns WHERE id = ?').get('ws-42');
  assert.equal(turn.status, 'done');
});

test('a half-consumed turn reads back as running, with what it reached so far', async () => {
  const store = new Store(':memory:');
  const assistant = createAssistant(store);
  const session = assistant.createSession({ title: 't', kind: 'chat', provider: 'claude', model: 'fake', cwd: '.' });

  const stream = assistant.chat({ text: 'hello', sessionId: session.id, turnId: 'ws-43' });
  await stream.next(); // the session event comes first
  await stream.next(); // then the first text delta

  const rejoin = store.turns.rejoinable(session.id);
  assert.ok(rejoin, 'mid-flight, the turn is there to rejoin');
  assert.equal(rejoin.turn.id, 'ws-43');
  assert.equal(rejoin.turn.status, 'running');
  const text = rejoin.events
    .filter((row) => row.event.type === 'text')
    .map((row) => row.event.delta)
    .join('');
  assert.equal(text, 'Working ', 'the replay holds exactly as much as the live client saw');

  await stream.return(); // the consumer walks away; the turn ends its loop
});

test('a restart marks the orphan interrupted, and it stops being news once the conversation moves on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rookery-journal-db-'));
  const path = join(dir, 'rookery.db');

  const first = new Store(path);
  const assistant = createAssistant(first);
  const session = assistant.createSession({ title: 't', kind: 'chat', provider: 'claude', model: 'fake', cwd: '.' });
  const stream = assistant.chat({ text: 'hello', sessionId: session.id, turnId: 'ws-44' });
  await stream.next(); // session
  await stream.next(); // the first text delta is all this process ever got to
  // The process dies right here: store closed mid-turn, generator never finished.
  first.close();

  const second = new Store(path);
  const rejoin = second.turns.rejoinable(session.id);
  assert.ok(rejoin, 'the orphan is still worth showing');
  assert.equal(rejoin.turn.status, 'interrupted');
  assert.equal(rejoin.events.filter((row) => row.event.type === 'text').length, 1, 'with what it had reached');

  // The conversation moves on: a later message answers the question the dead
  // turn never did, and the fragment stops being offered.
  second.addMessage({ sessionId: session.id, role: 'assistant', content: 'later' });
  assert.equal(second.turns.rejoinable(session.id), null, 'history tells it better now');
  second.close();
});
