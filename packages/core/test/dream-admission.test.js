import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admit,
  boxViolations,
  coverageFloorHolds,
  isWeightScalarMultiple,
  revivalRateHolds,
} from '../dist/memory/dream/admission.js';

/**
 * The admission check (dream stage 2, AP5; concept 10.1, E15).
 *
 * The acceptance of this package is the falsification test the concept
 * demands: for each mechanism (H1, H3, H9), a candidate that scores HIGHER
 * than the incumbent under the naive measure of Fassung 1 - plain nDCG, a
 * frame-fixed ideal, no cost term, no weight normalisation - must still be
 * rejected here. `naiveNdcg` below is that naive measure, built exactly the
 * way it is described: DCG over a delivered list, divided by DCG over the
 * frame's own labelled ideal, independent of which policy delivered what.
 * If a mechanism cannot be made to score higher this way, the concept says
 * the mechanism is not a real gaming vector and should be deleted, not kept
 * for symmetry - every mechanism below genuinely can, so all four stay.
 *
 * `admit` never computes coverage or a revival rate itself (see the module
 * doc), so every fixture supplies `AdmissionStats` directly rather than
 * deriving it from the gain arrays - the two are constructed to tell the
 * same story, never to disagree.
 */

const INCUMBENT_WEIGHTS = { relevance: 0.55, importance: 0.2, recency: 0.15, usage: 0.1 };

/**
 * A weight vector that is NOT a positive scalar multiple of
 * `INCUMBENT_WEIGHTS` (one term perturbed off the common ratio). Fixtures
 * that want to isolate H1, H3 or a plain box violation use this instead of
 * the incumbent's exact weights - identical weights are themselves a
 * (trivial, scale = 1) positive scalar multiple, and would trip H9 too,
 * which is correct behaviour (an "unchanged" candidate is exactly the
 * degenerate case H9 exists to catch) but would defeat the isolation these
 * fixtures need.
 */
const NON_MULTIPLE_WEIGHTS = { relevance: 0.55, importance: 0.2, recency: 0.15, usage: 0.11 };

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

/** A `RecallPolicy`-shaped fixture, close to `resolvePolicy`'s stage-1 literals. */
function policy(overrides = {}) {
  return {
    limit: 8,
    threshold: 0.12,
    w: { ...INCUMBENT_WEIGHTS },
    hopEntity: 0.45,
    hopEdge: 0.6,
    kinds: [],
    minImportance: 0,
    origin: DEFAULT_ORIGIN,
    ...overrides,
  };
}

/** A `RecallBox`-shaped fixture wide enough to admit every fixture below unless a test narrows it. */
function box(overrides = {}) {
  return {
    limitMax: 16,
    w: {
      relevance: [0, 1],
      importance: [0, 1],
      recency: [0, 1],
      usage: [0, 1],
    },
    threshold: [0, 1],
    hopEntity: [0, 1],
    hopEdge: [0, 1],
    kinds: [],
    minImportance: 0,
    ...overrides,
  };
}

/** Positional discount over an ordered list of gains, one-based (same shape as dream-measure.test.js). */
function dcgOf(gains) {
  let sum = 0;
  for (let index = 0; index < gains.length; index += 1) sum += gains[index] / Math.log2(index + 2);
  return sum;
}

/**
 * The naive measure of Fassung 1: nDCG alone, over recall's return value
 * (here, a plain gain array), against a frame-fixed ideal that does not
 * depend on which policy delivered what - no cost term, no weight
 * normalisation, exactly the comparison the concept says admission must
 * still refuse under.
 */
function naiveNdcg(gains, idealGains) {
  const idcg = dcgOf(idealGains);
  if (idcg === 0) return 0;
  return dcgOf(gains) / idcg;
}

/** Three labelled positions exist in every fixture frame below, independent of policy. */
const IDEAL = [1, 1, 1];

test('a legal candidate that loses no coverage, no weights and no revivals is admitted', () => {
  const incumbent = policy();
  const candidate = policy({ threshold: 0.1, w: NON_MULTIPLE_WEIGHTS });
  const result = admit(candidate, incumbent, box(), {
    coverage: { candidate: 10, incumbent: 10 },
    revivalRate: { candidate: 0, incumbent: 0 },
  });
  assert.deepEqual(result, { ok: true, findings: [] });
});

