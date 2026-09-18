import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_MEMORY_OWNER, Store } from '../dist/index.js';

/**
 * Recorder persistence (AP7): traces, frames, touches and the sleep-run
 * counters they report through.
 *
 * The load-bearing property is the SAVEPOINT bracket (R9): a framed turn
 * writes its trace, its frame and its touches as one transaction even while
 * another transaction is open on the same connection, and a failure in the
 * middle leaves nothing half written. Around that: the size cap refuses
 * instead of throwing, the touch bookkeeping is append-only and free when
 * no context is passed, the memory-retiring paths reach the frames (R17),
 * and the sweep takes stale rows away in batches.
 */

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

/** The policy `resolvePolicy` would hand over; only the shape matters here. */
const POLICY = {
  limit: 8,
  threshold: 0.12,
  w: { relevance: 0.55, importance: 0.2, recency: 0.15, usage: 0.1 },
  hopEntity: 0.45,
  hopEdge: 0.6,
  kinds: [],
  minImportance: 0,
  origin: {
    limit: 'default',
    threshold: 'default',
    hopEntity: 'default',
    hopEdge: 'default',
    relevance: 'default',
    importance: 'default',
    recency: 'default',
    usage: 'default',
  },
};

function traceInput(overrides = {}) {
  return {
    turnId: 'turn-1',
    owner: ASSISTANT_MEMORY_OWNER,
    kind: 'turn',
    site: 'turn',
    pipeline: 'assistant',
    sessionId: 'session-1',
    sessionKind: 'chat',
    policySet: { recall: POLICY },
    framed: true,
    ...overrides,
  };
}

function framePayload(overrides = {}) {
  return {
    v: 1,
    site: 'turn',
    pipeline: 'assistant',
    owner: ASSISTANT_MEMORY_OWNER,
    box: {
      limitMax: 16,
      w: {
        relevance: [0.45, 0.65],
        importance: [0.1, 0.3],
        recency: [0.05, 0.25],
        usage: [0.0, 0.2],
      },
      threshold: [0.05, 0.3],
      hopEntity: [0.3, 0.6],
      hopEdge: [0.4, 0.8],
      kinds: [],
      minImportance: 0,
    },
    query: { text: 'how does the deploy pipeline fail?', matchQuery: 'deploy', tokens: ['deploy', 'pipeline'] },
    now: 1_700_000_000_000,
    corpusStampId: 'stamp-1',
    maxRelevanceClamped: 1,
    budgetChars: 2400,
    subject: 'this user',
    records: {},
    hop1: [],
    possibleSeeds: [],
    entities: {},
    entityNeighbours: {},
    edges: [],
    contradicts: [],
    profile: [],
    degraded: null,
    ...overrides,
  };
}

test('a dream counter survives the create-update-read round trip', () => {
  const store = makeStore();
  const run = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
  store.updateSleepRun(run.id, { dreamFramesScored: 7 });
  const reread = store.getSleepRun(run.id);
  assert.equal(reread.dreamFramesScored, 7);
  assert.equal(reread.dreamTracesSeen, 0);
  store.close();
});

test('a fresh run carries all five dream counters and no sixth', () => {
  const store = makeStore();
  const run = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
  assert.deepEqual(
    Object.keys(run)
      .filter((key) => key.startsWith('dream'))
      .sort(),
    ['dreamCandidates', 'dreamFramesScored', 'dreamLabelsWritten', 'dreamPromoted', 'dreamTracesSeen'],
  );
  store.close();
});

test('the recorder bracket writes through an open transaction', () => {
  const store = makeStore();
  store.db.exec('BEGIN');
  assert.doesNotThrow(() => {
    store.recordDreamTurn(() => {
      const trace = store.beginTrace(traceInput());
      store.saveFrame(trace.id, 'recall', framePayload());
    });
  });
  store.db.exec('COMMIT');
  assert.equal(count(store, 'dream_frames'), 1, 'the frame row survived the outer COMMIT');
  assert.equal(count(store, 'dream_traces'), 1);
  store.close();
});

