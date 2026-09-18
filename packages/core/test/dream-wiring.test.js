import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_MEMORY_OWNER,
  Assistant,
  DEFAULT_SPLIT_RATES,
  ProviderRegistry,
  Store,
  locateTurn,
  splitOf,
} from '../dist/index.js';

/**
 * The wiring of stage 2 into the runtime and the organisation (AP14).
 *
 * Four things are load-bearing here, and each of them is invisible from
 * inside the module that would otherwise own it:
 *
 *   1. ONE turn id. The journal mints one in `chat()`, and the recorder and
 *      `addMessage` now both use that one instead of each inventing their
 *      own. Without it `locateTurn` can never match, every correction label
 *      falls back to session scope, and a session-scoped label contributes
 *      no gain (S3) - the night would write labels that cannot aim.
 *   2. The split stamp is drawn per SESSION (E3), with the rates the night
 *      reads back, so two traces of one session can never disagree.
 *   3. The `memory` event carries the turn id, which is what lets the chat
 *      highlight write a label about this turn rather than this session (S6).
 *   4. `trialEpisodes` is 0 by default, and 0 means nothing is written.
 *
 * Plus the two organisation halves: the agent's recall goes through
 * `resolvePolicy` (E16/S18), and `upsertReview` writes the review label
 * every review source ends up in (S8).
 */

/** A provider that answers plain text and keeps every system prompt it saw. */
function createFakeProvider() {
  const runs = [];
  const provider = {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      runs.push(opts);
      if ((opts.prompt ?? '').includes('EXCHANGE\n')) {
        yield { type: 'done', text: '[]' };
        return;
      }
      yield { type: 'text', delta: 'Noted.' };
      yield { type: 'done', text: 'Noted.' };
    },
  };
  return { provider, runs };
}

const openAssistants = [];
after(() => {
  for (const assistant of openAssistants) {
    try {
      assistant.close();
    } catch {
      // already closed
    }
  }
});

function createAssistant(fake, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-dream-wiring-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new Store(':memory:');
  const assistant = new Assistant({
    store,
    registry: new ProviderRegistry([fake.provider]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: false, ...overrides.memory },
      org: { autoReview: false },
    },
  });
  openAssistants.push(assistant);
  return { assistant, store };
}

/** The dream on and sampling every session, unless overridden. */
function dreamOn(extra = {}) {
  return { memory: { dream: { enabled: true, record: true, frameRate: 1, ...extra } } };
}

function seedBank(store) {
  store.upsertMemory({ kind: 'fact', content: 'The harbor manifest lists every incoming cargo.', tags: ['harbor'], importance: 0.9 });
  store.upsertMemory({ kind: 'fact', content: 'The ledger records the tides at the quay.', tags: ['ledger'], importance: 0.55 });
}

function rows(store, sql, ...values) {
  return store.db.prepare(sql).all(...values);
}

/** Run one turn and hand back its session id and the events it yielded. */
async function runTurn(assistant, text, sessionId) {
  const events = [];
  let used = sessionId;
  for await (const event of assistant.chat(sessionId ? { text, sessionId } : { text })) {
    if (event.type === 'error' && event.fatal) assert.fail(event.message);
    if (event.type === 'session' && !used) used = event.sessionId;
    events.push(event);
  }
  assert.ok(used, 'the turn reported its session');
  return { sessionId: used, events };
}

test('the trace, the journal and both messages carry one turn id', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const { sessionId } = await runTurn(assistant, 'What does the harbor manifest list?');

  const traces = rows(store, 'SELECT * FROM dream_traces');
  assert.equal(traces.length, 1);
  const turnId = traces[0].turn_id;

  const journal = rows(store, 'SELECT * FROM turns WHERE session_id = ?', sessionId);
  assert.equal(journal.length, 1);
  assert.equal(
    journal[0].id,
    turnId,
    'the recorder uses the journal id instead of minting a second one',
  );

  const messages = store.getMessages(sessionId);
  assert.equal(messages.length, 2, 'the turn stored its prompt and its answer');
  for (const message of messages) {
    assert.equal(message.turnId, turnId, message.role + ' message carries the turn id');
  }
});

