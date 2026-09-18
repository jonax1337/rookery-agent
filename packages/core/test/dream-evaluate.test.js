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
import {
  abstainRuleHolds,
  agreementReport,
  coverageRuleHolds,
  evaluateCandidate,
  pairedOnIntersection,
  reachableFloorHolds,
  renderEvidenceDigest,
  selectOnTraining,
  splitOf,
  splitPool,
  traceFloorHolds,
  traceSetHash,
  validityLimits,
  validityOf,
} from '../dist/memory/dream/evaluate.js';
import { WEIGHTS } from '../dist/memory/recall.js';

/**
 * The evaluation machinery (dream stage 2, AP8; concept 5.3, 5.4, 5.5, 4.4).
 *
 * What is load-bearing here are the refusals, not the numbers. An evaluation
 * pairs only where both arms closed; a thin night comes back INVALID rather
 * than as a defeat for the candidate; a candidate that only ran where it felt
 * comfortable is rejected; a delta made of block length is not a delta; the
 * trace set hash is a set, not a list; and no read anywhere in this module
 * touches the bank it measures.
 *
 * Frozen clock (pattern from dream-measure.test.js and dream-probe.test.js):
 * `recency` and the freshness sensor's live re-fetch both read `Date.now()`,
 * so a frame recorded outside the freeze drifts against its own re-fetch and
 * the quiet-bank comparison would be lucky rather than honest.
 */

const FIXED_NOW = Date.parse('2026-09-17T12:00:00.000Z');
const OWNER = ASSISTANT_MEMORY_OWNER;
const QUERY = 'harbor ledger';

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

/**
 * A config with every validity rule opened up, so a test can close exactly
 * the one rule it is about. Testing five rules through one gate that fails on
 * the first of them tells you nothing about the other four.
 */
function permissive(overrides = {}) {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      dream: {
        ...DEFAULT_CONFIG.memory.dream,
        minTraces: 1,
        coverageFloor: 0,
        costOnlyCeiling: 1,
        abstainEps: 1,
        abstainFloor: 1,
        reachableFloor: 0,
        ...overrides,
      },
    },
  };
}

/**
 * Twelve rows that all answer the query, so a limit really selects - each
 * carrying a word that appears nowhere else in the system. A digest that ever
 * leaked verbatim text would be unmistakable.
 */
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

function seedBank(store) {
  return WORDS.map((word, index) =>
    store.upsertMemory({
      kind: 'fact',
      content: 'harbor ledger ' + word + ' entry about the quay',
      importance: 0.9 - index * 0.05,
    }),
  );
}

/** The declared box of a recorded frame: a real interval box, widened limit. */
function declaredBox(limitMax) {
  return {
    ...boxFromOptions({ text: QUERY, limit: 8, threshold: 0.12, hopEntity: 0, hopEdge: 0 }),
    limitMax,
    threshold: [0, 0.3],
  };
}

function recordFrame(store, limitMax = 16) {
  return fetchFrame(store, {
    text: QUERY,
    owner: OWNER,
    limit: 8,
    box: declaredBox(limitMax),
    site: 'turn',
    pipeline: 'assistant',
    budgetChars: Math.floor(DEFAULT_CONFIG.memory.contextBudget * 0.4),
    subject: 'this user',
  });
}

/**
 * One pool entry, shaped exactly as `store.framesFor` hands it over. The
 * evaluation reads frames and traces through this shape and labels through
 * the store, so the fixture keeps the frames in hand and the labels in the
 * bank - which is also what makes the "no write" assertion meaningful.
 */
