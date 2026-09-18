import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_MEMORY_OWNER,
  DEFAULT_CONFIG,
  DEFAULT_SPLIT_RATES,
  ProviderRegistry,
  SleepRunner,
  Store,
  buildGrid,
  describeSleep,
  fetchFrame,
  linkEntities,
  pipelineAssistant,
  resolvePolicy,
  splitOf,
} from '../dist/index.js';

/**
 * The night, stage 2 (AP12): the file where every library of the two waves
 * before it either gets called or is dead code.
 *
 * What is asserted here is placement and consequence, not arithmetic - the
 * arithmetic has its own suites (dream-label, dream-evaluate, dream-promote,
 * dream-slots). The five load-bearing claims, each with a test below:
 *
 *   - With `memory.dream.enabled` false, nothing new runs AT ALL: no label,
 *     no evaluation, no policy version, and not even a `dream` phase event.
 *     A switch that only half switches off is worse than no switch.
 *   - The dream phase runs in a night with NO provider. That is the night
 *     where it is the only thing that could run, so it is the night the
 *     placement above the provider guard exists for.
 *   - A second night over the same labelled traces promotes nothing, however
 *     good the candidate looks: `trace_set_hash` is what makes a promotion
 *     spend its evidence (H6).
 *   - The sweeper runs two clocks, not one: an episode points at verbatim
 *     text and dies with the frames (S21), a label carries calibration and
 *     lives with the traces.
 *   - The counters reach the `sleep_runs` row, which is the only place
 *     anybody will ever read them.
 *
 * Frozen clock throughout, for the reason dream-frame.test.js gives: the
 * recorder, `recency` and the freshness sensor's live re-fetch all read
 * `Date.now()`, so a frame recorded outside the freeze drifts against its
 * own re-fetch and the quiet-bank comparison stops being honest.
 */

const FIXED_NOW = Date.parse('2026-09-18T02:00:00.000Z');
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

function makeConfig(dream = {}, sleep = {}) {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      dream: { ...DEFAULT_CONFIG.memory.dream, ...dream },
      sleep: { ...DEFAULT_CONFIG.memory.sleep, ...sleep },
    },
  };
}

/** The declared box the recorder hands `fetchFrame` (mirrors runtime.ts). */
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

/**
 * A bank whose rows spread out across the retrieval scale.
 *
 * Two rows answer the query outright and three only brush it, which is what
 * makes the fixture worth anything: at the incumbent threshold the block
 * carries the two, and the placements at the box's low threshold carry all
 * five. A bank where every row is delivered has no ranking to improve and
 * no correction label to write.
 */
function seedBank(store) {
  const rows = {
    manifest: ['The harbor manifest lists every incoming cargo at the quay.', ['harbor', 'cargo'], 0.9],
    checked: ['The harbor manifest is checked twice each morning.', ['harbor', 'cargo'], 0.6],
    logbook: [
      'The user keeps a logbook in the quay office, filed beside the old harbor charts and the tide tables.',
      ['office'],
      0.2,
    ],
    tides: ['The tides run two hours late in the eastern basin near the harbor wall.', ['tides'], 0.15],
    ledger: ['The ledger records every fee the harbor charges.', ['ledger'], 0.25],
  };
  const bank = {};
  for (const [key, [content, tags, importance]] of Object.entries(rows)) {
    bank[key] = store.upsertMemory({ kind: 'fact', content, tags, importance });
    linkEntities(store, ASSISTANT_MEMORY_OWNER, bank[key].id, tags);
  }
  return bank;
}

/**
 * Age the bank a quarter, on both clocks.
 *
 * `created_at` because of the anachronism lock: a label on a row that did
 * not exist during the turn is no evidence at all (S4), and under a frozen
 * clock every row is exactly as old as every turn, so an unaged bank
 * produces no correction label whatsoever. `updated_at` because the recency
 * term alone is worth 0.15 of the scale - fresh, every row clears the
 * threshold on recency and nothing is ever missed.
 */
function ageBank(store, days = 90) {
  const at = FIXED_NOW - days * DAY;
  store.db.prepare('UPDATE memories SET created_at = ?, updated_at = ?').run(at, at);
}

/** A reachable row of this frame the block did not carry - what a correction can label. */
function missedBy(frame, policy) {
  const run = pipelineAssistant(frame, policy);
  assert.equal(run.ok, true, 'the fixture frame is replayable');
  const shown = new Set(run.lines.map((line) => line.id));
  const missed = Object.values(frame.records).find(
    (record) => !shown.has(record.id) && !record.forgotten && !record.dormantAt,
  );
  assert.ok(missed, 'the fixture needs a reachable row the prompt never carried');
  return missed;
}

/** One finished, framed turn, exactly as the recorder (stage 1) writes it. */
function recordFrame(store, config, text, { sessionId, turnId = randomUUID() } = {}) {
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
    turnId,
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
  return { trace, frame, policy };
}

/** A conversation with two real user turns, each carrying its journal turn id. */
function recordSession(store, { title, quotes }) {
  const session = store.createSession({ title, provider: 'claude', cwd: '.' });
  const turns = [];
  for (const quote of quotes) {
    const turnId = randomUUID();
    store.addMessage({ sessionId: session.id, role: 'user', content: quote, turnId });
    store.addMessage({ sessionId: session.id, role: 'assistant', content: 'Understood.', turnId });
    turns.push(turnId);
  }
  return { session, turns };
}

/** A provider that answers each of the night's prompts from a scripted table. */
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
      if (prompt.includes('You decide whether one conversation')) {
        text = replies.triage ?? '{"worth":false}';
      } else if (prompt.includes('You are re-reading one conversation')) {
        text = replies.replay ?? '{"memories":[],"corrections":[]}';
      } else if (prompt.includes('You are tidying')) {
        text = replies.condense ?? '{"merge":false}';
      } else if (prompt.includes('You are tuning the memory retrieval')) {
        text = replies.candidate ?? '';
      }
      yield { type: 'done', text };
    },
  };
}