test('a failure inside the bracket leaves nothing half written', () => {
  const store = makeStore();
  // A BigInt cannot be serialised, so `saveFrame` throws mid-turn - after
  // the trace insert, which is exactly the half-written state the bracket
  // exists to prevent.
  assert.throws(() => {
    store.recordDreamTurn(() => {
      const trace = store.beginTrace(traceInput());
      store.saveFrame(trace.id, 'recall', framePayload({ now: 1n }));
    });
  }, /BigInt/);
  assert.equal(count(store, 'dream_traces'), 0);
  assert.equal(count(store, 'dream_frames'), 0);
  store.close();
});

test('a frame over the size cap is refused, not thrown at', () => {
  const store = makeStore();
  const trace = store.beginTrace(traceInput());
  const huge = framePayload({ records: { big: { content: 'a'.repeat(130_000) } } });
  assert.equal(store.saveFrame(trace.id, 'recall', huge), false);
  assert.equal(store.saveFrame(trace.id, 'recall', framePayload(), { maxFrameBytes: 10 }), false);
  assert.equal(count(store, 'dream_frames'), 0);
  // The trace itself stays: a refused frame is a closed turn without a
  // frame, not a lost turn.
  assert.equal(count(store, 'dream_traces'), 1);
  store.close();
});

test('touchMemories without a context writes no touch rows', () => {
  const store = makeStore();
  const memory = store.upsertMemory({ kind: 'fact', content: 'A fact the recorder will touch.', importance: 0.5 });
  store.touchMemories([memory.id]);
  assert.equal(count(store, 'memory_touches'), 0);
  assert.equal(store.getMemory(memory.id).accessCount, 1, 'the counter still moved');
  store.close();
});

test('touchMemories with a context is append-only', () => {
  const store = makeStore();
  const memory = store.upsertMemory({ kind: 'fact', content: 'A fact the recorder will touch twice.', importance: 0.5 });
  const trace = store.beginTrace(traceInput());
  store.touchMemories([memory.id], { traceId: trace.id, owner: ASSISTANT_MEMORY_OWNER });
  store.touchMemories([memory.id], { traceId: trace.id, owner: ASSISTANT_MEMORY_OWNER });
  assert.equal(count(store, 'memory_touches'), 2, 'the same (trace, memory) pair is two rows (R4)');
  const row = store.db.prepare('SELECT owner, turn_id, trace_id FROM memory_touches').get();
  assert.equal(row.owner, ASSISTANT_MEMORY_OWNER);
  assert.equal(row.turn_id, 'turn-1', 'the touch carries the trace turn id (R19)');
  assert.equal(row.trace_id, trace.id);
  assert.equal(store.getMemory(memory.id).accessCount, 2, 'the counter semantics are unchanged');
  store.close();
});

test('forgetting, archiving and deleting memories all reach the frames', () => {
  function bankWithFrame() {
    const store = makeStore();
    const memory = store.upsertMemory({ kind: 'fact', content: 'Quoted verbatim by a frame.', importance: 0.7 });
    const trace = store.beginTrace(traceInput());
    assert.equal(store.saveFrame(trace.id, 'recall', framePayload()), true);
    return { store, memory };
  }

  let archived = bankWithFrame();
  archived.store.archiveMemories(ASSISTANT_MEMORY_OWNER);
  assert.equal(count(archived.store, 'dream_frames'), 0, 'archiveMemories drops the owner frames');
  archived.store.close();

  let forgotten = bankWithFrame();
  forgotten.store.forgetMemory(forgotten.memory.id);
  assert.equal(count(forgotten.store, 'dream_frames'), 0, 'forgetMemory drops the owner frames');
  forgotten.store.close();

  let deleted = bankWithFrame();
  deleted.store.deleteMemory(deleted.memory.id);
  assert.equal(count(deleted.store, 'dream_frames'), 0, 'deleteMemory drops the owner frames');
  deleted.store.close();
});

