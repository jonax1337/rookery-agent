import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_MEMORY_OWNER,
  DEFAULT_CONFIG,
  ProviderRegistry,
  SleepRunner,
  Store,
  allocateNightBudget,
  bootstrapCi,
  buildGrid,
  corpusDrifted,
  describeSleep,
  fetchFrame,
  freshnessCheck,
  linkEntities,
  resolvePolicy,
  runGridProbe,
} from '../dist/index.js';

/**
 * The grid probe and the freshness test (dream stage 1, AP10).
 *
 * The load-bearing assertions are the contracts, not the numbers: the probe
 * never writes to the bank (R6 - a watcher that feeds the feedback loop it
 * watches would be worse than no watcher), it runs in a night without a
 * provider (R8 - the one night where it is the only thing that could run),
 * it reads the bank BEFORE the cycles (R7 - otherwise it would measure the
 * night's own condensation, not frame ageing), the wall clock bites without
 * throwing, abstention reasons are counted rather than swallowed, and frames
 * older than an import or reindex abstain as corpus-invalidated, never
 * guessed as corpus-drifted.
 *
 * Frozen clock (pattern from dream-frame.test.js): `recency`, the recorder
 * and the probe's fresh fetch all read `Date.now()`, so a frame recorded
 * outside the freeze drifts against its own live re-fetch. Freezing around
 * both makes the quiet-bank comparison honest instead of lucky.
 */

const FIXED_NOW = Date.parse('2026-09-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function withFrozenClock(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

async function withFrozenClockAsync(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return await run();
  } finally {
    Date.now = realNow;
  }
}

/** Throwaway skills directories, swept up when the process ends. */
const tempSkillDirs = [];
process.on('exit', () => {
  for (const dir of tempSkillDirs) rmSync(dir, { recursive: true, force: true });
});

const openStores = [];
after(() => {
  for (const store of openStores) {
    try {
      store.close();
    } catch {
      // already closed
    }
  }
});

function makeStore() {
  const store = new Store(':memory:');
  openStores.push(store);
  return store;
}

function makeConfig(dream = {}, sleep = {}, extra = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...extra,
    memory: {
      ...DEFAULT_CONFIG.memory,
      dream: { ...DEFAULT_CONFIG.memory.dream, ...dream },
      sleep: { ...DEFAULT_CONFIG.memory.sleep, ...sleep },
    },
  };
}

/** The declared box the recorder hands `fetchFrame` (mirrors runtime.ts, AP9). */
function declaredBox(policy, limitMax = 16) {
  const weight = (value) => [Math.max(0, value - 0.1), Math.min(1, value + 0.1)];
  return {
    limitMax,
    w: {
      relevance: weight(policy.w.relevance),
      importance: weight(policy.w.importance),
      recency: weight(policy.w.recency),
      usage: weight(policy.w.usage),
    },
    threshold: [Math.min(0.05, policy.threshold), Math.max(0.3, policy.threshold)],
    hopEntity: [Math.max(0, policy.hopEntity - 0.15), Math.min(1, policy.hopEntity + 0.15)],
    hopEdge: [Math.max(0, policy.hopEdge - 0.2), Math.min(1, policy.hopEdge + 0.2)],
    kinds: policy.kinds,
    minImportance: policy.minImportance,
  };
}

function seedBank(store) {
  const manifest = store.upsertMemory({
    kind: 'fact',
    content: 'The harbor manifest lists every incoming cargo.',
    tags: ['harbor'],
    importance: 0.9,
  });
  const logbook = store.upsertMemory({
    kind: 'preference',
    content: 'The user keeps the harbor logbook locked away.',
    tags: ['harbor'],
    importance: 0.5,
    pinned: true,
  });
  const ledger = store.upsertMemory({
    kind: 'fact',
    content: 'The ledger records the tides at the quay.',
    tags: ['ledger'],
    importance: 0.55,
  });
  return { manifest, logbook, ledger };
}