function entryOf(payload, { id, turnId, sessionId, finishedAt = FIXED_NOW, holdout = false, audit = false }) {
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
      // A full parameter set: the freshness sensor builds its grid from the
      // trace's own recorded policy rather than resolving one (probe.ts).
      policySet: { recall: RECORDED_POLICY },
      framed: true,
      holdout,
      audit,
      degraded: null,
      startedAt: FIXED_NOW,
      finishedAt,
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

function label(store, turnId, target, { source = 'correction', relevance = 1, sessionId } = {}) {
  store.putLabel({
    turnId,
    target,
    source,
    relevance,
    scope: 'turn',
    owner: OWNER,
    sessionId,
    createdAt: FIXED_NOW,
  });
}

/** The ids the two arms rendered, so a fixture can label what actually moved. */
function renderedIds(payload, policy) {
  const run = pipelineAssistant(payload, policy);
  assert.ok(run.ok, 'the fixture frame must close on this arm');
  return run.lines.map((memory) => memory.id);
}

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

/**
 * A pool of `count` sessions, one frame each, all labelled on a row only the
 * WIDE arm renders - so the wide arm is genuinely better and the delta is
 * label-backed rather than block length.
 */
function labelledPool(store, sessionIds, { limitMax = 16, onlyShared = false } = {}) {
  const payload = recordFrame(store, limitMax);
  const narrow = renderedIds(payload, NARROW);
  const wide = renderedIds(payload, WIDE);
  const wideOnly = wide.filter((id) => !narrow.includes(id));
  const shared = wide.filter((id) => narrow.includes(id));
  assert.ok(wideOnly.length > 0, 'the fixture needs a row only the wide arm renders');
  assert.ok(shared.length > 0, 'the fixture needs a row both arms render');
  const target = onlyShared ? shared[0] : wideOnly[0];

  const entries = [];
  sessionIds.forEach((sessionId, index) => {
    const turnId = 'turn-' + sessionId + '-' + index;
    entries.push(
      entryOf(payload, { id: 'trace-' + sessionId + '-' + index, turnId, sessionId }),
    );
    label(store, turnId, target, { sessionId });
  });
  return { entries, payload, target, wideOnly, shared };
}

/** `access_count` and `usefulness` of every row - what a write would move. */
function bankCounters(store) {
  return store.db.prepare('SELECT id, access_count, usefulness FROM memories ORDER BY id').all();
}

function metaRows(store) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM meta').get().n;
}

/** Session ids that land in a given split, found by asking the split itself. */
function sessionsFor(split, count, rates) {
  const ids = [];
  for (let n = 0; ids.length < count && n < 20_000; n += 1) {
    const id = 'session-' + n;
    if (splitOf(id, rates) === split) ids.push(id);
  }
  assert.equal(ids.length, count, 'the fixture needs ' + count + ' ' + split + ' sessions');
  return ids;
}

/* --------------------------------- the split --------------------------------- */

test('the split is deterministic, session-wise, and the audit band is frozen (E3, 5.5d)', () => {
  const rates = { holdoutRate: 0.3, auditRate: 0.1 };
  const ids = Array.from({ length: 400 }, (_, index) => 'session-' + index);

  // Deterministic: the same id gets the same answer, run after run.
  for (const id of ids.slice(0, 20)) assert.equal(splitOf(id, rates), splitOf(id, rates));

  const counts = { train: 0, holdout: 0, audit: 0 };
  for (const id of ids) counts[splitOf(id, rates)] += 1;
  assert.equal(counts.train + counts.holdout + counts.audit, ids.length);
  assert.ok(counts.holdout > 0 && counts.audit > 0, 'both bands must actually be reachable');

  // The frozen set does not move when the holdout rate does: that is the
  // whole point of it being the floor the other two stand on (5.5d).
  const wider = { holdoutRate: 0.6, auditRate: 0.1 };
  for (const id of ids) {
    if (splitOf(id, rates) === 'audit') assert.equal(splitOf(id, wider), 'audit');
    if (splitOf(id, wider) === 'audit') assert.equal(splitOf(id, rates), 'audit');
  }

  // Rates of zero leave everything on the training side - a null step, not a
  // crash, because that is the state this stage ships in.
  for (const id of ids.slice(0, 50)) {
    assert.equal(splitOf(id, { holdoutRate: 0, auditRate: 0 }), 'train');
  }
  // Nonsense rates are clamped where they are read (S23/E21).
  assert.ok(['train', 'holdout', 'audit'].includes(splitOf('x', { holdoutRate: 9, auditRate: -3 })));
});

