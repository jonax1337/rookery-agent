import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_MEMORY_OWNER,
  DEFAULT_CONFIG,
  Store,
  boxFromOptions,
  fetchFrame,
  pipelineAssistant,
} from '../dist/index.js';
import { evaluateCandidate, traceSetHash } from '../dist/memory/dream/evaluate.js';
import {
  admissionClean,
  agreementHolds,
  applyPromotion,
  auditBeatsFactory,
  cooldownExpired,
  evaluationIsValid,
  explorationHolds,
  freezeFor,
  freezeReasonFor,
  freshnessAgrees,
  holdoutBeatsIncumbent,
  oneCandidateOnHoldout,
  overwrittenUserFields,
  promotionDecision,
  renderRationale,
  revertPolicy,
  slotIsThawed,
  traceSetIsDisjoint,
  withinNightlyCap,
} from '../dist/memory/dream/promote.js';
import { WEIGHTS } from '../dist/memory/recall.js';

/**
 * The promotion gate (dream stage 2, AP9; concept 10.2, 10.3, 10.4).
 *
 * What is load-bearing here are the refusals. Each of the nine conditions is
 * closed on its own and read back by name, because a gate tested only
 * end-to-end proves nothing about the eight conditions that never got a
 * chance to fail. On top of that, the four the concept calls out explicitly:
 * no promotion without BOTH intervals clear of zero, a field the user set is
 * never overwritten, one promotion a night, and the same evidence never
 * promotes twice (H6).
 *
 * Frozen clock, for the same reason as the AP8 tests: `recency` and the
 * freshness sensor both read `Date.now()`, and the cooldown clock this file
 * sets is compared against a time it also computes.
 */

const FIXED_NOW = Date.parse('2026-09-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = ASSISTANT_MEMORY_OWNER;
const QUERY = 'harbor ledger';
const RUN_ID = 'run-tonight';

function withFrozenClock(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return run();
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

/* ------------------------------ the fixtures ------------------------------ */

/** The night's switch is on; everything else stays at the shipped defaults. */
function promoteOn(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      dream: { ...DEFAULT_CONFIG.memory.dream, promote: true, ...overrides },
    },
  };
}

/**
 * A holdout evaluation that clears every numeric condition: delta well over
 * the 0.02 margin, an interval clear of zero, the freshness sensor agreeing,
 * the audit numbers on the row. Each test closes exactly one of them.
 */
function evalResult(overrides = {}) {
  const delta = overrides.delta ?? 0.05;
  return {
    slot: 'recall',
    traces: 260,
    closed: 240,
    abstained: 20,
    abstainReasons: {},
    reachableRate: 0.8,
    labelCoverage: 0.6,
    costOnlyShare: 0.2,
    score: 0.71,
    baseline: 0.66,
    delta,
    ciLow: 0.01,
    ciHigh: 0.09,
    auditDelta: 0.04,
    auditCiLow: 0.01,
    deltaLive: delta,
    signAgree: true,
    evalMs: 120,
    traceSetHash: 'hash-night-one',
    evidenceDigest: 'slot=recall n=260 closed=240',
    detail: undefined,
    valid: true,
    violations: [],
    sessions: 18,
    closedBaseline: 245,
    closedCandidate: 242,
    abstainRateBaseline: 0.05,
    abstainRateCandidate: 0.07,
    freshness: {
      frames: 240,
      closedBoth: 220,
      deltaFrozen: delta,
      deltaLive: delta,
      signAgree: true,
      rowsDifferShare: 0,
    },
    error: null,
    ...overrides,
  };
}

/** The label agreement sensor with nothing to report (5.5b). */
function agreementOk(overrides = {}) {
  return {
    labelsBySource: { correction: 40, user: 14 },
    pairs: [],
    userPairs: 14,
    userKappa: 0.62,
    userAgreement: 0.81,
    validated: true,
    floorHolds: true,
    influenceableOnly: false,
    findings: [],
    ok: true,
    ...overrides,
  };
}

/** Every field at the factory default: nothing the user owns is in the way. */
const DEFAULT_ORIGIN = {
  limit: 'default',
  threshold: 'default',
  hopEntity: 'default',
  hopEdge: 'default',
  relevance: 'default',
  importance: 'default',
  recency: 'default',
  usage: 'default',
};