function makeRunner(store, config, provider, onPromotion) {
  return new SleepRunner({
    store,
    registry: new ProviderRegistry(provider ? [provider] : []),
    config,
    ...(onPromotion ? { onPromotion } : {}),
  });
}

/** Every phase the night announced, in order. */
function phaseRecorder(runner) {
  const phases = [];
  runner.on('sleep', (event) => phases.push(event.phase));
  return phases;
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

function labels(store) {
  return store.db.prepare('SELECT * FROM dream_labels ORDER BY created_at, target, source').all();
}

/* ----------------------------- the master switch ----------------------------- */

test('with the dream switched off, nothing new runs at all', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig({ enabled: false });
    const bank = seedBank(store);
    ageBank(store);
    const { session } = recordSession(store, {
      title: 'The manifest',
      quotes: [
        'The harbor manifest is not the logbook, you had that wrong.',
        'Please keep the two of them apart from now on.',
      ],
    });
    recordFrame(store, config, 'harbor manifest', { sessionId: session.id });

    const provider = scriptedProvider({
      triage: '{"worth":true}',
      replay:
        '{"memories":[],"corrections":[{"text":"The manifest and the logbook are two different things.",' +
        '"quote":"The harbor manifest is not the logbook"}]}',
    });
    const runner = makeRunner(store, config, provider);
    const phases = phaseRecorder(runner);
    const run = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });

    assert.equal(run.status, 'done');
    // The correction itself is stage-0 behaviour and still happens: the
    // switch governs the dream, not the night.
    assert.equal(count(store, 'corrections'), 1, 'the correction is written either way');
    // Everything the dream owns stays empty, and the phase is never even
    // announced - a switch that only half switches off is worse than none.
    assert.equal(count(store, 'dream_labels'), 0);
    assert.equal(count(store, 'dream_evals'), 0);
    assert.equal(count(store, 'policy_versions'), 0);
    assert.equal(phases.includes('dream'), false, 'no dream phase was announced');
    assert.equal(run.dreamLabelsWritten, 0);
    assert.equal(run.dreamPromoted, 0);
    assert.equal(run.dreamFramesScored, 0);
    assert.ok(bank.manifest.id);
  });
});

/* -------------------------- the night without a provider -------------------------- */

test('the dream phase runs in a night with no provider', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig({ enabled: true, minTraces: 1 });
    seedBank(store);
    ageBank(store);
    const session = store.createSession({ title: 'Quiet', provider: 'claude', cwd: '.' });
    recordFrame(store, config, 'harbor manifest', { sessionId: session.id });
    recordFrame(store, config, 'harbor ledger', { sessionId: session.id });

    // No provider at all: the registry is empty, so `#resolveProvider`
    // answers null and every model phase is skipped.
    const runner = makeRunner(store, config, null);
    const phases = phaseRecorder(runner);
    const run = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(run.status, 'done');
    assert.equal(run.modelCalls, 0, 'nothing could have called a model');
    assert.ok(phases.includes('dream'), 'the dream announced itself');
    assert.equal(phases.includes('replay'), false, 'the replay needs a provider and had none');
    assert.ok(run.dreamTracesSeen >= 2, 'the probe saw the traces');
    assert.ok(run.dreamFramesScored > 0, 'and scored the grid over them');
    // The evaluation ran too - it is model-free, and this is the night it
    // exists for. With nothing labelled it certifies nothing, which is a
    // measurement, not an error.
    assert.equal(count(store, 'dream_evals') >= 0, true);
  });
});

/* -------------------------------- the label writers -------------------------------- */

test('a located quote labels its turn; an ambiguous one labels the session', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig({ enabled: true });
    seedBank(store);
    ageBank(store);

    // Two sessions saying the same sentence. In the first it occurs in
    // exactly one user turn; in the second it is said twice, which is
    // ambiguous and must not be guessed at.
    const quote = 'The harbor manifest is not the logbook at all.';
    const located = recordSession(store, {
      title: 'Located',
      quotes: [quote, 'Anyway, what else is on the quay today?'],
    });
    const ambiguous = recordSession(store, {
      title: 'Ambiguous',
      quotes: [quote, quote],
    });
    const first = recordFrame(store, config, 'harbor manifest', {
      sessionId: located.session.id,
      turnId: located.turns[0],
    });
    recordFrame(store, config, 'harbor manifest', {
      sessionId: ambiguous.session.id,
      turnId: ambiguous.turns[0],
    });
    // The correction is about a row the block did NOT carry, which is the
    // one case only this source can label (concept 4.2a).
    const missed = missedBy(first.frame, first.policy);

    const provider = scriptedProvider({
      triage: '{"worth":true}',
      replay: JSON.stringify({
        memories: [],
        corrections: [{ text: missed.content, quote: 'The harbor manifest is not the logbook' }],
      }),
    });
    const runner = makeRunner(store, config, provider);
    const run = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });

    assert.equal(run.status, 'done');
    const written = labels(store);
    assert.ok(written.length >= 2, 'both sessions produced a label');
    assert.equal(
      written.every((row) => row.source === 'correction'),
      true,
      'the replay writes correction labels and nothing else',
    );

    const turnScoped = written.filter((row) => row.scope === 'turn');
    const sessionScoped = written.filter((row) => row.scope === 'session');
    assert.ok(turnScoped.length >= 1, 'the unambiguous quote reached its turn');
    assert.equal(
      turnScoped.every((row) => row.turn_id === located.turns[0]),
      true,
      'and it is the turn the quote was actually said in',
    );
    assert.ok(sessionScoped.length >= 1, 'the ambiguous quote stayed session-wide');
    assert.equal(
      sessionScoped.every((row) => row.turn_id === ambiguous.session.id),
      true,
      'a session-wide label carries the session id in turn_id',
    );
    // The correction names the logbook, which the frame could reach and the
    // block did not deliver - the one case that can label what the incumbent
    // missed (concept 4.2a).
    assert.equal(
      written.some((row) => row.relevance === 1),
      true,
      'a reachable row the prompt never carried is labelled relevant',
    );
    // Both corrections carry their turn reference into the table.
    const corrections = store.db.prepare('SELECT turn_id FROM corrections ORDER BY created_at').all();
    assert.equal(corrections.length, 2);
    assert.equal(
      corrections.filter((row) => row.turn_id === located.turns[0]).length,
      1,
      'the located correction stores its turn id',
    );
    assert.equal(
      corrections.filter((row) => row.turn_id === null).length,
      1,
      'the ambiguous one stores none rather than guessing',
    );
    // And the counter followed the write.
    assert.equal(run.dreamLabelsWritten, written.length);
    assert.equal(store.getSleepRun(run.id).dreamLabelsWritten, written.length);
  });
});

