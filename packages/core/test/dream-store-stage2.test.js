import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_MEMORY_OWNER, Store } from '../dist/index.js';

/**
 * Stage-2 persistence (AP3): labels, policy versions, slot state,
 * evaluations, episodes, the turn reference, the actor funnel and the
 * promotion revert inside `undoSleepRun`.
 *
 * The load-bearing properties are the ones a later package cannot repair.
 * A label is never deleted, only marked dead (S9), because a vanished label
 * drags `reachable_rate` down for a reason that has nothing to do with
 * labelling. Only `actor === 'user'` writes a `user` label (S5), because a
 * source the measured thing can manufacture is not a source. The night's
 * promotion falls under the night's undo and `prev_active_id` is what comes
 * back (S25). And the sleep-run counters live in four places at once
 * (concept 8.8) - an unlisted key in `updateSleepRun` is skipped with no
 * error and no log, which is precisely the bug that rule exists for.
 *
 * Frozen clock: almost every row here carries a `created_at`, and the undo
 * and the sweeps both select on it. `tick` moves the frozen point forward
 * where a test needs one row to genuinely predate another.
 */

const FIXED_NOW = Date.parse('2026-09-18T02:00:00.000Z');
const OWNER = ASSISTANT_MEMORY_OWNER;
const OTHER_OWNER = 'agent:scribe';

function withFrozenClock(run) {
  const realNow = Date.now;
  let now = FIXED_NOW;
  Date.now = () => now;
  try {
    return run((by) => {
      now += by;
    });
  } finally {
    Date.now = realNow;
  }
}

/** A fresh in-memory store per test keeps them independent and fast. */
function makeStore() {
  return new Store(':memory:');
}

function count(store, table) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
}

function label(overrides = {}) {
  return {
    turnId: 'turn-1',
    target: 'memory-1',
    source: 'correction',
    relevance: 1,
    scope: 'turn',
    evidence: 'correction-1',
    createdAt: Date.now(),
    owner: OWNER,
    sessionId: 'session-1',
    ...overrides,
  };
}

function policyInput(overrides = {}) {
  return {
    owner: OWNER,
    slot: 'recall',
    params: { limit: 8, threshold: 0.12 },
    box: { limitMax: 16 },
    origin: 'dream',
    ...overrides,
  };
}

function evalInput(policyId, overrides = {}) {
  return {
    sleepRunId: 'run-1',
    policyId,
    slot: 'recall',
    traces: 300,
    closed: 240,
    abstained: 60,
    abstainReasons: { 'no-reachable-label': 40, unfinished: 20 },
    reachableRate: 0.8,
    labelCoverage: 0.42,
    costOnlyShare: 0.31,
    score: 0.61,
    baseline: 0.58,
    delta: 0.03,
    ciLow: 0.01,
    ciHigh: 0.05,
    signAgree: null,
    evalMs: 1200,
    traceSetHash: 'hash-a',
    promoted: false,
    ...overrides,
  };
}

/* ------------------------------ labels ------------------------------ */

test('a label round-trips for every source', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const written = store.putLabels([
      label({ source: 'correction', target: 'memory-1', relevance: 1 }),
      label({ source: 'merge', target: 'memory-1', relevance: 0 }),
      label({ source: 'user', target: 'memory-2', relevance: 1, scope: 'session', turnId: 'session-1' }),
      label({ source: 'review', target: '*', relevance: 0.75, scope: 'session', turnId: 'session-1' }),
    ]);
    assert.equal(written, 4, 'the return value is what the run counts as dreamLabelsWritten');

    const onTurn = store.labelsForTurns(['turn-1'], OWNER);
    assert.deepEqual(
      onTurn.map((row) => row.source).sort(),
      ['correction', 'merge'],
      'the turn-scoped sources sit on the turn id',
    );
    const correction = onTurn.find((row) => row.source === 'correction');
    assert.equal(correction.target, 'memory-1');
    assert.equal(correction.relevance, 1);
    assert.equal(correction.scope, 'turn');
    assert.equal(correction.evidence, 'correction-1');
    assert.equal(correction.owner, OWNER);
    assert.equal(correction.sessionId, 'session-1');
    assert.equal(correction.deadAt, undefined);

    const onSession = store.labelsForSessions(['session-1'], OWNER);
    assert.deepEqual(
      onSession.map((row) => row.source).sort(),
      ['review', 'user'],
      'a session-scoped label carries the SESSION id in turn_id',
    );
    const review = onSession.find((row) => row.source === 'review');
    assert.equal(review.target, '*', 'the review sentinel survives the round trip');
    assert.equal(review.relevance, 0.75);

    assert.deepEqual(store.labelCounts(OWNER, FIXED_NOW - 1), {
      correction: 1,
      review: 1,
      merge: 1,
      user: 1,
    });
  });
  store.close();
});