/** The parameter set a promotion would write. */
const CANDIDATE_PARAMS = {
  limit: 6,
  threshold: 0.1,
  w: { relevance: 0.5, importance: 0.25, recency: 0.15, usage: 0.1 },
};

/** An input that clears all nine conditions; every test closes exactly one. */
function cleanInput(overrides = {}) {
  return {
    config: promoteOn(),
    holdout: evalResult(),
    audit: evalResult({ delta: 0.04, ciLow: 0.012, traceSetHash: 'hash-audit' }),
    holdoutChecks: 1,
    agreement: agreementOk(),
    admission: { ok: true, findings: [] },
    slotState: { owner: OWNER, slot: 'recall' },
    lastTraceSetHash: null,
    incumbentOrigin: DEFAULT_ORIGIN,
    params: CANDIDATE_PARAMS,
    promotionsTonight: 0,
    exploredTonight: false,
    now: FIXED_NOW,
    ...overrides,
  };
}

/* ------------------------------ the clean pass ------------------------------ */

test('all nine conditions holding is the only way through the gate (10.2)', () => {
  const decision = promotionDecision(cleanInput());
  assert.deepEqual(decision.blockers, []);
  assert.equal(decision.promote, true);
});

/* --------------------- each condition, closed on its own --------------------- */

test('each of the nine conditions blocks on its own, under its own name (10.2)', () => {
  const cases = [
    // 1 - validity is absence of evidence, never a defeat for the candidate.
    [
      'evaluation-invalid',
      { holdout: evalResult({ valid: false, violations: ['n-closed-below-min'] }) },
    ],
    ['evaluation-invalid', { holdout: evalResult({ error: 'boom' }) }],
    // 2a - two tests, not one.
    ['delta-below-margin', { holdout: evalResult({ delta: 0.01 }) }],
    ['ci-low-not-positive', { holdout: evalResult({ ciLow: 0 }) }],
    // 2b - against the factory set, on the frozen audit set.
    ['audit-ci-low-not-positive', { audit: evalResult({ ciLow: -0.004 }) }],
    ['audit-missing', { audit: null, holdout: evalResult({ auditCiLow: undefined }) }],
    // 3 - exactly one candidate on the holdout.
    ['no-candidate-on-holdout', { holdoutChecks: 0 }],
    ['multiple-candidates-on-holdout', { holdoutChecks: 3 }],
    // 4 - the freshness sensor.
    ['freshness-sign-disagrees', { holdout: freshnessFlipped() }],
    ['freshness-undetermined', { holdout: evalResult({ signAgree: null, freshness: null }) }],
    // 5 - the label agreement sensor keeps its own finding names.
    [
      'user-labels-thin',
      { agreement: agreementOk({ validated: false, ok: false, findings: ['user-labels-thin'] }) },
    ],
    ['agreement-missing', { agreement: null }],
    // 6 - admission, evidence, cooldown.
    ['h1-coverage-floor', { admission: { ok: false, findings: ['h1-coverage-floor'] } }],
    ['admission-missing', { admission: null }],
    ['trace-set-not-disjoint', { lastTraceSetHash: 'hash-night-one' }],
    [
      'cooldown-active',
      { slotState: { owner: OWNER, slot: 'recall', cooldownUntil: FIXED_NOW + DAY_MS } },
    ],
    // 7 - the freeze and the user's own fields.
    [
      'slot-frozen',
      { slotState: { owner: OWNER, slot: 'recall', frozenAt: FIXED_NOW, frozenReason: 'staleness' } },
    ],
    ['user-field-overwritten:limit', { incumbentOrigin: { ...DEFAULT_ORIGIN, limit: 'user' } }],
    // 8 - the cap and the switch.
    ['promotion-cap-reached', { promotionsTonight: 1 }],
    ['promote-disabled', { config: promoteOn({ promote: false }) }],
    // 9 - exploration and promotion never share a night in one slot (E17).
    ['exploration-night', { config: promoteOn({ explorationRate: 0.2 }) }],
    ['exploration-night', { exploredTonight: true }],
  ];

  for (const [blocker, overrides] of cases) {
    const decision = promotionDecision(cleanInput(overrides));
    assert.equal(decision.promote, false, blocker + ' must block');
    assert.deepEqual(
      decision.blockers,
      [blocker],
      'exactly one condition was closed, so exactly one name comes back: ' + blocker,
    );
  }
});