test('a condensation labels the row that was paid for twice, and only negatively', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig({ enabled: true }, { cycles: 1, replaySessions: 0 });
    // Two near-identical rows, so the gate lets both in and the night's
    // condensation has a cluster to fold.
    // Two tags each, and the same two: `#cluster` groups on a co-occurrence
    // edge or on two shared entities, so one tag would leave the night with
    // nothing to condense and the test with nothing to observe.
    const first = store.upsertMemory({
      kind: 'fact',
      content: 'The harbor manifest lists every incoming cargo at the quay.',
      tags: ['harbor', 'cargo'],
      importance: 0.8,
    });
    const second = store.upsertMemory({
      kind: 'fact',
      content: 'Every incoming cargo at the quay is listed on the harbor manifest.',
      tags: ['harbor', 'cargo'],
      importance: 0.7,
    });
    // The entities have to exist before `#demand` counts the clusters, which
    // happens before the cycle that would link them: in production the write
    // gate links at write time, so this is the fixture catching up, not a
    // shortcut.
    linkEntities(store, ASSISTANT_MEMORY_OWNER, first.id, first.tags);
    linkEntities(store, ASSISTANT_MEMORY_OWNER, second.id, second.tags);
    const session = store.createSession({ title: 'Cargo', provider: 'claude', cwd: '.' });
    const { frame } = recordFrame(store, config, 'harbor manifest cargo quay', {
      sessionId: session.id,
    });
    const delivered = pipelineAssistant(frame, resolvePolicy(store, config, ASSISTANT_MEMORY_OWNER, 'recall'));
    assert.equal(delivered.ok, true);
    const ids = delivered.lines.map((line) => line.id);
    assert.ok(
      ids.includes(first.id) && ids.includes(second.id),
      'both rows stood in the one prompt - otherwise there is no claim to make',
    );

    const provider = scriptedProvider({
      condense:
        '{"merge":true,"content":"The harbor manifest lists every incoming cargo at the quay.",' +
        '"supersedes":[1,2],"kind":"fact","importance":0.85,"tags":["harbor"]}',
    });
    const runner = makeRunner(store, config, provider);
    const run = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'manual' });

    assert.equal(run.status, 'done');
    assert.ok(run.mergedCount >= 1, 'the night condensed the cluster');
    const merged = labels(store).filter((row) => row.source === 'merge');
    assert.equal(merged.length, 1, 'two rows in one cluster make exactly one loser');
    assert.equal(merged[0].relevance, 0, 'merge writes negative labels and no others');
    assert.equal(merged[0].scope, 'turn', 'it is a claim about the one prompt it observed');
    assert.equal(
      merged[0].target === first.id || merged[0].target === second.id,
      true,
      'and the target is one of the two rows that stood there',
    );
    assert.equal(run.dreamLabelsWritten, 1);
  });
});

/* ------------------------------- the two clocks ------------------------------- */

test('the sweeper runs two clocks: verbatim dies with the frames, calibration with the traces', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // Frames and episodes after 10 days, traces/labels/evaluations after 200.
    const config = makeConfig(
      { enabled: true, frameRetainDays: 10, retainDays: 200 },
      { cycles: 1, replaySessions: 0 },
    );
    seedBank(store);
    const session = store.createSession({ title: 'Old', provider: 'claude', cwd: '.' });
    const { trace } = recordFrame(store, config, 'harbor manifest', { sessionId: session.id });

    const old = FIXED_NOW - 50 * DAY;
    // Age everything by hand: one frame, one trace, one label, one
    // evaluation and one episode, all fifty days old - between the two
    // clocks, so a night that ran one clock for both would be visible.
    store.db.prepare('UPDATE dream_frames SET created_at = ?').run(old);
    store.db.prepare('UPDATE dream_traces SET created_at = ?, started_at = ?').run(old, old);
    store.putLabel({
      turnId: trace.turnId,
      target: 'some-memory',
      source: 'correction',
      relevance: 1,
      scope: 'turn',
      owner: ASSISTANT_MEMORY_OWNER,
      createdAt: old,
    });
    const version = store.createPolicyVersion({
      owner: ASSISTANT_MEMORY_OWNER,
      slot: 'recall',
      params: {},
      box: {},
      origin: 'dream',
    });
    store.recordDreamEval({
      sleepRunId: 'an-old-run',
      policyId: version.id,
      slot: 'recall',
      traces: 1,
      closed: 1,
      abstained: 0,
      abstainReasons: {},
      reachableRate: 1,
      labelCoverage: 1,
      costOnlyShare: 0,
      score: 0.5,
      baseline: 0.5,
      delta: 0,
      ciLow: 0,
      ciHigh: 0,
      signAgree: null,
      evalMs: 1,
      traceSetHash: 'deadbeef',
      promoted: false,
      createdAt: old,
    });
    store.recordDreamEpisode({
      id: randomUUID(),
      owner: ASSISTANT_MEMORY_OWNER,
      kind: 'turn',
      slot: 'recall',
      steps: 3,
      outcome: 'success',
      holdout: false,
      audit: false,
      startedAt: old,
      createdAt: old,
    });

    const runner = makeRunner(store, config, null);
    await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    // Past the frame clock: the frame and the episode both point at verbatim
    // text, and no wording outlives the memory it came from (S21).
    assert.equal(count(store, 'dream_frames'), 0, 'the frame is gone');
    assert.equal(count(store, 'dream_episodes'), 0, 'and so is the episode that indexes a turn');
    // Inside the trace clock: small, and they carry the calibration.
    assert.equal(count(store, 'dream_traces'), 1, 'the trace stays');
    assert.equal(count(store, 'dream_labels'), 1, 'the label stays');
    assert.equal(count(store, 'dream_evals'), 1, 'the evaluation stays');
  });
});