test('undoing a night run drops the frames that quote what it wrote (R17)', () => {
  const store = makeStore();
  const run = store.createSleepRun({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });
  // A memory the night wrote, carrying the run id and origin the undo
  // selects on, with the user's evidence quote a frame would freeze with it.
  const night = store.upsertMemory({
    kind: 'insight',
    content: 'The night concluded the harbor ledger matters.',
    importance: 0.8,
    origin: 'sleep',
    sleepRunId: run.id,
    evidence: 'user: please keep the harbor ledger in mind',
  });
  const record = store.getMemory(night.id);
  const trace = store.beginTrace(traceInput());
  assert.equal(
    store.saveFrame(trace.id, 'recall', framePayload({ records: { [night.id]: record } })),
    true,
  );
  assert.equal(count(store, 'dream_frames'), 1);

  const result = store.undoSleepRun(run.id);

  assert.equal(result.removed, 1, 'the night-written memory is deleted');
  assert.equal(store.getMemory(night.id), null);
  assert.equal(count(store, 'dream_frames'), 0, 'the frame quoting it is gone too, not retained for 45 days');
  assert.equal(store.undoSleepRun(run.id), null, 'a second undo is a no-op');
  store.close();
});

test('open traces are closed by the restart pass', () => {
  const store = makeStore();
  store.beginTrace(traceInput());
  store.beginTrace(traceInput({ turnId: 'turn-2' }));
  assert.equal(store.openTraces().length, 2);
  const closed = store.failStaleTraces('restart');
  assert.equal(closed, 2);
  assert.equal(store.openTraces().length, 0);
  store.close();
});

test('the frame sweep removes only what is older than the cut', () => {
  const store = makeStore();
  const trace = store.beginTrace(traceInput());
  assert.equal(store.saveFrame(trace.id, 'recall', framePayload()), true);
  // A second trace carries the ancient frame: the primary key is
  // (trace_id, slot), so two frames need two traces.
  const oldTrace = store.beginTrace(traceInput({ turnId: 'turn-old' }));
  store.db
    .prepare(
      `INSERT INTO dream_frames
         (trace_id, slot, frame_v, owner, session_id, box, corpus_stamp_id, payload, bytes, created_at)
       VALUES (?, 'recall', 1, ?, NULL, '{}', 'stamp-1', '{}', 2, 1000)`,
    )
    .run(oldTrace.id, ASSISTANT_MEMORY_OWNER);
  assert.equal(count(store, 'dream_frames'), 2);

  // The cut sits a minute in the past, not at a freshly read Date.now():
  // saveFrame stamps created_at = Date.now(), and a clock tick of >= 1 ms
  // between the two reads would count the fresh frame as older than the cut
  // and sweep it too - a flake, not a finding.
  const swept = store.sweepDreamFrames(Date.now() - 60_000);

  assert.equal(swept, 1);
  assert.equal(count(store, 'dream_frames'), 1, 'the fresh frame stays');
  store.close();
});