test('a correction quote locates the real turn instead of falling back to the session', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const { sessionId } = await runTurn(assistant, 'Does the harbor manifest list the copper crates?');
  await runTurn(assistant, 'And what about the tides at the quay?', sessionId);

  const messages = store.getMessages(sessionId);
  const turnIds = rows(
    store,
    'SELECT turn_id FROM dream_traces ORDER BY started_at ASC, id',
  ).map((row) => row.turn_id);
  assert.equal(turnIds.length, 2);

  // The quote is the night's own standard: words out of one user message,
  // proven by `confirmedBy`. It names exactly one message, so it names
  // exactly one turn.
  const first = locateTurn(messages, 'harbor manifest list the copper crates');
  assert.equal(first.scope, 'turn');
  assert.equal(first.turnId, turnIds[0]);

  const second = locateTurn(messages, 'tides at the quay');
  assert.equal(second.scope, 'turn');
  assert.equal(second.turnId, turnIds[1]);
  assert.notEqual(second.turnId, first.turnId, 'the two turns are told apart');

  // And the other half of S3: a quote that names no single message stays
  // session-wide rather than being guessed at.
  const nowhere = locateTurn(messages, 'the lighthouse keeper signed the ledger');
  assert.equal(nowhere.turnId, null);
  assert.equal(nowhere.scope, 'session');
});

test('holdout and audit are stamped session-wise, with the rates the night reads back', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const { sessionId } = await runTurn(assistant, 'Harbor manifest, first turn.');
  for (let turn = 2; turn <= 5; turn += 1) {
    await runTurn(assistant, 'Harbor manifest, turn ' + turn + '.', sessionId);
  }

  const traces = rows(store, 'SELECT * FROM dream_traces WHERE session_id = ?', sessionId);
  assert.equal(traces.length, 5);
  const split = splitOf(sessionId, DEFAULT_SPLIT_RATES);
  for (const trace of traces) {
    assert.equal(trace.holdout, split === 'holdout' ? 1 : 0);
    assert.equal(trace.audit, split === 'audit' ? 1 : 0);
  }
  assert.equal(
    new Set(traces.map((trace) => trace.holdout + ':' + trace.audit)).size,
    1,
    'five traces of one session never disagree about which side they are on',
  );

  // A second session is stamped by the same function, so the stamp is a
  // property of the session id and of nothing else.
  const other = await runTurn(assistant, 'A different conversation about the quay.');
  const otherSplit = splitOf(other.sessionId, DEFAULT_SPLIT_RATES);
  const otherTrace = rows(store, 'SELECT * FROM dream_traces WHERE session_id = ?', other.sessionId)[0];
  assert.equal(otherTrace.holdout, otherSplit === 'holdout' ? 1 : 0);
  assert.equal(otherTrace.audit, otherSplit === 'audit' ? 1 : 0);
});

test('the recalled event carries the turn id the label will be written against', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake, dreamOn());
  seedBank(store);

  const { sessionId, events } = await runTurn(assistant, 'What does the harbor manifest list?');
  const recalled = events.find((event) => event.type === 'memory' && event.action === 'recalled');
  assert.ok(recalled, 'the turn recalled something at all');
  assert.ok(recalled.items.length > 0);

  const messages = store.getMessages(sessionId);
  assert.equal(
    recalled.turnId,
    messages[0].turnId,
    'the surface is handed the same turn id the prompt was stored under (S6)',
  );
});

test('trialEpisodes 0 writes no episode; a positive quota writes that many', async () => {
  const off = createAssistant(createFakeProvider(), dreamOn());
  seedBank(off.store);
  const first = await runTurn(off.assistant, 'What does the harbor manifest list?');
  await runTurn(off.assistant, 'And the tides at the quay?', first.sessionId);
  assert.equal(
    rows(off.store, 'SELECT * FROM dream_episodes').length,
    0,
    'the default is 0, and 0 means the recorder never runs',
  );

  const on = createAssistant(createFakeProvider(), dreamOn({ trialEpisodes: 2 }));
  seedBank(on.store);
  const session = await runTurn(on.assistant, 'What does the harbor manifest list?');
  await runTurn(on.assistant, 'And the tides at the quay?', session.sessionId);
  await runTurn(on.assistant, 'One turn past the quota.', session.sessionId);

  const episodes = rows(on.store, 'SELECT * FROM dream_episodes');
  assert.equal(episodes.length, 2, 'the key is a quota, not a switch');
  const split = splitOf(session.sessionId, DEFAULT_SPLIT_RATES);
  for (const episode of episodes) {
    assert.equal(episode.owner, ASSISTANT_MEMORY_OWNER);
    assert.equal(episode.kind, 'turn');
    assert.equal(episode.session_id, session.sessionId);
    assert.equal(episode.outcome, 'success', 'the turn ended with a done event');
    assert.equal(episode.holdout, split === 'holdout' ? 1 : 0);
    assert.equal(episode.audit, split === 'audit' ? 1 : 0);
  }
  // The id is the journal's, which is what makes the row an index over
  // `turn_events` rather than a second transcript.
  const journalIds = new Set(
    rows(on.store, 'SELECT id FROM turns WHERE session_id = ?', session.sessionId).map((row) => row.id),
  );
  for (const episode of episodes) assert.ok(journalIds.has(episode.id));
});