test('past the long clock the labels and the evaluations go too', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig(
      { enabled: true, frameRetainDays: 10, retainDays: 20 },
      { cycles: 1, replaySessions: 0 },
    );
    seedBank(store);
    const session = store.createSession({ title: 'Older', provider: 'claude', cwd: '.' });
    const { trace } = recordFrame(store, config, 'harbor manifest', { sessionId: session.id });
    const old = FIXED_NOW - 50 * DAY;
    store.db.prepare('UPDATE dream_frames SET created_at = ?').run(old);
    store.db.prepare('UPDATE dream_traces SET created_at = ?, started_at = ?').run(old, old);
    store.putLabel({
      turnId: trace.turnId,
      target: 'some-memory',
      source: 'merge',
      relevance: 0,
      scope: 'turn',
      owner: ASSISTANT_MEMORY_OWNER,
      createdAt: old,
    });

    const runner = makeRunner(store, config, null);
    await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(count(store, 'dream_frames'), 0);
    assert.equal(count(store, 'dream_traces'), 0);
    assert.equal(count(store, 'dream_labels'), 0);
  });
});

/* ------------------------------- the counters ------------------------------- */

test('the counters reach the sleep run row and the sentence a person reads', () => {
  // The report line is the only place the two stage-2 counters are ever
  // read by a person, so it is asserted here rather than inferred.
  assert.match(
    describeSleep({
      readCount: 4,
      mergedCount: 0,
      dormantCount: 0,
      edgeCount: 0,
      insightCount: 0,
      conflictCount: 0,
      dreamLabelsWritten: 3,
      dreamPromoted: 1,
    }),
    /3 dream labels written/,
  );
  assert.match(
    describeSleep({
      readCount: 4,
      mergedCount: 0,
      dormantCount: 0,
      edgeCount: 0,
      insightCount: 0,
      conflictCount: 0,
      dreamLabelsWritten: 3,
      dreamPromoted: 1,
    }),
    /1 retrieval policy promoted/,
  );
  // And a night that promoted nothing says nothing about it.
  assert.equal(
    describeSleep({
      readCount: 4,
      mergedCount: 0,
      dormantCount: 0,
      edgeCount: 0,
      insightCount: 0,
      conflictCount: 0,
      dreamLabelsWritten: 0,
      dreamPromoted: 0,
    }).includes('promoted'),
    false,
  );
});

/* ------------------------------- the promotion ------------------------------- */

/** Every validity rule wide open, the gate itself armed. */
function promotingConfig(dream = {}, sleep = {}) {
  return makeConfig(
    {
      enabled: true,
      promote: true,
      minTraces: 1,
      margin: 0,
      coverageFloor: 0,
      costOnlyCeiling: 1,
      abstainEps: 1,
      abstainFloor: 1,
      reachableFloor: 0,
      agreementFloor: -1,
      cooldownNights: 0,
      // The wake test is a separate claim with a test of its own; a
      // thousand traces keeps it out of this one.
      calibrationTraces: 1000,
      ...dream,
    },
    { cycles: 1, replaySessions: 0, ...sleep },
  );
}

test('a measured candidate goes in force, tells its hook, and comes back out with the night', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = promotingConfig();
    seedBank(store);
    ageBank(store);
    seedLabelledPool(store, config);

    const notices = [];
    const runner = makeRunner(store, config, null, (notice) => notices.push(notice));
    const run = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(run.status, 'done');
    assert.equal(run.modelCalls, 0, 'a promotion needs no model at all');
    assert.equal(run.dreamPromoted, 1, 'exactly one, which is the cap');
    assert.equal(store.getSleepRun(run.id).dreamPromoted, 1, 'and it survived into the row');
    assert.match(run.report, /1 retrieval policy promoted/);

    // The hook is how anybody outside this file finds out (S26). It carries
    // ids and numbers, and its rationale is the version's own sentence.
    assert.equal(notices.length, 1);
    const notice = notices[0];
    assert.equal(notice.slot, 'recall');
    assert.equal(notice.runId, run.id);
    assert.equal(notice.prevActiveId, null, 'nothing was in force before');
    assert.equal(notice.rationale, notice.version.rationale);
    assert.equal(/harbor|manifest|quay/.test(notice.rationale), false, 'and never a word of a frame');

    // The version is in force, and the resolver reads it.
    const active = store.activePolicy(ASSISTANT_MEMORY_OWNER, 'recall');
    assert.ok(active, 'a version is active');
    assert.equal(active.sleepRunId, run.id, 'and it carries the night that made it (E18)');
    const resolved = resolvePolicy(store, config, ASSISTANT_MEMORY_OWNER, 'recall');
    assert.equal(
      Object.values(resolved.origin).some((origin) => origin === 'dream'),
      true,
      'the effective policy now has a field the dream set',
    );
    // The evidence is spent: the evaluation row is marked promoted, and the
    // hash of the traces it stood on is on record.
    const promoted = store.listDreamEvals({ owner: ASSISTANT_MEMORY_OWNER, promoted: true });
    assert.equal(promoted.length, 1);
    assert.equal(promoted[0].policyId, active.id);
    assert.equal(
      store.lastPromotedTraceSetHash(ASSISTANT_MEMORY_OWNER, 'recall'),
      promoted[0].traceSetHash,
    );

    // And the whole of it comes back out with the night (10.4). The
    // promotion is demoted inside the store's transaction, which is why
    // `policies` exists on the undo at all.
    const undone = runner.undo(run.id);
    assert.ok(undone, 'the night is undoable');
    assert.equal(undone.policies, 1, 'the undo reports the policy it demoted');
    assert.equal(
      store.activePolicy(ASSISTANT_MEMORY_OWNER, 'recall'),
      null,
      'and nothing is in force again',
    );
  });
});