test('one source replaces its own claim, two sources keep both rows', () => {
  const store = makeStore();
  withFrozenClock(() => {
    store.putLabel(label({ source: 'correction', relevance: 1 }));
    store.putLabel(label({ source: 'correction', relevance: 0, evidence: 'correction-2' }));
    assert.equal(count(store, 'dream_labels'), 1, '(turn, target, source) is the key');
    assert.equal(store.labelsForTurns(['turn-1'])[0].relevance, 0);

    // A contradiction BETWEEN sources is countable evidence, not a write to
    // be swallowed - the agreement check needs both rows to see it (S2).
    store.putLabel(label({ source: 'user', relevance: 1 }));
    const rows = store.labelsForTurns(['turn-1']);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.relevance).sort(), [0, 1]);
  });
  store.close();
});

test('a label read filtered by owner never returns rows of a second owner', () => {
  const store = makeStore();
  withFrozenClock(() => {
    store.putLabel(label({ owner: OWNER }));
    store.putLabel(label({ owner: OTHER_OWNER, target: 'memory-9' }));
    assert.equal(store.labelsForTurns(['turn-1'], OWNER).length, 1);
    assert.equal(store.labelsForTurns(['turn-1'], OTHER_OWNER).length, 1);
    assert.equal(store.labelsForTurns(['turn-1']).length, 2, 'unfiltered still sees both');
    assert.equal(store.labelCounts(OTHER_OWNER, FIXED_NOW - 1).correction, 1);
  });
  store.close();
});

test('a removed target marks its labels dead instead of deleting them', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    const memory = store.upsertMemory({ kind: 'fact', content: 'The harbor ledger is monthly.' });
    store.putLabel(label({ target: memory.id, source: 'correction' }));
    store.putLabel(label({ target: memory.id, source: 'merge', relevance: 0 }));

    tick(1000);
    store.forgetMemory(memory.id);

    assert.equal(count(store, 'dream_labels'), 2, 'the history stays standing (S9)');
    for (const row of store.labelsForTurns(['turn-1'])) {
      assert.equal(row.deadAt, FIXED_NOW + 1000, 'every label about the target is stamped dead');
    }

    // A second removal does not re-stamp what is already dead.
    tick(1000);
    store.deleteMemory(memory.id);
    assert.equal(count(store, 'dream_labels'), 2);
    assert.equal(store.labelsForTurns(['turn-1'])[0].deadAt, FIXED_NOW + 1000);
  });
  store.close();
});

test('archiving a bank marks its labels dead and leaves the other bank alone', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    store.upsertMemory({ kind: 'fact', content: 'The scribe files on Fridays.', owner: OTHER_OWNER });
    store.putLabel(label({ owner: OTHER_OWNER, turnId: 'turn-2' }));
    store.putLabel(label({ owner: OWNER }));

    tick(500);
    store.archiveMemories(OTHER_OWNER);

    assert.equal(store.labelsForTurns(['turn-2'])[0].deadAt, FIXED_NOW + 500);
    assert.equal(store.labelsForTurns(['turn-1'])[0].deadAt, undefined);
  });
  store.close();
});

/* --------------------------- the actor (S5) --------------------------- */