/** Record one finished traced frame the way the recorder (AP9) would. */
function recordFrame(store, config, text, { sessionId, turnId } = {}) {
  const owner = ASSISTANT_MEMORY_OWNER;
  const policy = resolvePolicy(store, config, owner, 'recall');
  const frame = fetchFrame(store, {
    text,
    owner,
    limit: policy.limit,
    box: declaredBox(policy),
    site: 'turn',
    pipeline: 'assistant',
    budgetChars: Math.floor(config.memory.contextBudget * 0.4),
    subject: 'this user',
  });
  const trace = store.beginTrace({
    turnId: turnId ?? randomUUID(),
    owner,
    kind: 'turn',
    site: 'turn',
    pipeline: 'assistant',
    sessionId,
    sessionKind: 'chat',
    policySet: { recall: policy },
    framed: true,
  });
  assert.equal(store.saveFrame(trace.id, 'recall', frame), true, 'the fixture frame fits the cap');
  store.finishTrace(trace.id, { degraded: frame.degraded });
  return { trace, frame };
}

/** `access_count` and `usefulness` of every row - what a write would move. */
function bankCounters(store) {
  return store.db.prepare('SELECT id, access_count, usefulness FROM memories ORDER BY id').all();
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

/** Rows of the one meta write the probe is allowed (the nightly stamp, R10). */
function stampCount(store) {
  return store.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'dream.corpus_stamp.%'").get().n;
}

/** A provider that answers the night's prompts from a scripted table. */
function scriptedProvider(replies = {}) {
  return {
    id: 'claude',
    displayName: 'Scripted',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(options) {
      const prompt = options.prompt ?? '';
      let text = '{}';
      if (prompt.includes('You are tidying')) text = replies.condense ?? '{"merge":false}';
      else if (prompt.includes('You decide whether one conversation')) text = replies.triage ?? '{"worth":false}';
      yield { type: 'done', text };
    },
  };
}

function makeNightRunner(store, config, provider) {
  return new SleepRunner({
    store,
    registry: new ProviderRegistry(provider ? [provider] : []),
    config,
  });
}

/* -------------------------------- the grid ------------------------------- */

test('the grid is fixed and deterministic, and the incumbent is always in it', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig();
    const owner = ASSISTANT_MEMORY_OWNER;
    const policy = resolvePolicy(store, config, owner, 'recall');
    const box = declaredBox(policy);
    try {
      const grid = buildGrid(policy, box, 10);
      assert.ok(grid.length >= 8 && grid.length <= 12, 'the stage prescribes 8 to 12 placements');
      assert.deepEqual(grid, buildGrid(policy, box, 10), 'the grid is not drawn at random');
      // Concept 6.3: the incumbent is always a candidate, in the same pass.
      assert.deepEqual(grid[0], {
        limit: policy.limit,
        threshold: policy.threshold,
        hopEntity: policy.hopEntity,
        hopEdge: policy.hopEdge,
        w: policy.w,
      });
      // Every placement sits inside the box it will be scored against - a
      // point outside would abstain as limit-out-of-box, a recorder error.
      for (const placement of grid) {
        assert.ok(placement.limit <= box.limitMax);
        for (const key of ['relevance', 'importance', 'recency', 'usage']) {
          assert.ok(placement.w[key] >= box.w[key][0] - 1e-9);
          assert.ok(placement.w[key] <= box.w[key][1] + 1e-9);
        }
        assert.ok(placement.threshold >= box.threshold[0] && placement.threshold <= box.threshold[1]);
        assert.ok(placement.hopEntity >= box.hopEntity[0] && placement.hopEntity <= box.hopEntity[1]);
        assert.ok(placement.hopEdge >= box.hopEdge[0] && placement.hopEdge <= box.hopEdge[1]);
      }
      // gridSize is clamped into the 8..12 the stage prescribes (E21).
      assert.equal(buildGrid(policy, box, 2).length, 8);
      assert.equal(buildGrid(policy, box, 500).length, 12);
    } finally {
      store.close();
    }
  });
});