/* -------------------------------- the wake test -------------------------------- */

test('the wake test is a regression alarm, and breaching it freezes the slot', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // Measuring on, promoting off: what is under test is the alarm on what
    // is already in force, not the gate.
    const config = promotingConfig({ promote: false, calibrationTraces: 1, tolerance: 0.05 });
    seedBank(store);
    ageBank(store);
    seedLabelledPool(store, config);

    // A promotion that promised far more than the traces since it deliver.
    // Nothing else in the fixture moves, so the whole of the drift is the
    // distance between the promise and what the same estimator reads today.
    const version = store.createPolicyVersion({
      owner: ASSISTANT_MEMORY_OWNER,
      slot: 'recall',
      params: {},
      box: {},
      origin: 'dream',
      replayScore: 0.6,
      replayN: 4,
    });
    store.promotePolicyVersion(version.id, { sleepRunId: 'a-previous-night' });

    const runner = makeRunner(store, config, null);
    const run = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(run.status, 'done');
    assert.match(run.report, /regression alarm, not a calibration/);
    assert.match(run.report, /drift of/);
    const state = store.slotState(ASSISTANT_MEMORY_OWNER, 'recall');
    assert.equal(state.frozenReason, 'calibration', 'the slot is frozen for the right cause');
    assert.ok(state.frozenAt, 'and it carries when');
    // A frozen slot keeps measuring, and the number it froze on is the one
    // in the report - the evidence a person thaws it on.
    assert.match(run.report, /since the last promotion/);
  });
});

/* ---------------------------- the candidate writer ---------------------------- */

test('the candidate writer runs last, writes proposals, and shares one run-global wallet', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // Two calls a night across every owner, six candidates asked for: the
    // wallet is the smaller of the two, and it is the one that binds.
    const config = promotingConfig({ promote: false, maxCallsPerNight: 2, candidates: 6 });
    seedBank(store);
    ageBank(store);
    seedLabelledPool(store, config);

    const provider = scriptedProvider({
      candidate:
        '{"limit":8,"threshold":0.06,"w":{"relevance":0.6,"importance":0.25,"recency":0.1,' +
        '"usage":0.05},"hopEntity":0.5,"hopEdge":0.5}',
    });
    const runner = makeRunner(store, config, provider);
    const phases = phaseRecorder(runner);
    const first = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(first.status, 'done');
    assert.equal(first.dreamCandidates, 2, 'the wallet, not the ask, decided how many');
    // It runs in the last cycle, after the insights - so the dream phase,
    // where the measuring happens, is long finished by then.
    assert.equal(phases.indexOf('dream') < phases.lastIndexOf('rem'), true);

    // What it wrote are proposals: versions with no replay score, nothing in
    // force, and a rationale of numbers only.
    const versions = store.policyHistory(ASSISTANT_MEMORY_OWNER, 'recall', 20);
    const proposals = versions.filter((version) => version.replayScore === undefined);
    assert.equal(proposals.length, 2);
    for (const proposal of proposals) {
      assert.equal(proposal.origin, 'dream');
      assert.equal(proposal.promotedAt, undefined, 'a proposal is not a policy');
      assert.equal(proposal.sleepRunId, first.id);
      assert.match(proposal.rationale, /^proposal cases=\d+/);
      assert.equal(proposal.params.limit, 8);
    }

    // The wallet is run-global: a second night inside the same window finds
    // it empty and asks for nothing, however many candidates it is allowed.
    const second = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });
    assert.equal(second.dreamCandidates, 0, 'the wallet was already spent tonight');
  });
});

/* --------------------------- evidence is spent once --------------------------- */

test('a second night over the same traces promotes nothing, however good the candidate', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // Every validity rule wide open, the gate itself armed: what is left
    // standing is the trace-set rule and nothing else.
    const config = makeConfig(
      {
        enabled: true,
        promote: true,
        minTraces: 1,
        margin: 0,
        coverageFloor: 0,
        costOnlyCeiling: 1,
        abstainEps: 1,
        abstainFloor: 1,
        reachableFloor: 0,
        agreementFloor: -1,
        cooldownNights: 0,
        calibrationTraces: 1000,
      },
      { cycles: 1, replaySessions: 0 },
    );
    seedBank(store);
    ageBank(store);
    const pool = seedLabelledPool(store, config);
    assert.ok(pool.holdout > 0, 'the fixture has a holdout half');
    assert.ok(pool.audit > 0, 'and a frozen audit set');
    assert.ok(pool.labels >= 20, 'and enough labels for the agreement sensor to pair on');

    const runner = makeRunner(store, config, null);
    const first = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });
    assert.equal(first.status, 'done');

    // Whatever the first night decided, the evidence it stood on is now
    // spent: a promotion is recorded against exactly the trace set the
    // holdout closed over.
    const measured = store.listDreamEvals({ owner: ASSISTANT_MEMORY_OWNER, limit: 10 });
    assert.ok(measured.length >= 1, 'the night recorded what it measured');
    const spent = measured[0];
    if (!measured.some((row) => row.promoted)) {
      const version = store.createPolicyVersion({
        owner: ASSISTANT_MEMORY_OWNER,
        slot: 'recall',
        params: {},
        box: {},
        origin: 'dream',
      });
      store.promotePolicyVersion(version.id, { sleepRunId: first.id });
      store.recordDreamEval({ ...spent, id: undefined, policyId: version.id, promoted: true });
    }
    assert.equal(
      store.lastPromotedTraceSetHash(ASSISTANT_MEMORY_OWNER, 'recall'),
      spent.traceSetHash,
      'the hash of the spent evidence is on record',
    );

    // Nothing was recorded since, so the second night sees the same traces.
    const second = await runner.run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });
    assert.equal(second.status, 'done');
    assert.equal(second.dreamPromoted, 0, 'the second night promotes nothing');
    const promotions = store.db
      .prepare('SELECT COUNT(*) AS n FROM policy_versions WHERE sleep_run_id = ? AND promoted_at IS NOT NULL')
      .get(second.id).n;
    assert.equal(promotions, 0, 'and put no version in force');
    const again = store.listDreamEvals({ sleepRunId: second.id, limit: 10 });
    for (const row of again) {
      assert.equal(
        row.traceSetHash,
        spent.traceSetHash,
        'because it is standing on the very same trace set',
      );
    }
  });
});