test('a trace stamped at record time keeps its side; only an unstamped one is drawn', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const payload = recordFrame(store);
    const rates = { holdoutRate: 0.3, auditRate: 0.1 };
    const trainSession = sessionsFor('train', 1, rates)[0];

    const stamped = entryOf(payload, {
      id: 'trace-stamped',
      turnId: 'turn-stamped',
      sessionId: trainSession,
      holdout: true,
    });
    const drawn = entryOf(payload, {
      id: 'trace-drawn',
      turnId: 'turn-drawn',
      sessionId: trainSession,
    });
    const pool = splitPool([stamped, drawn], rates);
    assert.equal(pool.holdout.length, 1, 'the stamp decides, not today rates');
    assert.equal(pool.train.length, 1, 'and an unstamped trace is drawn');
  });
});

/* ----------------------------- the five predicates ----------------------------- */

test('the five validity rules of concept 5.4 are separately decidable', () => {
  // Rule 1: the intersection, never each arm on its own set.
  assert.equal(
    pairedOnIntersection({ closedBaseline: 10, closedCandidate: 6, closed: 6, paired: 6 }),
    true,
  );
  assert.equal(
    pairedOnIntersection({ closedBaseline: 10, closedCandidate: 6, closed: 10, paired: 10 }),
    false,
    'a mean over the baseline own set is exactly the mistake rule 1 names',
  );
  assert.equal(
    pairedOnIntersection({ closedBaseline: 10, closedCandidate: 6, closed: 6, paired: 5 }),
    false,
    'one delta per closed trace, never fewer and never more',
  );

  // Rule 2: the slack against the baseline AND the ceiling on both arms.
  const limits = { abstainEps: 0.05, abstainFloor: 0.3 };
  assert.equal(abstainRuleHolds(0.12, 0.1, limits), true);
  assert.equal(abstainRuleHolds(0.2, 0.1, limits), false, 'more than eps over the baseline');
  assert.equal(abstainRuleHolds(0.31, 0.31, limits), false, 'both arms over the floor');

  // Rule 3: a floor on the closed traces, and nothing else.
  assert.equal(traceFloorHolds(200, 200), true);
  assert.equal(traceFloorHolds(199, 200), false);

  // Rule 4: the reachable share of the labelled targets.
  assert.equal(reachableFloorHolds(0.5, 0.5), true);
  assert.equal(reachableFloorHolds(0.49, 0.5), false);

  // Rule 5: coverage floor and cost-only ceiling, both sides.
  const shares = { coverageFloor: 0.3, costOnlyCeiling: 0.5 };
  assert.equal(coverageRuleHolds(0.31, 0.49, shares), true);
  assert.equal(coverageRuleHolds(0.29, 0.49, shares), false);
  assert.equal(coverageRuleHolds(0.31, 0.51, shares), false);

  // And the limits come out of the config clamped, never trusted raw (S23).
  const limitsFromConfig = validityLimits(permissive({ coverageFloor: 9, abstainEps: -1 }));
  assert.equal(limitsFromConfig.coverageFloor, 1);
  assert.equal(limitsFromConfig.abstainEps, 0);
});

/* ------------------------------- the trace set ------------------------------- */

test('trace_set_hash is a set: stable under reordering, different for a different set', () => {
  const a = traceSetHash(['t3', 't1', 't2']);
  const b = traceSetHash(['t1', 't2', 't3']);
  assert.equal(a, b, 'the order the night walked the pool in is not evidence');
  assert.notEqual(a, traceSetHash(['t1', 't2', 't4']), 'a different set is a different hash');
  assert.notEqual(a, traceSetHash(['t1', 't2']), 'a subset is a different hash');
  assert.equal(a.length, 64, 'sha256, hex');
  assert.equal(traceSetHash([]), traceSetHash([]), 'the empty set hashes to itself');
});

/* ------------------------------ the paired rule ------------------------------ */

