import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_MEMORY_OWNER,
  DEFAULT_CONFIG,
  Store,
  admitCandidates,
  linkEntities,
  recall,
} from '../dist/index.js';

/**
 * Owner boundaries and undo bookkeeping in the memory bank.
 *
 * The header of recall.ts promises that an agent never sees what the
 * assistant knows about the user and the assistant never recalls an agent's
 * working notes. These tests hold that line where it is thinnest - the second
 * hop through the entity graph - and the undo trail of a night that revives
 * what an earlier night filed away.
 */

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

test('the entity hop never crosses owners, in either direction', () => {
  const store = makeStore();
  const privateNote = store.upsertMemory({
    kind: 'fact',
    content: 'The user handles his tax declaration every March.',
    importance: 0.9,
    tags: ['finances'],
  });
  const agentNote = store.upsertMemory({
    kind: 'project',
    content: 'The billing deployment needs two approvals from the team.',
    importance: 0.9,
    owner: 'agent-releng',
    tags: ['finances'],
  });
  linkEntities(store, ASSISTANT_MEMORY_OWNER, privateNote.id, ['finances']);
  linkEntities(store, 'agent-releng', agentNote.id, ['finances']);

  // However a cross-owner link came about, the two banks now share one entity
  // node - exactly the situation the hop has to survive.
  const shared = store.findEntity(ASSISTANT_MEMORY_OWNER, 'finances');
  store.linkEntity(agentNote.id, shared.id);

  const agentView = recall(store, { text: 'billing deployment approvals', owner: 'agent-releng' });
  assert.ok(agentView.length > 0, 'the agent still recalls its own memory');
  assert.ok(
    agentView.every((hit) => hit.owner === 'agent-releng'),
    'nothing from another owner may leak in through a shared entity',
  );
  assert.ok(!agentView.some((hit) => hit.id === privateNote.id));

  const assistantView = recall(store, { text: 'tax declaration march' });
  assert.ok(assistantView.length > 0, 'the assistant still recalls its own memory');
  assert.ok(
    assistantView.every((hit) => hit.owner === ASSISTANT_MEMORY_OWNER),
    'no agent working note may leak in through a shared entity',
  );
  assert.ok(!assistantView.some((hit) => hit.id === agentNote.id));
  store.close();
});

test('a memory revived by an identical condensation carries the night id and survives its undo', () => {
  const store = makeStore();
  const memory = store.upsertMemory({
    kind: 'fact',
    content: 'The user cuts releases from main.',
    importance: 0.6,
  });
  const filingNight = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
  store.sleepMemory(memory.id, { runId: filingNight.id });

  // A later night condenses a cluster into a sentence that byte-exactly hits
  // the dormant row, which is therefore reinforced rather than inserted.
  const condensingNight = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
  // A night starts strictly after everything that already exists. That is what
  // stops undo's "written by this run" from swallowing a row created in the
  // same millisecond the night began - without it the assertion below is a
  // coin toss rather than a test (store.ts, `sleepRunStart`).
  assert.ok(
    condensingNight.startedAt > memory.createdAt,
    'the night starts after the memory it is about to revive',
  );
  const revived = store.upsertMemory({
    kind: 'fact',
    content: 'The user cuts releases from main.',
    importance: 0.7,
    origin: 'sleep',
    sleepRunId: condensingNight.id,
  });

  assert.equal(revived.id, memory.id, 'the same sentence reinforces the dormant row');
  assert.ok(!revived.dormantAt, 'and it is awake again');
  assert.equal(revived.sleepRunId, condensingNight.id, 'the revival is attributed to the night that caused it');

  const undo = store.undoSleepRun(condensingNight.id);
  assert.ok(undo, 'the condensing night can be undone');
  assert.equal(undo.removed, 0, 'undo deletes only what the night itself created');
  assert.ok(store.getMemory(memory.id), 'a memory that predates the night survives its undo');
  store.close();
});

test('a night starts strictly after everything that already exists', () => {
  const store = makeStore();
  // The boundary above, checked tightly enough that it cannot pass on a lucky
  // millisecond: `undoSleepRun` reads every row stamped at or after the run's
  // start as one the run wrote, so a row written in the tick the night begins
  // would be deleted by an undo that has nothing to do with it. Back to back,
  // a row and the night after it land in the same millisecond nearly every
  // time, which is what made the undo test above a coin toss.
  for (let i = 0; i < 20; i += 1) {
    const before = store.upsertMemory({ kind: 'fact', content: `The user owns bicycle ${i}.` });
    const night = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
    assert.ok(
      night.startedAt > before.createdAt,
      `a night must not share its starting millisecond with an older row (round ${i})`,
    );
  }
  store.close();
});