test('H1 falsification: raising the threshold until only profile rows are left scores higher under the naive measure, and is rejected here', () => {
  // Incumbent: three relevant rows buried behind six irrelevant ones, at
  // ranks 3, 6 and 9 - the query-matched noise `direct` mixes in.
  const incumbentGains = [0, 0, 1, 0, 0, 1, 0, 0, 1];
  // Candidate: threshold raised until `direct` is empty (recall.ts:146);
  // only the two profile rows remain, both relevant, right at the top.
  const candidateGains = [1, 1];
  const naiveIncumbent = naiveNdcg(incumbentGains, IDEAL);
  const naiveCandidate = naiveNdcg(candidateGains, IDEAL);
  assert.ok(
    naiveCandidate > naiveIncumbent,
    `construction requires naive(candidate) > naive(incumbent), got ${naiveCandidate} <= ${naiveIncumbent}`,
  );

  // Weights not a scalar multiple, same revival rate: only retrieval
  // breadth moved, so H1 is the only predicate this fixture can trip.
  const incumbent = policy();
  const candidate = policy({ w: NON_MULTIPLE_WEIGHTS });
  const result = admit(candidate, incumbent, box(), {
    coverage: { candidate: candidateGains.length, incumbent: incumbentGains.length },
    revivalRate: { candidate: 0, incumbent: 0 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, ['h1-coverage-floor']);
});

test('H3 falsification: reviving more than the incumbent scores higher under the naive measure, and is rejected here', () => {
  // Incumbent delivers two of the three relevant rows; the third stayed
  // dormant.
  const incumbentGains = [1, 0, 1, 0, 0];
  // Candidate's write-gate reinforcement branch un-parks the third one
  // (`dormant_at = NULL`, `store.ts:303-305`) - an extra, genuine hit.
  const candidateGains = [1, 1, 1, 0, 0];
  const naiveIncumbent = naiveNdcg(incumbentGains, IDEAL);
  const naiveCandidate = naiveNdcg(candidateGains, IDEAL);
  assert.ok(
    naiveCandidate > naiveIncumbent,
    `construction requires naive(candidate) > naive(incumbent), got ${naiveCandidate} <= ${naiveIncumbent}`,
  );

  // Weights not a scalar multiple, same coverage: only the revival rate
  // moved, so H3 is the only predicate this fixture can trip.
  const incumbent = policy();
  const candidate = policy({ w: NON_MULTIPLE_WEIGHTS });
  const result = admit(candidate, incumbent, box(), {
    coverage: { candidate: 5, incumbent: 5 },
    revivalRate: { candidate: 0.4, incumbent: 0.1 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, ['h3-revival-rate']);
});

test('H9 falsification: scaling every weight by the same constant scores higher under the naive measure, and is rejected here', () => {
  // Incumbent's raw scores keep one relevant row below the (un-rescaled)
  // threshold; two of the three relevant rows make it through.
  const incumbentGains = [1, 0, 0, 1, 0];
  // Candidate multiplies every weight by 1.5: the ranking is unchanged, but
  // every raw score is inflated past `coreProfile`'s fixed literal of 1 and
  // past the threshold, so the third relevant row now crosses too.
  const candidateGains = [1, 0, 1, 1, 0];
  const naiveIncumbent = naiveNdcg(incumbentGains, IDEAL);
  const naiveCandidate = naiveNdcg(candidateGains, IDEAL);
  assert.ok(
    naiveCandidate > naiveIncumbent,
    `construction requires naive(candidate) > naive(incumbent), got ${naiveCandidate} <= ${naiveIncumbent}`,
  );

  const incumbent = policy();
  const scale = 1.5;
  const candidate = policy({
    w: {
      relevance: incumbent.w.relevance * scale,
      importance: incumbent.w.importance * scale,
      recency: incumbent.w.recency * scale,
      usage: incumbent.w.usage * scale,
    },
  });
  assert.ok(isWeightScalarMultiple(candidate.w, incumbent.w));

  // Same coverage, same revival rate: only the weight vector moved, so H9
  // is the only predicate this fixture can trip. The scaled weights stay
  // inside the box's [0,1] interval on purpose, so this is not also a box
  // violation.
  const result = admit(candidate, incumbent, box(), {
    coverage: { candidate: 5, incumbent: 5 },
    revivalRate: { candidate: 0, incumbent: 0 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, ['h9-weight-scalar-multiple']);
});

test('a box violation is a generation error with its own finding, never an abstention, and fires independently of H1/H3/H9', () => {
  const incumbent = policy();
  // 1.4 is outside box().threshold = [0, 1]: the frames this candidate
  // would need to replay against were never fetched at this corner.
  // Weights not a scalar multiple, so H9 passes on its own too.
  const candidate = policy({ threshold: 1.4, w: NON_MULTIPLE_WEIGHTS });
  const result = admit(candidate, incumbent, box(), {
    coverage: { candidate: 10, incumbent: 10 }, // H1 passes on its own.
    revivalRate: { candidate: 0, incumbent: 0 }, // H3 passes on its own.
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, ['box-violation:threshold']);
});

test('box violations are named per field and accumulate independently of the H1/H3/H9 findings', () => {
  const incumbent = policy();
  const candidate = policy({ limit: 32, hopEdge: -0.1, kinds: ['fact'], w: NON_MULTIPLE_WEIGHTS });
  const result = admit(candidate, incumbent, box(), {
    coverage: { candidate: 1, incumbent: 10 }, // trips H1 too.
    revivalRate: { candidate: 0, incumbent: 0 },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.findings,
    ['box-violation:limit', 'box-violation:hopEdge', 'box-violation:kinds', 'h1-coverage-floor'],
  );
});

test('boxViolations: every field checked, kinds and minImportance as exact literals (concept 3.4)', () => {
  assert.deepEqual(boxViolations(policy(), box()), []);
  assert.deepEqual(boxViolations(policy({ limit: -1 }), box()), ['box-violation:limit']);
  assert.deepEqual(boxViolations(policy({ limit: 17 }), box()), ['box-violation:limit']);
  assert.deepEqual(boxViolations(policy({ hopEntity: 1.5 }), box()), ['box-violation:hopEntity']);
  assert.deepEqual(
    boxViolations(policy({ w: { ...INCUMBENT_WEIGHTS, recency: 1.2 } }), box()),
    ['box-violation:w.recency'],
  );
  // Widening minImportance below the box's recorded literal admits rows
  // that were never fetched.
  assert.deepEqual(boxViolations(policy({ minImportance: -0.1 }), box({ minImportance: 0.2 })), [
    'box-violation:minImportance',
  ]);
  // A different kind set, same length: still a violation, not just a count check.
  assert.deepEqual(boxViolations(policy({ kinds: ['fact'] }), box({ kinds: ['preference'] })), [
    'box-violation:kinds',
  ]);
  // A narrower kind set than a non-empty box is still a literal mismatch: replay closure requires equality.
  assert.deepEqual(boxViolations(policy({ kinds: [] }), box({ kinds: ['fact'] })), ['box-violation:kinds']);
});

test('coverageFloorHolds: relative to the incumbent, equal to the floor still holds', () => {
  assert.equal(coverageFloorHolds(5, 10), true);
  assert.equal(coverageFloorHolds(4.999, 10), false);
  assert.equal(coverageFloorHolds(10, 10), true);
  assert.equal(coverageFloorHolds(0, 0), true);
});

test('revivalRateHolds: equal to the incumbent holds, strictly above it does not', () => {
  assert.equal(revivalRateHolds(0.1, 0.1), true);
  assert.equal(revivalRateHolds(0.09, 0.1), true);
  assert.equal(revivalRateHolds(0.11, 0.1), false);
});

test('isWeightScalarMultiple: a positive scalar multiple of the incumbent is caught, an unequal-key vector is not', () => {
  assert.equal(
    isWeightScalarMultiple(
      { relevance: 1.1, importance: 0.4, recency: 0.3, usage: 0.2 },
      INCUMBENT_WEIGHTS,
    ),
    true,
  );
  assert.equal(
    isWeightScalarMultiple(
      { relevance: 0.9, importance: 0.4, recency: 0.3, usage: 0.2 },
      INCUMBENT_WEIGHTS,
    ),
    false,
  );
});