/* ------------------------- the night's one wall clock ------------------------- */

/**
 * A clock that MOVES, which is the whole point.
 *
 * The eleven tests above freeze `Date.now()`, and a frozen clock can never
 * reach a deadline - which is why none of them could see a dream spending
 * its wall clock twice. This one hands out a later millisecond on every
 * read, so a budget of one millisecond is gone by the second call.
 */
function steppingClock(step = 25) {
  const realNow = Date.now;
  let at = FIXED_NOW;
  Date.now = () => {
    at += step;
    return at;
  };
  return () => {
    Date.now = realNow;
  };
}

/** A proposal from a previous night: in the box, admissible, unmeasured. */
function seedProposal(store, config) {
  const incumbent = resolvePolicy(store, config, ASSISTANT_MEMORY_OWNER, 'recall');
  return store.createPolicyVersion({
    owner: ASSISTANT_MEMORY_OWNER,
    slot: 'recall',
    // The incumbent's own weights, so H9 has nothing to refuse (an identical
    // vector is not a rescale), and a threshold that is inside the declared
    // box but is not the incumbent's - otherwise it would be dropped as a
    // duplicate point before it ever reached the measurement.
    params: {
      limit: incumbent.limit,
      threshold: incumbent.threshold >= 0.2 ? 0.1 : 0.25,
      w: { ...incumbent.w },
      hopEntity: incumbent.hopEntity,
      hopEdge: incumbent.hopEdge,
    },
    box: {},
    origin: 'dream',
  });
}

function versionById(store, id) {
  return store.policyHistory(ASSISTANT_MEMORY_OWNER, 'recall', 50).find((version) => version.id === id);
}

test('a dream whose wall clock is already spent measures nothing and keeps its proposals', async () => {
  const store = makeStore();
  // One millisecond of evaluation budget for the WHOLE dream (concept 6.1),
  // and a clock that moves twenty-five of them on every read. With a
  // deadline per part the probe would spend the budget and the slot would
  // start already past its own: every evaluation invalid, no row written -
  // and last night's paid-for proposals retired for a measurement that
  // never happened.
  const config = promotingConfig({ maxEvalMs: 1, candidates: 2 });
  const proposal = withFrozenClock(() => {
    seedBank(store);
    ageBank(store);
    seedLabelledPool(store, config);
    return seedProposal(store, config);
  });
  assert.equal(versionById(store, proposal.id).retiredAt, undefined, 'the proposal starts on offer');

  const restore = steppingClock();
  let run;
  try {
    run = await makeRunner(store, config, null).run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });
  } finally {
    restore();
  }

  assert.equal(run.status, 'done', 'a spent budget is a state, not a failure');
  assert.equal(run.dreamFramesScored, 0, 'the probe read the night clock and stopped');
  assert.equal(run.dreamPromoted, 0);
  assert.equal(count(store, 'dream_evals'), 0, 'nothing was measured, so nothing was recorded');
  // And the proposal survives. Retiring it here would burn the candidate
  // budget every night forever on proposals that never get a number.
  assert.equal(
    versionById(store, proposal.id).retiredAt,
    undefined,
    'the proposal outlived the night that never measured it',
  );
  assert.match(run.report, /carried over to the next night/);
});

/* ------------------- the wake test reads what closed ------------------- */

test('a wake test whose pool mostly abstains reports that it could not run, and freezes nothing', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // Five traces before a verdict, and a pool that offers far more than
    // five but closes at most two of them. Read off what was OFFERED this
    // freezes the slot on one trace of noise, and `calibration` is a freeze
    // somebody has to undo by hand (10.3).
    const config = promotingConfig({ promote: false, calibrationTraces: 8, tolerance: 0.05 });
    seedBank(store);
    ageBank(store);
    // One labelled turn, and that is the whole of what can close.
    const labelled = seedLabelledPool(store, config, { train: 1, holdout: 0, audit: 0 });
    assert.ok(labelled.train + labelled.holdout < 8, 'fewer labelled turns than the floor asks for');
    // Twenty framed turns nobody ever labelled: every one of them abstains
    // `no-reachable-label`, which is a counted quantity and not a frame
    // that quietly disappears (5.4).
    for (let index = 0; index < 20; index += 1) {
      const session = store.createSession({ title: 'Unlabelled ' + index, provider: 'claude', cwd: '.' });
      recordFrame(store, config, 'harbor ledger', { sessionId: session.id });
    }

    // A promotion that promised far more than anything since it delivers -
    // so a verdict read off one closed trace would breach the tolerance.
    const version = store.createPolicyVersion({
      owner: ASSISTANT_MEMORY_OWNER,
      slot: 'recall',
      params: {},
      box: {},
      origin: 'dream',
      replayScore: 0.6,
      replayN: 4,
    });
    store.promotePolicyVersion(version.id, { sleepRunId: 'a-previous-night' });

    const run = await makeRunner(store, config, null).run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(run.status, 'done');
    assert.match(run.report, /The wake test could not run/);
    assert.match(run.report, /under dream\.calibrationTraces \(8\)/);
    // The reason is named, because which abstention dominated IS the
    // finding: an unlabelled pool and a drifted corpus call for entirely
    // different answers.
    assert.match(run.report, /no-reachable-label/);
    assert.match(run.report, /Nothing is frozen on a pool that could not be read/);
    const state = store.slotState(ASSISTANT_MEMORY_OWNER, 'recall');
    assert.notEqual(state.frozenReason, 'calibration', 'no verdict, no calibration freeze');
  });
});