/** The freshness sensor with the sign flipped - the one reading that is not "moot". */
function freshnessFlipped() {
  return evalResult({
    signAgree: false,
    freshness: {
      frames: 240,
      closedBoth: 220,
      deltaFrozen: 0.05,
      deltaLive: -0.03,
      signAgree: false,
      rowsDifferShare: 0.4,
    },
  });
}

test('a missing holdout is one fact, not four (10.2)', () => {
  const decision = promotionDecision(cleanInput({ holdout: null }));
  assert.deepEqual(decision.blockers, ['holdout-missing']);
});

test('the predicates answer on their own, without the gate around them', () => {
  assert.equal(evaluationIsValid(evalResult()), true);
  assert.equal(evaluationIsValid(evalResult({ valid: false })), false);
  assert.equal(holdoutBeatsIncumbent(evalResult({ delta: 0.05 }), 0.02), true);
  assert.equal(holdoutBeatsIncumbent(evalResult({ delta: 0.02 }), 0.02), false, 'the margin is strict');
  assert.equal(auditBeatsFactory(0.0001), true);
  assert.equal(auditBeatsFactory(0), false);
  assert.equal(auditBeatsFactory(null), false);
  assert.equal(auditBeatsFactory(undefined), false);
  assert.equal(oneCandidateOnHoldout(1), true);
  assert.equal(oneCandidateOnHoldout(2), false);
  // Inside the margin the sign comparison is moot, and moot is a pass -
  // condition 2a rejects that candidate anyway.
  assert.equal(freshnessAgrees(null, 0.01, 0.02), true);
  assert.equal(freshnessAgrees(null, 0.5, 0.02), false);
  assert.equal(freshnessAgrees(false, 0.5, 0.02), false);
  assert.equal(freshnessAgrees(true, null, 0.02), true);
  assert.equal(agreementHolds(agreementOk()), true);
  assert.equal(agreementHolds(agreementOk({ ok: false, findings: ['below'] })), false);
  assert.equal(admissionClean({ ok: true, findings: [] }), true);
  // The first promotion of a slot has nothing to be disjoint from.
  assert.equal(traceSetIsDisjoint('a', null), true);
  assert.equal(traceSetIsDisjoint('a', 'a'), false);
  assert.equal(traceSetIsDisjoint('a', 'b'), true);
  assert.equal(cooldownExpired({ owner: OWNER, slot: 'recall' }, FIXED_NOW), true);
  const cooling = (until) => ({ owner: OWNER, slot: 'recall', cooldownUntil: until });
  assert.equal(cooldownExpired(cooling(FIXED_NOW), FIXED_NOW), true);
  assert.equal(cooldownExpired(cooling(FIXED_NOW + 1), FIXED_NOW), false);
  assert.equal(slotIsThawed({ owner: OWNER, slot: 'recall' }), true);
  assert.equal(slotIsThawed({ owner: OWNER, slot: 'recall', frozenAt: 1 }), false);
  assert.equal(withinNightlyCap(0, 1), true);
  assert.equal(withinNightlyCap(1, 1), false);
  assert.equal(explorationHolds(0, false), true);
  assert.equal(explorationHolds(0.1, false), false);
  assert.equal(explorationHolds(0, true), false);
});

/* ------------------- the four the concept names explicitly ------------------- */

test('without ci_low > 0 AND audit_ci_low > 0 there is no promotion (10.2, condition 2)', () => {
  // Either interval alone is not enough, and the two are cumulative: the
  // holdout compares against the incumbent, the audit set against the
  // factory parameter set. A chain of steps each significant only against
  // its own predecessor is a random walk with a ratchet.
  const holdoutOnly = promotionDecision(
    cleanInput({ audit: evalResult({ ciLow: -0.01 }) }),
  );
  assert.equal(holdoutOnly.promote, false);
  assert.deepEqual(holdoutOnly.blockers, ['audit-ci-low-not-positive']);

  const auditOnly = promotionDecision(cleanInput({ holdout: evalResult({ ciLow: -0.02 }) }));
  assert.equal(auditOnly.promote, false);
  assert.deepEqual(auditOnly.blockers, ['ci-low-not-positive']);

  const neither = promotionDecision(
    cleanInput({ holdout: evalResult({ ciLow: 0 }), audit: evalResult({ ciLow: 0 }) }),
  );
  assert.equal(neither.promote, false);
  assert.deepEqual(neither.blockers, ['ci-low-not-positive', 'audit-ci-low-not-positive']);

  // And a delta big enough to look convincing does not buy either of them.
  const loud = promotionDecision(
    cleanInput({ holdout: evalResult({ delta: 0.9, ciLow: -0.4, ciHigh: 1.2 }) }),
  );
  assert.equal(loud.promote, false);
});