test('bootstrapping over sessions is wider than bootstrapping over traces', () => {
  // Two sessions of ten near-duplicate traces each: every trace inside a
  // session carries the same delta, the sessions differ. Sampling sessions
  // reproduces the extremes; sampling traces averages them away - which is
  // exactly the understatement per-trace clustering would commit (E3).
  const sessionDeltas = [Array(10).fill(0.1), Array(10).fill(-0.1)];
  const traceDeltas = sessionDeltas.flat().map((delta) => [delta]);
  const width = (ci) => ci.high - ci.low;
  const session = bootstrapCi(sessionDeltas);
  const trace = bootstrapCi(traceDeltas);
  assert.ok(session && trace);
  assert.ok(width(session) > width(trace), 'the session interval must be the wider one');
  assert.ok(width(session) > 0.19, 'the session interval reaches both extremes');
  assert.ok(width(trace) < 0.19, 'the trace interval averages inside them');
  assert.equal(bootstrapCi([[], []]), null, 'nothing to draw from is null, not zero');
});

/* ------------------------------ the keys fix ------------------------------ */

test("the budget tuple is derived from its sub-lists, so no key can go missing (R20)", () => {
  const VOLUME = ['condense', 'resolve', 'link'];
  const JUDGEMENT = ['reflect', 'revise', 'practise'];
  const KEYS = [...VOLUME, ...JUDGEMENT];
  assert.deepEqual([...KEYS].sort(), [...VOLUME, ...JUDGEMENT].sort());

  // The mirror of `NightDemand`: every key of the interface, no others.
  const canonicalDemand = () => ({ condense: 2, resolve: 1, link: 3, reflect: 1, revise: 1, practise: 1 });
  assert.deepEqual(Object.keys(canonicalDemand()).sort(), [...KEYS].sort());

  // The end-to-end arm of the fix: every demand key reaches `funded`, so a
  // phase guard never reads undefined and runs unbudgeted (H4).
  const ceilings = { condense: 9, resolve: 9, link: 9, reflect: 9, revise: 9, practise: 9 };
  const budgets = allocateNightBudget(canonicalDemand(), 100, ceilings);
  assert.deepEqual(Object.keys(budgets).sort(), [...KEYS].sort());

  // And the overflow arm still holds: the parts never exceed the wallet.
  const squeezed = allocateNightBudget(canonicalDemand(), 4, ceilings);
  const total =
    squeezed.condense + squeezed.resolve + squeezed.link +
    squeezed.reflect + squeezed.revise + squeezed.practise;
  assert.ok(total <= 4, 'the squeezed night stays inside its wallet');
  assert.equal(squeezed.reflect + squeezed.revise + squeezed.practise, 3, 'the judgement phases keep their handful');
});

/* ----------------------------- corpus drift ----------------------------- */

test('corpus drift is the largest relative df move over the frame tokens (R10)', () => {
  const frame = { query: { tokens: ['harbor', 'ledger'] } };
  const recorded = { id: 'stamp-a', owner: ASSISTANT_MEMORY_OWNER, at: 1, df: { harbor: 10, ledger: 2 } };
  const same = { ...recorded, id: 'stamp-b', at: 2, df: { harbor: 10, ledger: 2 } };
  const slight = { ...recorded, id: 'stamp-c', at: 3, df: { harbor: 11, ledger: 2 } };
  const moved = { ...recorded, id: 'stamp-d', at: 4, df: { harbor: 10, ledger: 4 } };
  const appeared = { ...recorded, id: 'stamp-e', at: 5, df: { harbor: 10, ledger: 2, quay: 0 } };

  assert.equal(corpusDrifted(frame, same, 0.25, recorded), false, 'an unchanged corpus does not abstain');
  assert.equal(corpusDrifted(frame, slight, 0.25, recorded), false, '10 percent is inside the tolerance');
  assert.equal(corpusDrifted(frame, moved, 0.25, recorded), true, 'df 2 to 4 is a full move');
  assert.equal(corpusDrifted(frame, appeared, 0.25, recorded), false, 'tokens the frame never had are not its drift');
  // A frame recorded before any night stamped a fingerprint certifies
  // nothing: waived, not condemned - abstaining the whole first pool would
  // kill the very first probe.
  assert.equal(corpusDrifted(frame, same, 0.25, null), false);
});