test('only the intersection is paired: an arm never runs on its own set (rule 1)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const sessions = sessionsFor('train', 6, rates);

    // Three frames recorded under a box that reaches limit 16 and three
    // under one that stops at 8. The wide arm asks for 12 and is out of the
    // box on the tight three - an abstention that hits ONE arm only, which
    // is the only way to tell an intersection from a union at all.
    const wideBoxPool = labelledPool(store, sessions.slice(0, 3), { limitMax: 16 });
    const narrowBoxPool = labelledPool(store, sessions.slice(3), { limitMax: 8 });
    const entries = [...wideBoxPool.entries, ...narrowBoxPool.entries];

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries,
      baseline: NARROW,
      candidate: { ...WIDE, limit: 12 },
      freshness: false,
    });

    assert.equal(result.traces, 6);
    assert.equal(result.closedBaseline, 6, 'the narrow arm is inside every box');
    assert.equal(result.closedCandidate, 3, 'the wide arm leaves the tight box');
    assert.ok(result.closed <= result.closedCandidate, 'the mean runs on the intersection');
    assert.equal(
      pairedOnIntersection({
        closedBaseline: result.closedBaseline,
        closedCandidate: result.closedCandidate,
        closed: result.closed,
        paired: result.closed,
      }),
      true,
    );
    assert.equal(result.abstainReasons['limit-out-of-box'], 3, 'counted, never swallowed');
    assert.ok(!result.violations.includes('not-paired-on-intersection'));
  });
});

test('below minTraces the evaluation is INVALID, not a defeat for the candidate (rule 3)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const { entries } = labelledPool(store, sessionsFor('train', 3, rates));

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive({ minTraces: 200 }),
      entries,
      baseline: NARROW,
      candidate: WIDE,
      freshness: false,
    });

    assert.equal(result.valid, false);
    assert.deepEqual(result.violations, ['n-closed-below-min']);
    // The distinction that matters: the candidate did not lose. The measured
    // delta is still there, still positive, and still reported - it simply
    // does not certify anything yet.
    assert.ok(result.closed > 0 && result.closed < 200);
    assert.ok(result.delta > 0, 'the wide arm really did rank the labelled row');
    assert.ok(result.evidenceDigest.includes('valid=0'));
  });
});

test('a candidate that only ran where it felt comfortable is rejected (rule 2)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const sessions = sessionsFor('train', 10, rates);
    // Two frames the wide arm can replay, eight it cannot: it wins on the two
    // it likes and abstains on the rest.
    const easy = labelledPool(store, sessions.slice(0, 2), { limitMax: 16 });
    const hard = labelledPool(store, sessions.slice(2), { limitMax: 8 });

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive({ abstainEps: 0.05, abstainFloor: 0.3 }),
      entries: [...easy.entries, ...hard.entries],
      baseline: NARROW,
      candidate: { ...WIDE, limit: 12 },
      freshness: false,
    });

    assert.equal(result.closedBaseline, 10);
    assert.equal(result.closedCandidate, 2);
    assert.ok(result.abstainRateCandidate > result.abstainRateBaseline + 0.05);
    assert.equal(result.valid, false);
    assert.ok(result.violations.includes('abstain-rate'));
    // And the baseline arm, which answered everywhere, is not the one blamed.
    assert.equal(result.abstainRateBaseline, 0);
  });
});

test('a delta made of block length alone is not a delta (rule 5, concept 4.4)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    // The one labelled row is rendered by BOTH arms: everything that moved
    // between them is unlabelled, so whatever is left is characters.
    const { entries } = labelledPool(store, sessionsFor('train', 4, rates), { onlyShared: true });

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive({ costOnlyCeiling: 0.5 }),
      entries,
      baseline: NARROW,
      candidate: WIDE,
      freshness: false,
    });

    assert.equal(result.costOnlyShare, 1, 'every paired trace moved nothing labelled');
    assert.equal(result.abstainReasons['no-labelled-move'], 4);
    assert.equal(result.closed, 0, 'and none of them entered the mean');
    assert.equal(result.valid, false);
    assert.ok(result.violations.includes('cost-only-share'));
  });
});