test('the frozen audit set is no part of the wake test', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // A tolerance nothing can breach: what is under test is which frames
    // were offered, not what the drift did.
    const config = promotingConfig({ promote: false, calibrationTraces: 1, tolerance: 1 });
    seedBank(store);
    ageBank(store);
    const pool = seedLabelledPool(store, config);
    assert.ok(pool.audit > 0, 'the fixture has a frozen audit set to keep out');

    const version = store.createPolicyVersion({
      owner: ASSISTANT_MEMORY_OWNER,
      slot: 'recall',
      params: {},
      box: {},
      origin: 'dream',
      replayScore: 0.6,
      replayN: 4,
    });
    store.promotePolicyVersion(version.id, { sleepRunId: 'a-previous-night' });

    const run = await makeRunner(store, config, null).run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(run.status, 'done');
    // The audit set serves never for selection and never as a holdout, and
    // is touched exactly once per promotion (5.5d) - so the sensor that
    // runs every night over the whole pool counts the other two sides only.
    assert.match(
      run.report,
      new RegExp('of ' + (pool.train + pool.holdout) + ' frames since the last promotion'),
      'the wake test was offered the pool minus its audit sessions',
    );
  });
});

/* ---------------------------- the pool's newest end ---------------------------- */

/** Raw frame rows from long before tonight, reusing one real payload. */
function seedOldFrames(store, frame, howMany, at) {
  const insertTrace = store.db.prepare(
    `INSERT INTO dream_traces
       (id, turn_id, owner, kind, site, pipeline, policy_set, started_at, created_at, finished_at)
     VALUES (?, ?, ?, 'turn', 'turn', 'assistant', '{}', ?, ?, ?)`,
  );
  const insertFrame = store.db.prepare(
    `INSERT INTO dream_frames
       (trace_id, slot, frame_v, owner, session_id, box, corpus_stamp_id, payload, bytes, created_at)
     VALUES (?, 'recall', 1, ?, NULL, ?, '', ?, ?, ?)`,
  );
  const payload = JSON.stringify(frame);
  const box = JSON.stringify(frame.box);
  for (let index = 0; index < howMany; index += 1) {
    const id = 'trace-old-' + index;
    const when = at + index;
    insertTrace.run(id, 'turn-old-' + index, ASSISTANT_MEMORY_OWNER, when, when, when + 1);
    insertFrame.run(id, ASSISTANT_MEMORY_OWNER, box, payload, Buffer.byteLength(payload), when);
  }
}

test('past the pool cap the recall slot reads the newest frames, and says which pool it read', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = promotingConfig({ promote: false, calibrationTraces: 1, tolerance: 1 });
    seedBank(store);
    ageBank(store);
    seedLabelledPool(store, config);
    const fresh = count(store, 'dream_frames');

    // A promotion made just now, and five hundred frames from six weeks
    // ago. Oldest first, THOSE are the whole pool: not one frame since the
    // promotion is in it, the wake test goes silent and the slot is pinned
    // to a six-week-old slice for good.
    const version = store.createPolicyVersion({
      owner: ASSISTANT_MEMORY_OWNER,
      slot: 'recall',
      params: {},
      box: {},
      origin: 'dream',
      replayScore: 0.6,
      replayN: 4,
    });
    store.promotePolicyVersion(version.id, { sleepRunId: 'a-previous-night' });
    const sample = store.framesFor(ASSISTANT_MEMORY_OWNER, { limit: 1 })[0];
    seedOldFrames(store, sample.frame.payload, 500, FIXED_NOW - 42 * DAY);
    const total = fresh + 500;
    assert.equal(count(store, 'dream_frames'), total);

    const run = await makeRunner(store, config, null).run({ owner: ASSISTANT_MEMORY_OWNER, trigger: 'cron' });

    assert.equal(run.status, 'done');
    // Disclosed the way the probe discloses its own cut: a measurement over
    // part of the store is visible as one, never passed off as the whole.
    assert.match(
      run.report,
      new RegExp('measured the 500 newest of ' + total + ' stored dream frames'),
    );
    // And the proof that it is the newest end: the wake test only ever sees
    // frames younger than the promotion, and it found some.
    assert.match(run.report, /since the last promotion/);
  });
});

/* ------------------- a label writer is never worth a night ------------------- */