test('a stamp gap is unknown, not df zero: unmeasured tokens never abstain as drift', () => {
  // The nightly stamp covers only the tokens of its own pool (R10), so a
  // frame asking about something that entered the bank after the recording
  // night carries a token the stamp never measured. That is not "df 0 then,
  // df 2 now" - the corpus did not move, the measurement was never taken.
  const frame = { query: { tokens: ['harbor', 'freshword'] } };
  const recorded = { id: 'stamp-a', owner: ASSISTANT_MEMORY_OWNER, at: 1, df: { harbor: 10 } };
  const today = { id: 'stamp-b', owner: ASSISTANT_MEMORY_OWNER, at: 2, df: { harbor: 10, freshword: 2 } };

  assert.equal(corpusDrifted(frame, today, 0.25, recorded), false, 'an unmeasured token is not drift');
  // The token both stamps measured still decides alone.
  const moved = { ...today, df: { harbor: 20, freshword: 2 } };
  assert.equal(corpusDrifted(frame, moved, 0.25, recorded), true);
  // A token missing from today's side is equally unknown - both sides must
  // have a df before a relative move exists.
  const shrunkToday = { id: 'stamp-c', owner: ASSISTANT_MEMORY_OWNER, at: 3, df: { freshword: 2 } };
  assert.equal(corpusDrifted(frame, shrunkToday, 0.25, recorded), false);
  // Nothing covered on both sides: waived, never guessed - an empty-pool
  // night must not condemn every frame recorded after it.
  const emptyStamp = { id: 'stamp-d', owner: ASSISTANT_MEMORY_OWNER, at: 4, df: {} };
  assert.equal(corpusDrifted(frame, today, 0.25, emptyStamp), false);
});

/* ------------------------------ the probe ------------------------------ */

test('a full probe writes nothing to the bank and counts every reason (R6)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig({ enabled: true });
    seedBank(store);
    recordFrame(store, config, 'What does the harbor manifest list?', { sessionId: 'session-one' });
    recordFrame(store, config, 'harbor ledger question', { sessionId: 'session-two' });
    const before = bankCounters(store);
    const stampsBefore = stampCount(store);

    const report = runGridProbe(store, config, ASSISTANT_MEMORY_OWNER, 'run-r6', new AbortController().signal);

    assert.equal(report.error, null);
    assert.equal(report.frames, 2);
    assert.equal(report.tracesSeen, 2);
    assert.ok(report.framesScored > 0, 'grid scorings happened');
    assert.ok(report.placements.length >= 8 && report.placements.length <= 12);
    // Stage 1 supplies no gain, and the report says so instead of inventing
    // a number: every placement abstains with no-reachable-label.
    assert.ok(report.placements.every((placement) => placement.delta === null));
    assert.ok(report.abstainReasons['no-reachable-label'] > 0);
    // Counted, never swallowed: the histogram carries every reason, zeroed.
    for (const reason of ['corpus-drifted', 'corpus-invalidated', 'budget-changed', 'unfinished', 'degraded-turn']) {
      assert.ok(report.abstainReasons[reason] >= 0, reason + ' is counted');
    }
    assert.ok(report.freshness, 'the freshness sensor ran over the eligible frames');
    assert.equal(report.freshness.frames, 2);
    assert.equal(typeof report.freshness.rowsDifferShare, 'number');

    // The R6 contract itself: `touch: false` is not a flag anywhere in the
    // probe - `fetchFrame` has no touch path at all - and this is the proof.
    assert.deepEqual(bankCounters(store), before);
    // And the one meta write there is, is the nightly corpus stamp (R10) -
    // pinned so a second write path cannot slip in unnoticed.
    assert.ok(stampCount(store) <= stampsBefore + 1, 'at most one corpus stamp row per probe run');
  });
});