test('only a user actor writes a user label', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const session = store.createSession({ provider: 'claude', cwd: '/tmp' });
    const byModel = store.upsertMemory({
      kind: 'fact',
      content: 'The model wrote this one.',
      sourceSessionId: session.id,
    });
    const byUser = store.upsertMemory({
      kind: 'fact',
      content: 'The user forgot this one.',
      sourceSessionId: session.id,
    });

    // The model's own memory tool reaches the very same method, and the
    // default keeps it silent.
    store.forgetMemory(byModel.id);
    assert.equal(count(store, 'dream_labels'), 0, 'the default actor writes nothing');

    store.forgetMemory(byUser.id, 'user');
    const rows = store.labelsForSessions([session.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'user');
    assert.equal(rows[0].target, byUser.id);
    assert.equal(rows[0].relevance, 0, 'forgetting says: this was ballast');
    assert.equal(rows[0].scope, 'session', 'a memory edit names no turn (4.2b)');
    assert.equal(rows[0].turnId, session.id, 'so turn_id carries the session');
    assert.equal(rows[0].evidence, 'forgetMemory:user');
    assert.equal(rows[0].deadAt, undefined, 'the label the removal itself wrote is born alive');
  });
  store.close();
});

test('pinning as the user is a positive label, editing the wording is not', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const session = store.createSession({ provider: 'claude', cwd: '/tmp' });
    const memory = store.upsertMemory({
      kind: 'preference',
      content: 'Answers stay short.',
      sourceSessionId: session.id,
    });

    store.updateMemory(memory.id, { content: 'Answers stay short and plain.' }, 'user');
    assert.equal(count(store, 'dream_labels'), 0, 'a re-wording claims nothing about any turn');

    store.updateMemory(memory.id, { pinned: true }, 'user');
    const rows = store.labelsForSessions([session.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].relevance, 1, 'pinning says: this was the point');

    store.updateMemory(memory.id, { pinned: true });
    assert.equal(store.labelsForSessions([session.id])[0].relevance, 1);
    assert.equal(count(store, 'dream_labels'), 1, 'the model repeating it adds nothing');
  });
  store.close();
});

test('a user edit on a memory with no source session writes no guessed locator', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const memory = store.upsertMemory({ kind: 'fact', content: 'Written outside any session.' });
    store.deleteMemory(memory.id, 'user');
    assert.equal(count(store, 'dream_labels'), 0);
  });
  store.close();
});

/* -------------------------- policy versions -------------------------- */

test('a policy version is promoted, and a revert puts the previous one back', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    const first = store.createPolicyVersion(policyInput({ params: { limit: 8 } }));
    const second = store.createPolicyVersion(policyInput({ params: { limit: 12 }, parentId: first.id }));
    assert.equal(first.version, 1);
    assert.equal(second.version, 2, 'the version counts per (owner, slot)');
    assert.equal(store.activePolicy(OWNER, 'recall'), null, 'written is not promoted');

    store.promotePolicyVersion(first.id, {});
    assert.equal(store.activePolicy(OWNER, 'recall').id, first.id);
    assert.equal(store.slotState(OWNER, 'recall').lastPromoted, FIXED_NOW);

    tick(1000);
    store.promotePolicyVersion(second.id, { prevActiveId: first.id, sleepRunId: 'run-1' });
    const active = store.activePolicy(OWNER, 'recall');
    assert.equal(active.id, second.id);
    assert.deepEqual(active.params, { limit: 12 }, 'the parameter set survives the round trip');
    assert.equal(active.prevActiveId, first.id, 'what was active when this was promoted');
    assert.equal(store.policyVersion(first.id).retiredAt, FIXED_NOW + 1000, 'and it stepped down');

    // The manual revert: retire the newcomer, bring its predecessor back.
    store.retirePolicyVersion(second.id);
    store.reactivatePolicyVersion(first.id);
    assert.equal(store.activePolicy(OWNER, 'recall').id, first.id);

    assert.deepEqual(
      store.policyHistory(OWNER, 'recall').map((row) => row.version),
      [2, 1],
      'the history is newest first and keeps both',
    );
  });
  store.close();
});

test('an active policy never leaks across owners or slots', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const mine = store.createPolicyVersion(policyInput());
    const theirs = store.createPolicyVersion(policyInput({ owner: OTHER_OWNER }));
    store.promotePolicyVersion(mine.id, {});
    store.promotePolicyVersion(theirs.id, {});

    assert.equal(store.activePolicy(OWNER, 'recall').id, mine.id);
    assert.equal(store.activePolicy(OTHER_OWNER, 'recall').id, theirs.id);
    assert.equal(store.activePolicy(OWNER, 'budget'), null, 'another slot is another policy');
  });
  store.close();
});

/* ---------------------------- slot state ---------------------------- */