test('a thin labelled universe invalidates the evaluation rather than reporting it (rule 5)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const { entries } = labelledPool(store, sessionsFor('train', 3, rates));

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive({ coverageFloor: 0.3 }),
      entries,
      baseline: NARROW,
      candidate: WIDE,
      freshness: false,
    });

    // One labelled row against a block of several: the estimator cannot tell
    // a real delta from labels nobody ever wrote (concept 4.4, E8).
    assert.ok(result.labelCoverage > 0 && result.labelCoverage < 0.3);
    assert.equal(result.valid, false);
    assert.ok(result.violations.includes('label-coverage'));
    assert.ok(result.reachableRate > 0, 'the labelled row is still reachable');
  });
});

test('a frame of another bank never reaches the measurement (concept 10.5)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const { entries, payload } = labelledPool(store, sessionsFor('train', 3, rates));
    const foreign = entryOf(payload, {
      id: 'trace-foreign',
      turnId: 'turn-foreign',
      sessionId: 'session-foreign',
    });
    foreign.frame.owner = 'agent:someone-else';
    foreign.trace.owner = 'agent:someone-else';

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries: [...entries, foreign],
      baseline: NARROW,
      candidate: WIDE,
      freshness: false,
    });

    assert.equal(result.traces, 3, 'the foreign frame is not even offered');
    assert.equal(result.detail.foreignOwner, 1, 'dropped and counted, never scored');
  });
});

/* --------------------------- the no-touch guarantee --------------------------- */

test('nothing the evaluation reads touches the bank, freshness sensor included (S30)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const { entries } = labelledPool(store, sessionsFor('train', 3, rates));

    const before = bankCounters(store);
    const meta = metaRows(store);
    const labelsBefore = store.db.prepare('SELECT COUNT(*) AS n FROM dream_labels').get().n;

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries,
      baseline: NARROW,
      candidate: WIDE,
      // The live re-fetch is the one read that could plausibly touch, so it
      // is explicitly ON for this test.
      freshness: true,
    });

    assert.deepEqual(bankCounters(store), before, 'access_count and usefulness are untouched');
    assert.equal(metaRows(store), meta, 'and no corpus stamp is written either');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM dream_labels').get().n, labelsBefore);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM dream_evals').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM memory_touches').get().n, 0);

    // The sensor ran and says what it is worth: on a bank nothing moved, the
    // frozen and the live world are the same world, and the report says so
    // instead of pretending the test had teeth.
    assert.ok(result.freshness);
    assert.equal(result.freshness.rowsDifferShare, 0, 'a quiet bank is a quiet sensor');
    assert.ok(result.freshness.closedBoth > 0);
    assert.ok(result.signAgree === true || result.signAgree === null);
    assert.ok(result.deltaLive !== undefined);
  });
});

/* ----------------------------- the evidence digest ----------------------------- */

test('the evidence digest condenses the reasoning and carries no verbatim text (E19)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0, auditRate: 0 };
    const { entries } = labelledPool(store, sessionsFor('train', 3, rates));

    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries,
      baseline: NARROW,
      candidate: WIDE,
      freshness: false,
    });

    const digest = result.evidenceDigest;
    assert.equal(typeof digest, 'string');
    for (const word of [...WORDS, 'harbor', 'ledger', 'quay']) {
      assert.ok(!digest.includes(word), 'the digest must not carry ' + word);
    }
    // Numbers and the closed vocabulary of the module, nothing else.
    assert.match(digest, /^[-+A-Za-z0-9 .,:=|[\]\/]+$/);
    assert.ok(digest.includes('closed=' + result.closed));
    assert.ok(digest.includes('hash=' + result.traceSetHash.slice(0, 12)));
    // The two words the concept insists stand next to the number, not in a
    // footnote: the estimator is a lower bound and the interval is approximate.
    assert.ok(digest.includes('bound=lower'));
    assert.ok(digest.includes('ci-kind=approximate'));
    assert.ok(digest.includes('src=correction:'), 'the per-source delta is part of the reasoning');
    // And it is a pure function of the finished result.
    assert.equal(renderEvidenceDigest(result), digest);
  });
});