test('with a supplied gain the placements carry paired deltas and intervals', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig({ enabled: true });
    const { manifest } = seedBank(store);
    recordFrame(store, config, 'What does the harbor manifest list?', { sessionId: 'session-one' });
    recordFrame(store, config, 'harbor manifest again', { sessionId: 'session-two' });

    const gain = (id) => (id === manifest.id ? 1 : 0);
    const report = runGridProbe(store, config, ASSISTANT_MEMORY_OWNER, 'run-gain', new AbortController().signal, { gain });

    assert.equal(report.error, null);
    const incumbent = report.placements[0];
    assert.equal(incumbent.incumbent, true);
    assert.equal(incumbent.delta, 0, 'the incumbent is compared with itself in the same pass');
    assert.equal(typeof incumbent.coverage, 'number', 'coverage is reported per placement (R2)');
    const moved = report.placements.slice(1).filter((placement) => placement.delta !== null);
    assert.ok(moved.length > 0, 'at least one placement differs from the incumbent');
    for (const placement of moved) {
      assert.equal(typeof placement.ciLow, 'number');
      assert.equal(typeof placement.ciHigh, 'number');
      assert.ok(placement.ciHigh >= placement.ciLow);
    }
    // One session per frame here, so the clusters are the sessions.
    assert.equal(report.framesScored, report.frames * report.placements.length);
  });
});

test('the freshness report shows its own test strength (open question 11)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig({ enabled: true });
    const { manifest } = seedBank(store);
    recordFrame(store, config, 'What does the harbor manifest list?', { sessionId: 'session-one' });
    const entries = store.framesFor(ASSISTANT_MEMORY_OWNER);
    assert.equal(entries.length, 1);

    const options = {
      config,
      gain: (id) => (id === manifest.id ? 1 : 0),
      baseline: { limit: 8 },
      candidate: { limit: 8, threshold: 0.3 },
    };
    // A quiet bank under a frozen clock: frozen and live are the same world,
    // and the report must say that the test had no teeth rather than hide it.
    const quiet = freshnessCheck(store, entries, options);
    assert.equal(quiet.frames, 1);
    assert.equal(quiet.rowsDifferShare, 0);
    assert.equal(quiet.deltaFrozen, quiet.deltaLive);
    assert.notEqual(quiet.signAgree, 0, 'a quiet bank never flips a sign');

    // Move the bank: a new row the query reaches changes the live frame.
    store.upsertMemory({
      kind: 'fact',
      content: 'The harbor manifest also lists the tide tables.',
      tags: ['harbor'],
      importance: 0.4,
    });
    const moved = freshnessCheck(store, entries, options);
    assert.ok(moved.rowsDifferShare > 0, 'the share of frames whose rows moved is now visible');
  });
});

test('frames older than an import or reindex abstain as corpus-invalidated, not corpus-drifted', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig({ enabled: true });
    seedBank(store);
    recordFrame(store, config, 'What does the harbor manifest list?', { sessionId: 'session-one' });
    // An import stamped "now" invalidates the frame recorded "before" it.
    store.setMeta('dream.corpus_invalidated_at', String(FIXED_NOW + 1000));

    const report = runGridProbe(store, config, ASSISTANT_MEMORY_OWNER, 'run-inv', new AbortController().signal);

    assert.ok(report.abstainReasons['corpus-invalidated'] >= 1);
    assert.equal(report.abstainReasons['corpus-drifted'], 0, 'never guessed as drift');
    assert.equal(report.invalidated, 1);
    assert.equal(report.invalidatedAt, FIXED_NOW + 1000);
    assert.equal(report.framesScored, 0, 'the pre-check fires before any grid scoring');
    assert.equal(report.freshness, null, 'nothing eligible remains for the freshness sensor');
  });
});