test('a slot with no row is simply not frozen', () => {
  const store = makeStore();
  withFrozenClock(() => {
    assert.deepEqual(store.slotState(OWNER, 'recall'), { owner: OWNER, slot: 'recall' });

    store.freezeSlot(OWNER, 'recall', 'calibration');
    const frozen = store.slotState(OWNER, 'recall');
    assert.equal(frozen.frozenAt, FIXED_NOW);
    assert.equal(frozen.frozenReason, 'calibration');

    store.setSlotCooldown(OWNER, 'recall', FIXED_NOW + 7 * 86_400_000);
    assert.equal(store.slotState(OWNER, 'recall').cooldownUntil, FIXED_NOW + 7 * 86_400_000);
    assert.equal(store.slotState(OWNER, 'recall').frozenReason, 'calibration', 'the cooldown is not a thaw');

    store.thawSlot(OWNER, 'recall');
    const thawed = store.slotState(OWNER, 'recall');
    assert.equal(thawed.frozenAt, undefined);
    assert.equal(thawed.frozenReason, undefined);
    assert.equal(thawed.cooldownUntil, FIXED_NOW + 7 * 86_400_000, 'and the thaw is not a cooldown reset');
  });
  store.close();
});

/* ---------------------------- evaluations ---------------------------- */

test('an evaluation round-trips, undetermined freshness included', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const policy = store.createPolicyVersion(policyInput());
    const written = store.recordDreamEval(evalInput(policy.id));
    const [read] = store.listDreamEvals({ owner: OWNER });

    assert.equal(read.id, written.id);
    assert.equal(read.closed, 240);
    assert.deepEqual(read.abstainReasons, { 'no-reachable-label': 40, unfinished: 20 });
    assert.equal(read.labelCoverage, 0.42);
    assert.equal(read.costOnlyShare, 0.31);
    assert.equal(read.traceSetHash, 'hash-a');
    assert.equal(read.promoted, false);
    // NULL is a value here: the freshness check was undetermined because the
    // delta sat inside the margin, which is not the same as false.
    assert.equal(read.signAgree, null);

    const agreeing = store.recordDreamEval(
      evalInput(policy.id, { signAgree: true, traceSetHash: 'hash-b', deltaLive: 0.02 }),
    );
    const readBack = store.listDreamEvals({ policyId: policy.id }).find((row) => row.id === agreeing.id);
    assert.equal(readBack.signAgree, true);
    assert.equal(readBack.deltaLive, 0.02);
  });
  store.close();
});

test('evaluations reach their owner only through the policy join', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    const mine = store.createPolicyVersion(policyInput());
    const theirs = store.createPolicyVersion(policyInput({ owner: OTHER_OWNER }));
    store.recordDreamEval(evalInput(mine.id, { traceSetHash: 'mine' }));
    store.recordDreamEval(evalInput(theirs.id, { traceSetHash: 'theirs' }));

    assert.deepEqual(
      store.listDreamEvals({ owner: OWNER }).map((row) => row.traceSetHash),
      ['mine'],
      'dream_evals has no owner column; the join is the only way there',
    );
    assert.deepEqual(store.listDreamEvals({ owner: OTHER_OWNER }).map((row) => row.traceSetHash), ['theirs']);

    assert.equal(store.lastPromotedTraceSetHash(OWNER, 'recall'), null, 'nothing promoted yet');
    store.recordDreamEval(evalInput(mine.id, { traceSetHash: 'promoted-1', promoted: true }));
    tick(1000);
    store.recordDreamEval(evalInput(mine.id, { traceSetHash: 'promoted-2', promoted: true }));
    assert.equal(store.lastPromotedTraceSetHash(OWNER, 'recall'), 'promoted-2', 'the newest promotion wins');
    assert.equal(store.lastPromotedTraceSetHash(OTHER_OWNER, 'recall'), null);
  });
  store.close();
});

/* ------------------------------ episodes ------------------------------ */