/* -------------------------------- the selection -------------------------------- */

test('the ranking runs on training, one candidate goes to the holdout, the audit set is touched once (E4/S12/S13)', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0.3, auditRate: 0.1 };
    const sessions = [
      ...sessionsFor('train', 4, rates),
      ...sessionsFor('holdout', 3, rates),
      ...sessionsFor('audit', 2, rates),
    ];
    const { entries } = labelledPool(store, sessions);

    const report = selectOnTraining(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries,
      incumbent: NARROW,
      factory: NARROW,
      candidates: [NARROW, WIDE],
      rates,
      freshness: false,
    });

    assert.equal(report.split.train, 4);
    assert.equal(report.split.holdout, 3);
    assert.equal(report.split.audit, 2);
    assert.equal(report.ranked.length, 2, 'every candidate is ranked on the training half');
    assert.ok(report.chosen, 'one of them is ahead of the incumbent');
    assert.equal(report.chosen.policy, WIDE, 'and it is the one that ranks the labelled row');
    assert.ok(report.holdout, 'exactly one candidate reaches the holdout');
    assert.equal(report.holdout.traces, 3, 'the holdout is the holdout, not the pool');

    // S13: the frozen set was opened exactly once, and only because a
    // promotion was actually on the table.
    assert.equal(report.auditTouched, 1);
    assert.ok(report.audit);
    assert.equal(report.audit.traces, 2);
    assert.equal(report.holdout.auditDelta, report.audit.delta);
    assert.equal(report.holdout.auditCiLow, report.audit.ciLow);
  });
});

test('no candidate ahead on training means no holdout run and an untouched audit set', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const rates = { holdoutRate: 0.3, auditRate: 0.1 };
    const sessions = [
      ...sessionsFor('train', 4, rates),
      ...sessionsFor('holdout', 3, rates),
      ...sessionsFor('audit', 2, rates),
    ];
    const { entries } = labelledPool(store, sessions);

    const report = selectOnTraining(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries,
      incumbent: NARROW,
      factory: NARROW,
      // The incumbent against itself: a null step, and a night that spends
      // nothing on it (concept 6.3 - the incumbent is always a candidate).
      candidates: [NARROW],
      rates,
      freshness: false,
    });

    assert.equal(report.chosen, null);
    assert.equal(report.holdout, null);
    assert.equal(report.audit, null);
    assert.equal(report.auditTouched, 0, 'the frozen set is not spent on a night with nothing to promote');
    assert.deepEqual(report.findings, ['no-candidate-ahead-on-training']);
  });
});

/* ----------------------------- the agreement sensor ----------------------------- */

function agreementLabels({ userCount, userFlips = 0 }) {
  const labels = [];
  for (let index = 0; index < 12; index += 1) {
    labels.push({
      turnId: 'turn-' + index,
      target: 'memory-' + index,
      source: 'correction',
      relevance: index < 9 ? 1 : 0,
      scope: 'turn',
      owner: OWNER,
      createdAt: FIXED_NOW,
    });
  }
  for (let index = 0; index < userCount; index += 1) {
    const agrees = index >= userFlips;
    labels.push({
      turnId: 'turn-' + index,
      target: 'memory-' + index,
      source: 'user',
      relevance: agrees ? (index < 9 ? 1 : 0) : index < 9 ? 0 : 1,
      scope: 'turn',
      owner: OWNER,
      createdAt: FIXED_NOW,
    });
  }
  return labels;
}