test('the trace sweep works in batches and cascades touches and frames', () => {
  const store = makeStore();
  const insertTrace = store.db.prepare(
    `INSERT INTO dream_traces (id, turn_id, owner, kind, site, pipeline, policy_set, started_at, created_at)
     VALUES (?, ?, ?, 'turn', 'turn', 'assistant', '{}', 1000, 1000)`,
  );
  const insertTouch = store.db.prepare(
    'INSERT INTO memory_touches (id, owner, memory_id, turn_id, trace_id, at) VALUES (?, ?, ?, ?, ?, 1000)',
  );
  const insertFrame = store.db.prepare(
    `INSERT INTO dream_frames
       (trace_id, slot, frame_v, owner, session_id, box, corpus_stamp_id, payload, bytes, created_at)
     VALUES (?, 'recall', 1, ?, NULL, '{}', 'stamp-1', '{}', 2, 1000)`,
  );
  // 1200 traces: more than two full batches, so the loop has to go around.
  for (let index = 0; index < 1200; index += 1) {
    const id = 'trace-' + index;
    insertTrace.run(id, 'turn-' + index, ASSISTANT_MEMORY_OWNER);
    if (index % 10 === 0) insertTouch.run('touch-' + index, ASSISTANT_MEMORY_OWNER, 'memory-' + index, 'turn-' + index, id);
    if (index % 50 === 0) insertFrame.run(id, ASSISTANT_MEMORY_OWNER);
  }
  assert.equal(count(store, 'dream_traces'), 1200);
  assert.ok(count(store, 'memory_touches') > 0);
  assert.ok(count(store, 'dream_frames') > 0);

  const swept = store.sweepDreamTraces(Date.now());

  assert.equal(swept, 1200);
  assert.equal(count(store, 'dream_traces'), 0);
  assert.equal(count(store, 'memory_touches'), 0, 'touches cascade with their traces');
  assert.equal(count(store, 'dream_frames'), 0, 'frames cascade with their traces');
  store.close();
});

test('the corpus fingerprint reads document frequencies and caches itself in meta', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'fact', content: 'The deploy pipeline fails when tests flake.', tags: ['deploy'] });

  const stamp = store.corpusFingerprint(ASSISTANT_MEMORY_OWNER, ['deploy', 'pipeline', 'absent-token']);

  assert.ok(stamp.df.deploy >= 1, 'a token that occurs reads its document frequency');
  assert.ok(stamp.df.pipeline >= 1);
  assert.equal(stamp.df['absent-token'], 0, 'a token the index never saw reads zero');
  assert.ok(stamp.at > 0);

  const current = store.currentCorpusStamp(ASSISTANT_MEMORY_OWNER);
  assert.equal(current.id, stamp.id, 'the fresh stamp is the current one');
  assert.deepEqual(current.df, stamp.df);
  assert.equal(store.currentCorpusStamp('somebody-else'), null, 'an owner without a stamp reads null');
  store.close();
});

test('a superseded corpus stamp is pruned unless a frame still cites it', () => {
  const store = makeStore();
  store.upsertMemory({ kind: 'fact', content: 'The deploy pipeline fails when tests flake.' });
  const stamps = () =>
    store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'dream.corpus_stamp.%'").get().n;

  // Night one stamps; a frame recorded under that stamp cites it.
  const first = store.corpusFingerprint(ASSISTANT_MEMORY_OWNER, ['deploy']);
  const trace = store.beginTrace(traceInput());
  assert.equal(store.saveFrame(trace.id, 'recall', framePayload({ corpusStampId: first.id })), true);

  // Night two moves the pointer: the cited stamp survives, ...
  const second = store.corpusFingerprint(ASSISTANT_MEMORY_OWNER, ['deploy', 'pipeline']);
  assert.notEqual(second.id, first.id);
  assert.ok(store.getMeta('dream.corpus_stamp.' + first.id), 'the cited stamp stays readable');
  assert.ok(store.getMeta('dream.corpus_stamp.' + second.id));

  // ... and once nothing cites a stamp any more, the next move takes it -
  // meta must not grow a full df map per night without bound.
  const third = store.corpusFingerprint(ASSISTANT_MEMORY_OWNER, ['deploy']);
  assert.equal(store.getMeta('dream.corpus_stamp.' + second.id), null, 'the uncited stamp is pruned');
  assert.ok(store.getMeta('dream.corpus_stamp.' + first.id), 'the cited stamp still stays');
  assert.equal(stamps(), 2);
  assert.equal(store.currentCorpusStamp(ASSISTANT_MEMORY_OWNER).id, third.id);
  store.close();
});