test('an episode indexes one turn, and re-indexing replaces it', () => {
  const store = makeStore();
  withFrozenClock(() => {
    store.recordDreamEpisode({
      id: 'turn-1',
      owner: OWNER,
      kind: 'turn',
      sessionId: 'session-1',
      slot: 'recall',
      steps: 3,
      outcome: 'unknown',
      holdout: false,
      audit: false,
      startedAt: FIXED_NOW,
    });
    store.recordDreamEpisode({
      id: 'turn-1',
      owner: OWNER,
      kind: 'turn',
      sessionId: 'session-1',
      slot: 'recall',
      steps: 5,
      outcome: 'success',
      holdout: false,
      audit: true,
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW + 4000,
    });
    assert.equal(count(store, 'dream_episodes'), 1, 'the index is keyed on the turn, not appended to');

    const [episode] = store.dreamEpisodes(OWNER);
    assert.equal(episode.steps, 5);
    assert.equal(episode.outcome, 'success');
    assert.equal(episode.audit, true);
    assert.equal(episode.finishedAt, FIXED_NOW + 4000);

    assert.equal(store.dreamEpisodes(OWNER, { audit: true }).length, 1);
    assert.equal(store.dreamEpisodes(OWNER, { audit: false }).length, 0);
    assert.equal(store.dreamEpisodes(OTHER_OWNER).length, 0);
  });
  store.close();
});

/* --------------------------- turn reference --------------------------- */

test('a message and a correction carry the turn they belong to', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const session = store.createSession({ provider: 'claude', cwd: '/tmp' });
    store.addMessage({ sessionId: session.id, role: 'user', content: 'not like that', turnId: 'turn-7' });
    store.addMessage({ sessionId: session.id, role: 'assistant', content: 'understood' });

    // Found by role, not by position: the clock is frozen, so the two rows
    // share a `created_at` and the transcript order is a tie.
    const messages = store.getMessages(session.id);
    assert.equal(messages.find((row) => row.role === 'user').turnId, 'turn-7');
    assert.equal(
      messages.find((row) => row.role === 'assistant').turnId,
      undefined,
      'a caller without a turn id writes none',
    );

    store.addCorrection({ owner: OWNER, text: 'monthly, not weekly', quote: 'not like that', turnId: 'turn-7' });
    // Ambiguous quotes resolve to no turn at all rather than a guess (S3).
    store.addCorrection({ owner: OWNER, text: 'also monthly', quote: 'not like that' });

    const corrections = store.correctionsSince(OWNER, FIXED_NOW - 1);
    assert.equal(corrections.length, 2);
    assert.equal(corrections.find((row) => row.text === 'monthly, not weekly').turnId, 'turn-7');
    assert.equal(corrections.find((row) => row.text === 'also monthly').turnId, undefined);

    store.consumeCorrections(corrections.map((row) => row.id));
    assert.equal(store.openCorrections(OWNER).length, 0);
    assert.equal(
      store.correctionsSince(OWNER, FIXED_NOW - 1).length,
      2,
      'a consumed correction is still evidence about its turn',
    );
  });
  store.close();
});

/* ---------------------- the undo, and the counters ---------------------- */

test('undoing a night retires its promotion and reactivates prev_active_id', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    const incumbent = store.createPolicyVersion(policyInput({ params: { limit: 8 } }));
    store.promotePolicyVersion(incumbent.id, {});

    tick(1000);
    const run = store.createSleepRun({ owner: OWNER, trigger: 'manual' });
    const challenger = store.createPolicyVersion(
      policyInput({ params: { limit: 12 }, parentId: incumbent.id, sleepRunId: run.id }),
    );
    store.promotePolicyVersion(challenger.id, { prevActiveId: incumbent.id, sleepRunId: run.id });
    store.recordDreamEval(evalInput(challenger.id, { sleepRunId: run.id, promoted: true }));
    assert.equal(store.activePolicy(OWNER, 'recall').id, challenger.id);

    tick(1000);
    const counts = store.undoSleepRun(run.id);

    assert.equal(counts.policies, 1, 'the return type grew by `policies`');
    assert.equal(store.policyVersion(challenger.id).retiredAt, FIXED_NOW + 2000);
    assert.equal(store.activePolicy(OWNER, 'recall').id, incumbent.id, 'prev_active_id is back in charge');
    assert.deepEqual(store.activePolicy(OWNER, 'recall').params, { limit: 8 });
    assert.equal(count(store, 'dream_evals'), 0, 'the evaluations of the undone night certify nothing any more');
    assert.equal(count(store, 'policy_versions'), 2, 'demoted, not deleted');
  });
  store.close();
});