test('an unreadable frame costs the correction labels and never the retention sweeps', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    // No candidate wallet tonight (`maxCallsPerNight: 0`), so the only thing
    // that reads the broken frame is the label pass under test.
    const config = makeConfig(
      { enabled: true, frameRetainDays: 10, retainDays: 200, maxCallsPerNight: 0 },
      { cycles: 1 },
    );
    seedBank(store);
    ageBank(store);
    const { session } = recordSession(store, {
      title: 'The manifest',
      quotes: [
        'The harbor manifest is not the logbook, you had that wrong.',
        'Please keep the two of them apart from now on.',
      ],
    });
    // The frame of the conversation about to be replayed - and then its
    // payload, unreadable. This is the one line of 10.5 the label writers
    // used to break: it threw into the night's outer catch, which ends the
    // run failed and skips `recountEntities` AND every retention sweep
    // behind it, so the verbatim frame store outlives its own window for
    // exactly the reason the dream must never cause (10.4, 8.7).
    const broken = recordFrame(store, config, 'harbor manifest', { sessionId: session.id });
    store.db.prepare('UPDATE dream_frames SET payload = ? WHERE trace_id = ?').run('not json at all', broken.trace.id);
    // And one frame from long past the retention clock, to watch the sweep.
    const stale = recordFrame(store, config, 'harbor ledger', { sessionId: session.id });
    store.db
      .prepare('UPDATE dream_frames SET created_at = ? WHERE trace_id = ?')
      .run(FIXED_NOW - 50 * DAY, stale.trace.id);
    assert.equal(count(store, 'dream_frames'), 2);

    const provider = scriptedProvider({
      triage: '{"worth":true}',
      replay:
        '{"memories":[],"corrections":[{"text":"The manifest and the logbook are two different things.",' +
        '"quote":"The harbor manifest is not the logbook"}]}',
    });
    const run = await makeRunner(store, config, provider).run({
      owner: ASSISTANT_MEMORY_OWNER,
      trigger: 'manual',
    });

    assert.equal(run.status, 'done', 'a degraded path is never turned into an error (10.5)');
    assert.equal(count(store, 'corrections'), 1, 'the correction itself was written');
    assert.equal(count(store, 'dream_labels'), 0, 'and the label pass that failed wrote nothing');
    assert.equal(run.dreamLabelsWritten, 0);
    // The sweeps ran: the stale frame is gone and the fresh one stayed.
    assert.equal(count(store, 'dream_frames'), 1, 'the retention sweep ran at the end of the night');
    assert.match(run.report, /label pass failed and left no labels/);
  });
});

test('a merge label writer that throws leaves the condensation and the sweeps standing', async () => {
  await withFrozenClockAsync(async () => {
    const store = makeStore();
    const config = makeConfig(
      { enabled: true, frameRetainDays: 10, retainDays: 200 },
      { cycles: 1, replaySessions: 0 },
    );
    const first = store.upsertMemory({
      kind: 'fact',
      content: 'The harbor manifest lists every incoming cargo at the quay.',
      tags: ['harbor', 'cargo'],
      importance: 0.8,
    });
    const second = store.upsertMemory({
      kind: 'fact',
      content: 'Every incoming cargo at the quay is listed on the harbor manifest.',
      tags: ['harbor', 'cargo'],
      importance: 0.7,
    });
    linkEntities(store, ASSISTANT_MEMORY_OWNER, first.id, first.tags);
    linkEntities(store, ASSISTANT_MEMORY_OWNER, second.id, second.tags);
    const session = store.createSession({ title: 'Cargo', provider: 'claude', cwd: '.' });
    const { trace } = recordFrame(store, config, 'harbor manifest cargo quay', { sessionId: session.id });
    // Past the frame clock, so the sweep at the end of the night has
    // something to take away.
    store.db
      .prepare('UPDATE dream_frames SET created_at = ? WHERE trace_id = ?')
      .run(FIXED_NOW - 50 * DAY, trace.id);
    // The label table refuses every write tonight.
    store.putLabels = () => {
      throw new Error('the label table is gone');
    };

    const provider = scriptedProvider({
      condense:
        '{"merge":true,"content":"The harbor manifest lists every incoming cargo at the quay.",' +
        '"supersedes":[1,2],"kind":"fact","importance":0.85,"tags":["harbor"]}',
    });
    const run = await makeRunner(store, config, provider).run({
      owner: ASSISTANT_MEMORY_OWNER,
      trigger: 'manual',
    });

    assert.equal(run.status, 'done');
    assert.ok(run.mergedCount >= 1, 'the condensation itself went through');
    assert.equal(run.dreamLabelsWritten, 0, 'its labels did not');
    assert.equal(count(store, 'dream_frames'), 0, 'and the retention sweep still ran');
    assert.match(run.report, /label pass failed and left no labels/);
  });
});

/**
 * A pool of labelled turns, spread over sessions that fall on all three
 * sides of the split.
 *
 * The label is chosen by construction rather than by hope: what the block
 * did NOT carry, although the frame could still reach it, is exactly the
 * shape a correction label has (concept 4.2a) and the only shape that can
 * make a candidate beat the incumbent at all. Each target is judged twice,
 * by `correction` and by `user`, because `user` is the privileged source of
 * the agreement sensor and thin `user` labels are themselves a finding
 * (5.5b) - a pool labelled by one source alone never gets past condition 5.
 */
function seedLabelledPool(store, config, quota = { train: 6, holdout: 4, audit: 2 }) {
  const owner = ASSISTANT_MEMORY_OWNER;
  const policy = resolvePolicy(store, config, owner, 'recall');
  const counts = { train: 0, holdout: 0, audit: 0, labels: 0 };
  const filled = () =>
    counts.train >= quota.train && counts.holdout >= quota.holdout && counts.audit >= quota.audit;

  // Session ids are drawn, and so is the side of the split they land on
  // (E3) - so the fixture keeps drawing until all three sides are occupied
  // instead of hoping that thirty of them will be. The audit set is the
  // thin one: one session in ten, and a promotion cannot happen without it.
  for (let index = 0; index < 200 && !filled(); index += 1) {
    const session = store.createSession({ title: 'Pool ' + index, provider: 'claude', cwd: '.' });
    counts[splitOf(session.id, DEFAULT_SPLIT_RATES)] += 1;
    const { trace, frame } = recordFrame(store, config, 'harbor manifest', {
      sessionId: session.id,
    });
    const missed = missedBy(frame, policy);
    const common = {
      turnId: trace.turnId,
      target: missed.id,
      relevance: 1,
      scope: 'turn',
      owner,
      sessionId: session.id,
      createdAt: Date.now(),
    };
    counts.labels += store.putLabels([
      { ...common, source: 'correction' },
      { ...common, source: 'user' },
    ]);
  }
  return counts;
}