test("a field with origin 'user' is never overwritten (9.3, condition 7)", () => {
  for (const field of ['limit', 'threshold', 'hopEntity', 'hopEdge']) {
    const decision = promotionDecision(
      cleanInput({
        incumbentOrigin: { ...DEFAULT_ORIGIN, [field]: 'user' },
        params: { limit: 6, threshold: 0.1, hopEntity: 0.4, hopEdge: 0.3, w: CANDIDATE_PARAMS.w },
      }),
    );
    assert.deepEqual(decision.blockers, ['user-field-overwritten:' + field]);
  }

  // The four scoring weights live one level down, exactly where the resolver
  // reads them - a promotion may not reach them either.
  const weighted = promotionDecision(
    cleanInput({ incumbentOrigin: { ...DEFAULT_ORIGIN, recency: 'user' } }),
  );
  assert.deepEqual(weighted.blockers, ['user-field-overwritten:recency']);

  // A field the user owns but the candidate does not set is not a collision:
  // nothing would be overwritten.
  const untouched = promotionDecision(
    cleanInput({
      incumbentOrigin: { ...DEFAULT_ORIGIN, hopEdge: 'user' },
      params: { limit: 6, w: CANDIDATE_PARAMS.w },
    }),
  );
  assert.deepEqual(untouched.blockers, []);

  // And the predicate itself, without the gate around it.
  assert.deepEqual(
    overwrittenUserFields({ limit: 4, w: { relevance: 0.6 } }, { limit: 'user', relevance: 'user' }),
    ['limit', 'relevance'],
  );
  assert.deepEqual(overwrittenUserFields({ limit: 4 }, { limit: 'dream' }), []);
  assert.deepEqual(overwrittenUserFields({ limit: 'nonsense' }, { limit: 'user' }), []);
  assert.deepEqual(overwrittenUserFields(CANDIDATE_PARAMS, undefined), []);
});

test('at most one promotion a night, across every slot (10.2, condition 8)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = promoteOn();
    let promotionsTonight = 0;

    const first = promotionDecision(cleanInput({ promotionsTonight }));
    assert.equal(first.promote, true);
    const record = applyPromotion(store, {
      owner: OWNER,
      slot: 'recall',
      sleepRunId: RUN_ID,
      config,
      params: CANDIDATE_PARAMS,
      box: { limitMax: 16 },
      holdout: evalResult(),
      audit: evalResult({ ciLow: 0.012 }),
      now: FIXED_NOW,
    });
    promotionsTonight += record.promoted;
    assert.equal(promotionsTonight, 1, 'one applied promotion counts as one');

    // The cap is across every slot, so the second attempt of the night is
    // blocked even in a slot that has never promoted anything.
    const other = evalResult({ slot: 'budget', traceSetHash: 'other' });
    const second = promotionDecision(cleanInput({ promotionsTonight, holdout: other }));
    assert.equal(second.promote, false);
    assert.ok(second.blockers.includes('promotion-cap-reached'));

    // And with the cap raised, the same night may promote again - the cap is
    // the only thing that was in the way.
    const raised = promotionDecision(
      cleanInput({
        promotionsTonight,
        config: promoteOn({ maxPromotionsPerNight: 2 }),
        holdout: other,
      }),
    );
    assert.deepEqual(raised.blockers, []);
  });
});