test('a promotion the night only re-read is not undone with it', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    // The run id on a row that predates the run means "touched by", not
    // "written by" - the same distinction the memory branch above makes.
    const earlier = store.createPolicyVersion(policyInput({ sleepRunId: 'run-old' }));
    store.promotePolicyVersion(earlier.id, {});

    tick(1000);
    const run = store.createSleepRun({ owner: OWNER, trigger: 'manual' });
    store.db
      .prepare('UPDATE policy_versions SET sleep_run_id = ? WHERE id = ?')
      .run(run.id, earlier.id);

    const counts = store.undoSleepRun(run.id);
    assert.equal(counts.policies, 0);
    assert.equal(store.activePolicy(OWNER, 'recall').id, earlier.id, 'it stays in charge');
  });
  store.close();
});

test('a promotion with no predecessor leaves the slot on the defaults', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const run = store.createSleepRun({ owner: OWNER, trigger: 'manual' });
    const only = store.createPolicyVersion(policyInput({ sleepRunId: run.id }));
    store.promotePolicyVersion(only.id, { sleepRunId: run.id });

    const counts = store.undoSleepRun(run.id);
    assert.equal(counts.policies, 1);
    assert.equal(store.activePolicy(OWNER, 'recall'), null, 'NULL prev_active_id means there was none');
  });
  store.close();
});

test('the dream counters survive createSleepRun, updateSleepRun and mapSleepRun', () => {
  const store = makeStore();
  withFrozenClock(() => {
    const run = store.createSleepRun({ owner: OWNER, trigger: 'manual' });
    assert.equal(run.dreamPromoted, 0, 'the createSleepRun literal is the first of the four places');
    assert.equal(run.dreamLabelsWritten, 0);

    // The second and third: an unlisted key in the updateSleepRun whitelist
    // is skipped without an error, without a log and without a type error -
    // which is why this is asserted through a read-back, not through the
    // patch's return value alone (concept 8.8).
    store.updateSleepRun(run.id, { dreamPromoted: 1, dreamLabelsWritten: 37 });
    const stored = store.getSleepRun(run.id);
    assert.equal(stored.dreamPromoted, 1);
    assert.equal(stored.dreamLabelsWritten, 37);
    assert.equal(stored.dreamTracesSeen, 0, 'the stage-1 neighbours are untouched');

    const [listed] = store.listSleepRuns({ owner: OWNER });
    assert.equal(listed.dreamPromoted, 1);
    assert.equal(listed.dreamLabelsWritten, 37);
  });
  store.close();
});

/* ------------------------------- sweeps ------------------------------- */

test('the retention sweeps take the old rows and leave the fresh ones', () => {
  const store = makeStore();
  withFrozenClock((tick) => {
    const policy = store.createPolicyVersion(policyInput());
    store.putLabel(label({ turnId: 'turn-old' }));
    store.recordDreamEval(evalInput(policy.id, { traceSetHash: 'old' }));
    store.recordDreamEpisode({
      id: 'turn-old',
      owner: OWNER,
      kind: 'turn',
      slot: 'recall',
      steps: 2,
      outcome: 'unknown',
      holdout: false,
      audit: false,
      startedAt: FIXED_NOW,
    });

    tick(10_000);
    const cut = Date.now();
    store.putLabel(label({ turnId: 'turn-new' }));
    store.recordDreamEval(evalInput(policy.id, { traceSetHash: 'new' }));
    store.recordDreamEpisode({
      id: 'turn-new',
      owner: OWNER,
      kind: 'turn',
      slot: 'recall',
      steps: 2,
      outcome: 'unknown',
      holdout: false,
      audit: false,
      startedAt: cut,
    });

    assert.equal(store.sweepDreamLabels(cut), 1);
    assert.equal(store.sweepDreamEvals(cut), 1);
    assert.equal(store.sweepDreamEpisodes(cut), 1);

    assert.deepEqual(store.labelsForTurns(['turn-old', 'turn-new']).map((row) => row.turnId), ['turn-new']);
    assert.deepEqual(store.listDreamEvals({ owner: OWNER }).map((row) => row.traceSetHash), ['new']);
    assert.deepEqual(store.dreamEpisodes(OWNER).map((row) => row.id), ['turn-new']);
  });
  store.close();
});