test('a malformed usage or tool_calls column degrades to absent instead of throwing', () => {
  const store = makeStore();
  const session = store.createSession({ provider: 'claude', cwd: 'C:\\tmp' });
  store.db
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, usage, created_at, tool_calls)
       VALUES ('m-broken', ?, 'user', 'hello', '{"inputTokens":', 1, 'not json')`,
    )
    .run(session.id);

  const messages = store.getMessages(session.id);
  assert.equal(messages.length, 1, 'one bad row does not cost the transcript');
  assert.equal(messages[0].content, 'hello');
  assert.equal(messages[0].usage, undefined);
  assert.equal(messages[0].toolCalls, undefined);
  store.close();
});

test('an unconfirmed candidate is reported as unconfirmed even once the turn is full', () => {
  const store = makeStore();
  const config = {
    ...DEFAULT_CONFIG.memory,
    gate: { ...DEFAULT_CONFIG.memory.gate, maxPerTurn: 1 },
  };
  const result = admitCandidates(store, {
    candidates: [
      { kind: 'fact', content: 'The user runs Windows.', tags: [], importance: 0.7, evidence: 'runs Windows' },
      {
        kind: 'fact',
        content: 'The user owns a sailing boat.',
        tags: [],
        importance: 0.7,
        evidence: 'owns a sailing boat',
      },
      {
        kind: 'preference',
        content: 'The user likes tea with milk.',
        tags: [],
        importance: 0.7,
        evidence: 'likes tea with milk',
      },
    ],
    owner: ASSISTANT_MEMORY_OWNER,
    config,
    sources: ['The user runs Windows and likes tea with milk.'],
  });

  assert.equal(result.stored.length, 1, 'the confirmed candidate fills the budget');
  assert.deepEqual(
    result.rejected.map((entry) => entry.reason),
    ['unconfirmed', 'over-budget'],
    'a claim with no evidence is unconfirmed, not a victim of the full budget');
  store.close();
});

test('an edge never wires two banks together, in either direction', () => {
  const store = makeStore();
  const privateNote = store.upsertMemory({
    kind: 'fact',
    content: 'The user handles his tax declaration every March.',
    importance: 0.9,
  });
  const agentNote = store.upsertMemory({
    kind: 'project',
    content: 'The billing deployment needs two approvals from the team.',
    importance: 0.9,
    owner: 'agent-releng',
  });

  assert.equal(
    store.addEdge({ owner: 'agent-releng', srcId: agentNote.id, dstId: privateNote.id, relation: 'refines' }),
    null,
    'an agent edge may not land on an assistant memory',
  );
  assert.equal(
    store.addEdge({ owner: ASSISTANT_MEMORY_OWNER, srcId: privateNote.id, dstId: agentNote.id, relation: 'refines' }),
    null,
    'and an assistant edge may not land on an agent memory',
  );
  assert.equal(store.listEdges('agent-releng').length, 0, 'nothing was persisted on a refused path');

  const agentPeer = store.upsertMemory({
    kind: 'project',
    content: 'The billing rollout lands on a Friday.',
    importance: 0.8,
    owner: 'agent-releng',
  });
  const edge = store.addEdge({
    owner: 'agent-releng',
    srcId: agentNote.id,
    dstId: agentPeer.id,
    relation: 'refines',
  });
  assert.ok(edge, 'an edge inside one bank still stores');
  store.close();
});

test('the neighbourhood ignores a foreign edge, even one planted by hand', () => {
  const store = makeStore();
  const privateNote = store.upsertMemory({
    kind: 'fact',
    content: 'The user handles his tax declaration every March.',
    importance: 0.9,
  });
  const agentNote = store.upsertMemory({
    kind: 'project',
    content: 'The billing deployment needs two approvals from the team.',
    importance: 0.9,
    owner: 'agent-releng',
  });
  // However a cross-owner edge came about - a night from before the guard
  // could write one - the inspector must not read across banks through it.
  store.db
    .prepare(
      `INSERT INTO memory_edges (id, owner, src_id, dst_id, relation, weight, origin, created_at)
       VALUES ('e-cross', 'agent-releng', ?, ?, 'refines', 0.6, 'sleep', 1)`,
    )
    .run(privateNote.id, agentNote.id);

  const view = store.neighbourhood(privateNote.id);
  assert.ok(view, 'the memory itself is still inspectable');
  assert.equal(view.outgoing.length, 0, 'no outgoing edge into another bank');
  assert.equal(view.incoming.length, 0, 'no incoming edge from another bank');
  store.close();
});