test('framesFor hands frames back with their traces', () => {
  const store = makeStore();
  const trace = store.beginTrace(traceInput());
  const frame = framePayload();
  assert.equal(store.saveFrame(trace.id, 'recall', frame), true);

  const rows = store.framesFor(ASSISTANT_MEMORY_OWNER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].trace.id, trace.id);
  assert.equal(rows[0].trace.policySet.recall.limit, POLICY.limit);
  assert.equal(rows[0].frame.slot, 'recall');
  assert.equal(rows[0].frame.traceId, trace.id);
  assert.deepEqual(rows[0].frame.payload, frame);
  assert.equal(rows[0].frame.bytes, Buffer.byteLength(JSON.stringify(frame), 'utf8'));
  assert.equal(store.framesFor('somebody-else').length, 0);
  store.close();
});

test('framesFor cuts the limit from the end the caller asks for', () => {
  const store = makeStore();
  // Six frames, one a day apart. The default pool takes them from the old
  // end; `newest` takes them from the new one - and hands both back oldest
  // first, so the last entry is the newest either way and every caller that
  // reads a box or a trailing slice off the tail keeps reading the same
  // thing.
  const at = [];
  for (let index = 0; index < 6; index += 1) {
    const trace = store.beginTrace(traceInput({ turnId: 'turn-' + index, sessionId: 'session-' + index }));
    assert.equal(store.saveFrame(trace.id, 'recall', framePayload()), true);
    const created = 1_700_000_000_000 + index * 86_400_000;
    store.db.prepare('UPDATE dream_frames SET created_at = ? WHERE trace_id = ?').run(created, trace.id);
    at.push({ traceId: trace.id, created });
  }

  const all = store.framesFor(ASSISTANT_MEMORY_OWNER);
  assert.deepEqual(all.map((row) => row.frame.createdAt), at.map((row) => row.created));

  const oldest = store.framesFor(ASSISTANT_MEMORY_OWNER, { limit: 2 });
  assert.deepEqual(
    oldest.map((row) => row.frame.createdAt),
    [at[0].created, at[1].created],
    'the default cut is still the oldest rows - the grid probe walks and reports exactly that pool',
  );

  const newest = store.framesFor(ASSISTANT_MEMORY_OWNER, { limit: 2, newest: true });
  assert.deepEqual(
    newest.map((row) => row.frame.createdAt),
    [at[4].created, at[5].created],
    'the newest cut takes the other end, ascending',
  );
  assert.equal(newest[newest.length - 1].trace.id, at[5].traceId, 'and the tail is the newest frame');

  // Below the cap the two agree: `newest` changes which rows fall out, never
  // the order of the rows that stay.
  assert.deepEqual(
    store.framesFor(ASSISTANT_MEMORY_OWNER, { newest: true }).map((row) => row.frame.createdAt),
    all.map((row) => row.frame.createdAt),
  );
  // And `since` still selects on the frame's own creation, from either end.
  const recent = store.framesFor(ASSISTANT_MEMORY_OWNER, { since: at[4].created, newest: true });
  assert.deepEqual(recent.map((row) => row.frame.createdAt), [at[4].created, at[5].created]);
  store.close();
});

test('finishTrace pins degraded and closes the trace', () => {
  const store = makeStore();
  const trace = store.beginTrace(traceInput());
  store.finishTrace(trace.id, { degraded: 'no-tokens' });
  let row = store.db.prepare('SELECT degraded, finished_at FROM dream_traces WHERE id = ?').get(trace.id);
  assert.equal(row.degraded, 'no-tokens');
  assert.ok(row.finished_at > 0);

  // An explicit null is a real value: the call did not degrade.
  const second = store.beginTrace(traceInput({ turnId: 'turn-2' }));
  store.finishTrace(second.id, { degraded: null });
  row = store.db.prepare('SELECT degraded, finished_at FROM dream_traces WHERE id = ?').get(second.id);
  assert.equal(row.degraded, null);
  assert.ok(row.finished_at > 0);
  assert.equal(store.openTraces().length, 0);
  store.close();
});