test('two nights with no new labelled traces promote nothing in the second (H6)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = promoteOn();
    // The evidence of night one: a hash over the trace ids, exactly as
    // `evaluateCandidate` computes it.
    const traceIds = Array.from({ length: 40 }, (_, index) => 'trace-' + index);
    const hash = traceSetHash(traceIds);
    const night1 = evalResult({ traceSetHash: hash });

    assert.equal(promotionDecision(cleanInput({ holdout: night1 })).promote, true);
    applyPromotion(store, {
      owner: OWNER,
      slot: 'recall',
      sleepRunId: 'run-night-1',
      config,
      params: CANDIDATE_PARAMS,
      box: { limitMax: 16 },
      holdout: night1,
      audit: evalResult({ ciLow: 0.012 }),
      now: FIXED_NOW,
    });

    // Night two, nothing new was labelled: the same traces, in whatever
    // order they come back, produce the same hash.
    const shuffled = [...traceIds].reverse();
    assert.equal(traceSetHash(shuffled), hash, 'the hash is over a set, not a list');

    const state = store.slotState(OWNER, 'recall');
    const lastHash = store.lastPromotedTraceSetHash(OWNER, 'recall');
    assert.equal(lastHash, hash);

    // However good the candidate looks the second time round.
    const spectacular = evalResult({ traceSetHash: hash, delta: 0.9, ciLow: 0.7, ciHigh: 1.1 });
    const night2 = promotionDecision(
      cleanInput({
        holdout: spectacular,
        audit: evalResult({ delta: 0.8, ciLow: 0.6 }),
        slotState: state,
        lastTraceSetHash: lastHash,
        now: FIXED_NOW + DAY_MS,
      }),
    );
    assert.equal(night2.promote, false);
    assert.ok(night2.blockers.includes('trace-set-not-disjoint'), 'the evidence is spent');
    assert.ok(night2.blockers.includes('cooldown-active'), 'and the cooldown has not run out');

    // A week later the cooldown is gone, but the evidence still is not.
    const later = promotionDecision(
      cleanInput({
        holdout: spectacular,
        slotState: state,
        lastTraceSetHash: lastHash,
        now: FIXED_NOW + 8 * DAY_MS,
      }),
    );
    assert.deepEqual(later.blockers, ['trace-set-not-disjoint']);

    // New labelled traces, after the cooldown: that is the one way through.
    const fresh = evalResult({ traceSetHash: traceSetHash([...traceIds, 'trace-new']) });
    const allowed = promotionDecision(
      cleanInput({
        holdout: fresh,
        slotState: state,
        lastTraceSetHash: lastHash,
        now: FIXED_NOW + 8 * DAY_MS,
      }),
    );
    assert.deepEqual(allowed.blockers, []);
  });
});

/* ------------------------- the frozen slot keeps measuring ------------------------- */

const WORDS = [
  'zephyrine',
  'brambleworth',
  'corvidae',
  'nightjar',
  'salterne',
  'thrimble',
  'quillon',
  'vantrace',
  'mordent',
  'sablefish',
  'glimmerwick',
  'oxhollow',
];

/** The point the fixture frames were recorded at. */
const RECORDED_POLICY = {
  limit: 8,
  threshold: 0.12,
  hopEntity: 0,
  hopEdge: 0,
  kinds: [],
  minImportance: 0,
  w: WEIGHTS,
};

const NARROW = { limit: 4, threshold: 0, hopEntity: 0, hopEdge: 0 };
const WIDE = { limit: 8, threshold: 0, hopEntity: 0, hopEdge: 0 };

/** Every validity rule opened up but the one a test is about (AP8's pattern). */
function permissive() {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      dream: {
        ...DEFAULT_CONFIG.memory.dream,
        promote: true,
        minTraces: 1,
        coverageFloor: 0,
        costOnlyCeiling: 1,
        abstainEps: 1,
        abstainFloor: 1,
        reachableFloor: 0,
      },
    },
  };
}

function seedBank(store) {
  return WORDS.map((word, index) =>
    store.upsertMemory({
      kind: 'fact',
      content: 'harbor ledger ' + word + ' entry about the quay',
      importance: 0.9 - index * 0.05,
    }),
  );
}

function recordFrame(store) {
  return fetchFrame(store, {
    text: QUERY,
    owner: OWNER,
    limit: 8,
    box: {
      ...boxFromOptions({ text: QUERY, limit: 8, threshold: 0.12, hopEntity: 0, hopEdge: 0 }),
      limitMax: 16,
      threshold: [0, 0.3],
    },
    site: 'turn',
    pipeline: 'assistant',
    budgetChars: Math.floor(DEFAULT_CONFIG.memory.contextBudget * 0.4),
    subject: 'this user',
  });
}