test('a zero evaluation budget scores nothing and does not throw', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig({ enabled: true, maxEvalMs: 0 });
    seedBank(store);
    recordFrame(store, config, 'What does the harbor manifest list?', { sessionId: 'session-one' });

    const report = runGridProbe(store, config, ASSISTANT_MEMORY_OWNER, 'run-zero', new AbortController().signal);

    assert.equal(report.framesScored, 0);
    assert.equal(report.deadlineHit, true);
    assert.equal(report.error, null);
    assert.equal(typeof report.evalMs, 'number');
  });
});

test('a corrupted frame is reported, never thrown', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = makeConfig({ enabled: true });
    seedBank(store);
    recordFrame(store, config, 'What does the harbor manifest list?', { sessionId: 'session-one' });
    store.db.prepare('UPDATE dream_frames SET payload = ?').run('not json at all');

    const report = runGridProbe(store, config, ASSISTANT_MEMORY_OWNER, 'run-broken', new AbortController().signal);

    assert.ok(report.error, 'the failure reached the report');
    assert.equal(report.framesScored, 0);
  });
});

/* ------------------------------ the night ------------------------------ */

test('the probe reads the pre-cycle bank: a condensation victim is still in the fresh frame (R7)', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig();
    const first = store.upsertMemory({
      kind: 'fact',
      content: 'The harbor ledger is filed every evening.',
      tags: ['harbor', 'ledger'],
      importance: 0.6,
    });
    const second = store.upsertMemory({
      kind: 'fact',
      content: 'The harbor ledger is filed each evening before closing.',
      tags: ['harbor', 'ledger'],
      importance: 0.6,
    });
    // Two shared entities are what makes the night's #cluster pair them -
    // and #condense supersede exactly this pair, the one the day recalled.
    linkEntities(store, ASSISTANT_MEMORY_OWNER, first.id, ['harbor', 'ledger']);
    linkEntities(store, ASSISTANT_MEMORY_OWNER, second.id, ['harbor', 'ledger']);
    recordFrame(store, config, 'harbor ledger filing', { sessionId: 'session-r7' });

    // The probe, called where the night calls it: before the cycle loop.
    const probe = runGridProbe(store, config, ASSISTANT_MEMORY_OWNER, 'run-r7', new AbortController().signal);
    const freshFrame = probe.freshness?.entries[0]?.fresh;
    assert.ok(freshFrame, 'the freshness side fetched a live frame');
    assert.ok(freshFrame.hop1.some((row) => row.id === first.id), 'the victim is still there');
    assert.ok(freshFrame.hop1.some((row) => row.id === second.id));

    // And the night that follows really would condense that pair - which is
    // why a probe placed after the cycles would measure its own writing.
    const skillsDir = mkdtempSync(join(tmpdir(), 'rookery-dream-r7-'));
    tempSkillDirs.push(skillsDir);
    const nightConfig = makeConfig(undefined, {
      cycles: 1,
      nightBudget: 10,
      maxMergeCalls: 5,
      insights: 0,
      skillRevisions: 0,
      skills: 0,
      replaySessions: 0,
    }, { skillsDir });
    const runner = makeNightRunner(store, nightConfig, scriptedProvider({
      condense: JSON.stringify({
        merge: true,
        content: 'The harbor ledger is filed every evening before closing.',
        kind: 'fact',
        importance: 0.6,
        tags: ['harbor', 'ledger'],
        supersedes: [1, 2],
      }),
    }));
    const run = await runner.run({});
    assert.equal(run.status, 'done');
    const retired = store.getMemory(first.id);
    assert.ok(retired.supersededBy, 'the pair really was condensed after the probe ran');
  });
});

test('the probe runs in a night without a provider (R8)', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    seedBank(store);
    recordFrame(store, makeConfig({ enabled: true }), 'What does the harbor manifest list?', { sessionId: 'session-r8' });

    // An empty registry resolves no provider: replay, deep and rem all sit
    // out - and the model-free evaluation is the one thing that still runs.
    const runner = makeNightRunner(store, makeConfig({ enabled: true }), null);
    const run = await runner.run({});

    assert.equal(run.status, 'done');
    assert.equal(run.dreamTracesSeen, 1);
    assert.ok(run.dreamFramesScored > 0, 'grid scorings happened without a provider');
    assert.ok(run.report.includes('dream placements scored'), 'the counter reaches the report line');
  });
});