test('thin user labels are the finding, not a zero (concept 5.5b)', () => {
  const report = agreementReport(agreementLabels({ userCount: 3 }), { minUserPairs: 10 });
  assert.equal(report.userPairs, 3);
  assert.equal(report.validated, false, 'the proxy is unvalidated, and that is the answer');
  assert.equal(report.floorHolds, false);
  assert.ok(report.findings.includes('user-labels-thin'));
  assert.equal(report.ok, false);
  // Nothing is papered over: the pair that does exist is still reported.
  assert.equal(report.pairs.length, 1);
  assert.equal(report.labelsBySource.user, 3);
  assert.equal(report.labelsBySource.correction, 12);
});

test('with enough user labels the sensor reports an agreement and clears its floor', () => {
  const report = agreementReport(agreementLabels({ userCount: 12, userFlips: 1 }), {
    minUserPairs: 10,
    floor: 0.4,
  });
  assert.equal(report.userPairs, 12);
  assert.equal(report.validated, true);
  assert.ok(report.userKappa !== null || report.userAgreement !== null);
  assert.ok((report.userAgreement ?? 0) >= 0.9, 'eleven of twelve targets agree');
  assert.equal(report.floorHolds, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.ok, true);
});

test('a delta that lives only on the influenceable sources is flagged (concept 5.5b)', () => {
  const labels = agreementLabels({ userCount: 12, userFlips: 1 });
  const flagged = agreementReport(labels, {
    minUserPairs: 10,
    margin: 0.02,
    deltaBySource: { correction: 0.2, merge: 0.1, user: 0 },
  });
  assert.equal(flagged.influenceableOnly, true, 'up on what the policy can move, flat on the user');
  assert.ok(flagged.findings.includes('influenceable-only-delta'));
  assert.equal(flagged.ok, false);

  // The same labels with the user moving too: nothing to flag.
  const clean = agreementReport(labels, {
    minUserPairs: 10,
    margin: 0.02,
    deltaBySource: { correction: 0.2, user: 0.15 },
  });
  assert.equal(clean.influenceableOnly, false);
  assert.equal(clean.ok, true);

  // And a source that moved nothing is not evidence of a flat user either -
  // an absent user delta is undetermined, not a zero.
  const undetermined = agreementReport(labels, {
    minUserPairs: 10,
    deltaBySource: { correction: 0.2 },
  });
  assert.equal(undetermined.influenceableOnly, false);
});

/* ------------------------------ the whole verdict ------------------------------ */

test('validityOf reads a finished result and names every rule it broke', () => {
  const limits = {
    minTraces: 10,
    abstainEps: 0.05,
    abstainFloor: 0.3,
    reachableFloor: 0.5,
    coverageFloor: 0.3,
    costOnlyCeiling: 0.5,
  };
  const good = {
    closedBaseline: 20,
    closedCandidate: 18,
    closed: 18,
    abstainRateBaseline: 0.05,
    abstainRateCandidate: 0.08,
    reachableRate: 0.8,
    labelCoverage: 0.5,
    costOnlyShare: 0.2,
  };
  assert.deepEqual(validityOf(good, limits), { valid: true, violations: [] });

  const bad = {
    ...good,
    closed: 20,
    abstainRateCandidate: 0.4,
    reachableRate: 0.1,
    labelCoverage: 0.1,
    costOnlyShare: 0.9,
  };
  const verdict = validityOf(bad, limits);
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.violations, [
    'not-paired-on-intersection',
    'abstain-rate',
    'reachable-rate',
    'label-coverage',
    'cost-only-share',
  ]);
});

test('an aborted evaluation reports an empty, invalid result instead of throwing', () => {
  withFrozenClock(() => {
    const store = makeStore();
    seedBank(store);
    const controller = new AbortController();
    controller.abort();
    const result = evaluateCandidate(store, {
      owner: OWNER,
      slot: 'recall',
      config: permissive(),
      entries: [],
      baseline: NARROW,
      candidate: WIDE,
      signal: controller.signal,
    });
    assert.equal(result.valid, false);
    assert.deepEqual(result.violations, ['aborted']);
    assert.equal(result.closed, 0);
    assert.equal(result.error, null, 'an abort is not an error');
  });
});