/** One pool entry, shaped as `store.framesFor` hands it over (AP8's fixture). */
function entryOf(payload, { id, turnId, sessionId }) {
  return {
    trace: {
      id,
      turnId,
      owner: OWNER,
      kind: 'turn',
      site: 'turn',
      pipeline: 'assistant',
      sessionId,
      sessionKind: 'chat',
      turnIndex: 0,
      policySet: { recall: RECORDED_POLICY },
      framed: true,
      holdout: false,
      audit: false,
      degraded: null,
      startedAt: FIXED_NOW,
      finishedAt: FIXED_NOW,
      createdAt: FIXED_NOW,
    },
    frame: {
      traceId: id,
      slot: 'recall',
      frameV: 1,
      owner: OWNER,
      sessionId,
      box: payload.box,
      corpusStampId: payload.corpusStampId,
      payload,
      bytes: 0,
      createdAt: FIXED_NOW,
    },
  };
}

/** The ids an arm really rendered, so the fixture labels what actually moved. */
function renderedIds(payload, policy) {
  const run = pipelineAssistant(payload, policy);
  assert.ok(run.ok, 'the fixture frame must close on this arm');
  return run.lines.map((memory) => memory.id);
}

/**
 * A pool whose labelled row only the WIDE arm renders, so the wide arm is
 * genuinely better and the delta is label-backed rather than block length.
 */
function labelledPool(store, count) {
  const payload = recordFrame(store);
  const narrow = renderedIds(payload, NARROW);
  const entries = [];
  const target = renderedIds(payload, WIDE).find((id) => !narrow.includes(id));
  assert.ok(target, 'the fixture needs a row only the wide arm renders');

  for (let index = 0; index < count; index += 1) {
    const sessionId = 'session-' + index;
    const turnId = 'turn-' + index;
    entries.push(entryOf(payload, { id: 'trace-' + index, turnId, sessionId }));
    store.putLabel({
      turnId,
      target,
      source: 'correction',
      relevance: 1,
      scope: 'turn',
      owner: OWNER,
      sessionId,
      createdAt: FIXED_NOW,
    });
  }
  return entries;
}

test('a frozen slot does not promote, and goes on measuring (10.3)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const entries = labelledPool(store, 12);

    const state = freezeFor(store, OWNER, 'recall', 'staleness', FIXED_NOW);
    assert.equal(state.frozenReason, 'staleness');
    assert.equal(state.frozenAt, FIXED_NOW);

    // Measuring is untouched by the freeze: the evaluation runs, closes its
    // traces and certifies itself, which is exactly the evidence a person
    // needs to decide whether to thaw the slot again.
    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries,
      baseline: NARROW,
      candidate: WIDE,
      freshness: false,
    });
    assert.equal(result.error, null);
    assert.equal(result.valid, true, 'a frozen slot still produces a valid evaluation');
    assert.ok(result.closed > 0, 'and still closes traces');
    assert.ok(result.delta > 0, 'and still sees the better arm');

    // Promoting is the one thing it no longer does.
    const frozen = promotionDecision(cleanInput({ slotState: state }));
    assert.equal(frozen.promote, false);
    assert.deepEqual(frozen.blockers, ['slot-frozen']);

    // Thawed again, the very same numbers go through - the freeze was the
    // only thing in the way.
    store.thawSlot(OWNER, 'recall');
    const thawed = promotionDecision(cleanInput({ slotState: store.slotState(OWNER, 'recall') }));
    assert.deepEqual(thawed.blockers, []);
  });
});