test('a zero evaluation budget leaves the night unharmed', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    seedBank(store);
    recordFrame(store, makeConfig({ enabled: true }), 'What does the harbor manifest list?', { sessionId: 'session-zero' });

    const runner = makeNightRunner(store, makeConfig({ enabled: true, maxEvalMs: 0 }), null);
    const run = await runner.run({});

    assert.equal(run.status, 'done');
    assert.equal(run.dreamFramesScored, 0, 'the wall clock bit before any scoring');
    assert.ok(!run.report.includes('dream placements scored'));
  });
});

test('the night names the import that invalidated frames (concept 3.3)', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    seedBank(store);
    recordFrame(store, makeConfig({ enabled: true }), 'What does the harbor manifest list?', { sessionId: 'session-inv' });
    store.setMeta('dream.corpus_invalidated_at', String(FIXED_NOW + 1000));

    const runner = makeNightRunner(store, makeConfig({ enabled: true }), null);
    const run = await runner.run({});

    assert.equal(run.status, 'done');
    assert.equal(run.dreamFramesScored, 0, 'an invalidated frame is never scored');
    assert.match(run.report ?? '', /1 of 1 dream frames unusable since the import\/reindex at/);
  });
});

test('the sweep runs at night end, past the frame retention clock (concept 8.7)', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    seedBank(store);
    recordFrame(store, makeConfig(), 'What does the harbor manifest list?', { sessionId: 'session-sweep' });
    // A frame older than frameRetainDays (45): backdate only the frame row -
    // the trace stays, its clock is retainDays (365).
    store.db.prepare('UPDATE dream_frames SET created_at = ?').run(FIXED_NOW - 46 * DAY);
    assert.equal(count(store, 'dream_frames'), 1);

    // The dream is switched OFF here on purpose: sweeping stored verbatim
    // text is hygiene (R17), not measurement, and must not need the probe.
    const runner = makeNightRunner(store, makeConfig(), null);
    const run = await runner.run({});

    assert.equal(run.status, 'done', 'the night does not throw over the sweep');
    assert.equal(count(store, 'dream_frames'), 0, 'the aged frame is gone');
    assert.equal(count(store, 'dream_traces'), 1, 'the small rows stay for calibration');
  });
});

test('describeSleep carries the dream counter once the probe scored', () => {
  const line = describeSleep({
    readCount: 5,
    mergedCount: 0,
    dormantCount: 0,
    edgeCount: 0,
    insightCount: 0,
    conflictCount: 0,
    dreamFramesScored: 12,
  });
  assert.ok(line.includes('12 dream placements scored'), line);
  assert.ok(!describeSleep({
    readCount: 5,
    mergedCount: 0,
    dormantCount: 0,
    edgeCount: 0,
    insightCount: 0,
    conflictCount: 0,
  }).includes('dream'), 'a night without the dream does not grow a clause');
});

test("a foreign-owner frame never enters the assistant night's pool (R18)", async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    seedBank(store);
    // An agent-owned frame in the pool: frames are filtered by owner, and
    // the night only probes the assistant's bank.
    const agentFrame = recordFrame(store, makeConfig({ enabled: true }), 'harbor ledger question', { sessionId: 'session-agent' });
    store.db.prepare('UPDATE dream_traces SET owner = ? WHERE id = ?').run('agent:mara', agentFrame.trace.id);
    store.db.prepare('UPDATE dream_frames SET owner = ? WHERE trace_id = ?').run('agent:mara', agentFrame.trace.id);

    const runner = makeNightRunner(store, makeConfig({ enabled: true }), null);
    const run = await runner.run({});

    assert.equal(run.status, 'done');
    assert.equal(run.dreamTracesSeen, 0, 'a foreign-owner frame never enters the pool');
  });
});