test('the agent recall reads the resolver, so a promoted policy reaches it', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({
    orgId: org.id,
    name: 'Mara',
    title: 'Dockmaster',
    instructions: 'Mind the quay.',
  });
  // Low importance on purpose: below `coreProfile`'s floor, so what reaches
  // the prompt is the ranking and nothing else.
  store.upsertMemory({ kind: 'fact', content: 'The quay crane is out of service.', owner: agent.id, importance: 0.3 });
  store.upsertMemory({ kind: 'fact', content: 'The quay gate closes at eight.', owner: agent.id, importance: 0.3 });

  const runAssignment = async () => {
    for await (const event of assistant.assign({ agent: agent.id, task: 'Report on the quay.' })) {
      if (event.type === 'error' && event.fatal) assert.fail(event.message);
    }
    return fake.runs[fake.runs.length - 1].systemPrompt;
  };

  const before = await runAssignment();
  assert.match(before, /quay crane is out of service/);
  assert.match(before, /quay gate closes at eight/);

  // Nothing in the config moved, so the promoted value is the one the
  // resolver lays over the default (origin 'dream'). Before AP14 this call
  // site read the config directly and could not have seen it at all.
  const version = store.createPolicyVersion({
    owner: agent.id,
    slot: 'recall',
    params: { threshold: 0.99 },
    box: {},
    origin: 'dream',
  });
  store.promotePolicyVersion(version.id, {});

  const after = await runAssignment();
  assert.doesNotMatch(after, /quay crane is out of service/);
  assert.doesNotMatch(after, /quay gate closes at eight/);
});

test('upsertReview writes the review label, and replaces it the way it replaces the review', async () => {
  const fake = createFakeProvider();
  const { assistant, store } = createAssistant(fake);
  const org = assistant.org.activeOrganization();
  const agent = store.org.createAgent({
    orgId: org.id,
    name: 'Mara',
    title: 'Dockmaster',
    instructions: 'Mind the quay.',
  });
  const assignment = store.org.createAssignment({
    orgId: org.id,
    agentId: agent.id,
    requesterKind: 'user',
    title: 'Quay report',
    task: 'Report on the quay.',
  });

  store.org.upsertReview({
    orgId: org.id,
    agentId: agent.id,
    assignmentId: assignment.id,
    source: 'assistant',
    overall: 5,
  });

  const labels = store.labelsForSessions([assignment.id], agent.id);
  assert.equal(labels.length, 1, 'the funnel wrote exactly one label');
  const label = labels[0];
  assert.equal(label.turnId, assignment.id);
  assert.equal(label.target, '*', 'a review scores the trace, never a memory (4.2d)');
  assert.equal(label.source, 'review');
  assert.equal(label.scope, 'session');
  assert.equal(label.relevance, 1, '(5 - 1) / 4');
  assert.equal(label.owner, agent.id, "the agent's own bank");

  // The warning from 4.2d, as behaviour: a second call for the same pair
  // replaces the review AND the reward that was hung on it.
  store.org.upsertReview({
    orgId: org.id,
    agentId: agent.id,
    assignmentId: assignment.id,
    source: 'assistant',
    overall: 1,
  });
  const revoked = store.labelsForSessions([assignment.id], agent.id);
  assert.equal(revoked.length, 1, 'still one row, not two');
  assert.equal(revoked[0].relevance, 0, 'a reward once appended can be revoked silently');
});

test('the wake test writes down what it observed', async () => {
  const store = new Store(':memory:');
  const version = store.createPolicyVersion({
    owner: ASSISTANT_MEMORY_OWNER,
    slot: 'recall',
    params: { limit: 8 },
    box: {},
    origin: 'dream',
    replayScore: 0.4,
  });
  assert.equal(store.policyVersion(version.id).onlineScore, undefined);

  store.setPolicyOnlineScore(version.id, 0.37);
  assert.equal(
    store.policyVersion(version.id).onlineScore,
    0.37,
    'the night can finally record the reading it froze on',
  );
  store.close();
});