test('the four freeze causes of 10.3, and the one that is deliberately not a cause', () => {
  assert.equal(freezeReasonFor({ manual: true }), 'manual');
  assert.equal(freezeReasonFor({ calibrationDrift: 0.2, tolerance: 0.05 }), 'calibration');
  assert.equal(freezeReasonFor({ calibrationDrift: -0.2, tolerance: 0.05 }), 'calibration');
  assert.equal(freezeReasonFor({ calibrationDrift: 0.01, tolerance: 0.05 }), null);
  assert.equal(freezeReasonFor({ signAgree: false }), 'staleness');
  assert.equal(freezeReasonFor({ signAgree: true }), null);
  assert.equal(freezeReasonFor({ signAgree: null }), null, 'undetermined is not a flip');
  assert.equal(
    freezeReasonFor({
      agreement: agreementOk({ floorHolds: false, ok: false, findings: ['agreement-below-floor'] }),
    }),
    'agreement',
  );
  // Thin `user` labels block a promotion (condition 5) and must NOT freeze
  // the slot: a bank nobody has corrected yet would freeze on its first
  // night and never thaw, and that looks identical to a real regression.
  assert.equal(
    freezeReasonFor({
      agreement: agreementOk({
        validated: false,
        floorHolds: false,
        ok: false,
        findings: ['user-labels-thin'],
      }),
    }),
    null,
  );
  assert.equal(freezeReasonFor({}), null);
  // A person's reason wins over a sensor's, so the record says what the
  // person said.
  assert.equal(freezeReasonFor({ manual: true, signAgree: false }), 'manual');
});

/* ------------------------------ applying one ------------------------------ */

test('a promotion writes its version, spends its evidence and starts the cooldown (8.5, E18)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const config = promoteOn();
    const holdout = evalResult();
    const audit = evalResult({ delta: 0.04, ciLow: 0.012 });

    // What was in force before: a first version, promoted by an earlier night.
    const previous = store.createPolicyVersion({
      owner: OWNER,
      slot: 'recall',
      params: { limit: 8 },
      box: { limitMax: 16 },
      origin: 'dream',
    });
    store.promotePolicyVersion(previous.id, { at: FIXED_NOW - 30 * DAY_MS });

    const record = applyPromotion(store, {
      owner: OWNER,
      slot: 'recall',
      sleepRunId: RUN_ID,
      config,
      params: CANDIDATE_PARAMS,
      box: { limitMax: 16 },
      holdout,
      audit,
      now: FIXED_NOW,
    });

    assert.equal(record.promoted, 1, 'what the night adds to dream_promoted');
    assert.equal(record.prevActiveId, previous.id);
    assert.equal(record.version.origin, 'dream');
    assert.equal(record.version.sleepRunId, RUN_ID, 'every promotion carries its run id (E18)');
    assert.equal(record.version.prevActiveId, previous.id, 'and what it replaced (8.5)');
    assert.equal(record.version.parentId, previous.id);
    assert.equal(record.version.version, 2);
    assert.equal(record.version.replayScore, holdout.score);
    assert.equal(record.version.replayN, holdout.closed);
    assert.equal(record.version.baselineScore, holdout.baseline);
    assert.equal(record.version.auditDelta, audit.delta);
    assert.equal(record.version.auditCiLow, audit.ciLow);

    // `promotePolicyVersion` already retires the predecessor and moves the
    // slot's clock; this file does not do it a second time.
    const active = store.activePolicy(OWNER, 'recall');
    assert.equal(active.id, record.version.id);
    assert.ok(store.policyVersion(previous.id).retiredAt, 'the predecessor is retired');
    assert.equal(store.slotState(OWNER, 'recall').lastPromoted, FIXED_NOW);

    // The evaluation row is the receipt, and it is what makes the evidence
    // spent for the next night (H6).
    assert.equal(record.evaluation.promoted, true);
    assert.equal(record.evaluation.policyId, record.version.id);
    assert.equal(record.evaluation.sleepRunId, RUN_ID);
    assert.equal(record.evaluation.auditCiLow, audit.ciLow);
    assert.equal(store.lastPromotedTraceSetHash(OWNER, 'recall'), holdout.traceSetHash);
    assert.equal(store.listDreamEvals({ owner: OWNER, promoted: true }).length, 1);

    // The cooldown clock, in nights.
    assert.equal(record.cooldownUntil, FIXED_NOW + config.memory.dream.cooldownNights * DAY_MS);
    assert.equal(store.slotState(OWNER, 'recall').cooldownUntil, record.cooldownUntil);
    assert.equal(cooldownExpired(store.slotState(OWNER, 'recall'), FIXED_NOW + DAY_MS), false);
  });
});

test('the first promotion of a slot records that nothing was active (8.5)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const record = applyPromotion(store, {
      owner: OWNER,
      slot: 'recall',
      sleepRunId: RUN_ID,
      config: promoteOn(),
      params: CANDIDATE_PARAMS,
      box: { limitMax: 16 },
      holdout: evalResult(),
      now: FIXED_NOW,
    });
    assert.equal(record.prevActiveId, null, 'NULL means "there was none", as snapshotSkill does it');
    assert.equal(record.version.version, 1);
    assert.equal(record.version.parentId, undefined);
    // With no separate audit evaluation the numbers on the holdout row are
    // what the version carries.
    assert.equal(record.version.auditCiLow, evalResult().auditCiLow);
  });
});

test('the stored rationale carries numbers, never a word of what it measured (E19)', () => {
  const rationale = renderRationale(evalResult(), evalResult({ delta: 0.04, ciLow: 0.012 }));
  for (const word of WORDS) {
    assert.ok(!rationale.includes(word), 'no verbatim text in a rationale that outlives its frames');
  }
  assert.ok(rationale.includes('d=+0.0500'));
  assert.ok(rationale.includes('audit=+0.0400/+0.0120'));
  assert.ok(rationale.includes('bound=lower'));
  assert.ok(rationale.includes('ci-kind=approximate'));
});

/* ------------------------------- reverting ------------------------------- */

test('the manual revert puts prev_active_id back in charge (10.4)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const first = store.createPolicyVersion({
      owner: OWNER,
      slot: 'recall',
      params: { limit: 8 },
      box: { limitMax: 16 },
      origin: 'dream',
    });
    store.promotePolicyVersion(first.id, { at: FIXED_NOW - 30 * DAY_MS });
    const record = applyPromotion(store, {
      owner: OWNER,
      slot: 'recall',
      sleepRunId: RUN_ID,
      config: promoteOn(),
      params: CANDIDATE_PARAMS,
      box: { limitMax: 16 },
      holdout: evalResult(),
      now: FIXED_NOW,
    });

    const reverted = revertPolicy(store, record.version.id, { owner: OWNER, at: FIXED_NOW + DAY_MS });
    assert.equal(reverted.ok, true);
    assert.deepEqual(reverted.findings, []);
    assert.equal(reverted.retired.retiredAt, FIXED_NOW + DAY_MS);
    assert.equal(reverted.restored.id, first.id);
    assert.equal(store.activePolicy(OWNER, 'recall').id, first.id, 'the predecessor is in charge again');

    // Twice is not twice: the second call has nothing left to retire.
    const again = revertPolicy(store, record.version.id, { owner: OWNER });
    assert.equal(again.ok, false);
    assert.deepEqual(again.findings, ['policy-already-retired']);
  });
});

test('a revert of the first promotion leaves the slot with no version at all (10.4)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const record = applyPromotion(store, {
      owner: OWNER,
      slot: 'recall',
      sleepRunId: RUN_ID,
      config: promoteOn(),
      params: CANDIDATE_PARAMS,
      box: { limitMax: 16 },
      holdout: evalResult(),
      now: FIXED_NOW,
    });
    const reverted = revertPolicy(store, record.version.id);
    assert.equal(reverted.ok, true);
    assert.equal(reverted.restored, null, 'there was none, and that is an outcome');
    assert.equal(store.activePolicy(OWNER, 'recall'), null, 'the resolver falls back to the defaults');
  });
});

test('a revert refuses what it cannot revert, and never crosses an owner (10.5)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    const unknown = revertPolicy(store, 'no-such-policy');
    assert.equal(unknown.ok, false);
    assert.deepEqual(unknown.findings, ['policy-not-found']);

    const draft = store.createPolicyVersion({
      owner: OWNER,
      slot: 'recall',
      params: { limit: 8 },
      box: { limitMax: 16 },
      origin: 'dream',
    });
    const never = revertPolicy(store, draft.id);
    assert.equal(never.ok, false);
    assert.deepEqual(never.findings, ['policy-never-promoted']);

    store.promotePolicyVersion(draft.id, { at: FIXED_NOW });
    const foreign = revertPolicy(store, draft.id, { owner: 'agent:someone-else' });
    assert.equal(foreign.ok, false);
    assert.deepEqual(foreign.findings, ['foreign-owner']);
    assert.equal(store.activePolicy(OWNER, 'recall').id, draft.id, 'and it really did not touch it');
  });
});
