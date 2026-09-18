import type { MemoryKind, RecallBox, RecallPolicy } from '../../types.js';
import { isScalarMultiple } from './measure.js';

/**
 * The admission check (dream stage 2, AP5; concept 10.1, E15).
 *
 * `admit` runs BEFORE a candidate is ever handed to `evaluate.ts` (S17). The
 * reason is structural, not procedural: every mechanism in the concept's
 * H1-H9 table is a LEGAL point inside the declared box and inside every
 * other guard the night enforces. Against a legal, degenerate candidate,
 * comparison on the score does not help - its number really can be higher,
 * because the score measures what a ranking looks like, not why it looks
 * that way. So this module trades measurement for predicates: closed-form
 * questions about a candidate's shape and its already-computed statistics,
 * decided without ever touching a score.
 *
 * Four checks, each independently testable:
 *
 * - **Box violation.** A candidate whose parameters fall outside the box the
 *   night recorded frames under is not a legal point to score at all - the
 *   frames it would need to replay against were never fetched. This is a
 *   GENERATION error (the candidate writer produced something it should
 *   structurally never produce, box-clamped or not), not an abstention: an
 *   abstention is a legitimate outcome of measuring a real frame, this is
 *   the absence of anything to measure. It gets its own finding so a caller
 *   never confuses "the candidate lost" with "the candidate writer is
 *   broken" (concept 10.1, AP5 instruction).
 * - **H1 - coverage floor.** "Nothing retrieved, and win": `coreProfile`
 *   answers on `importance >= ? OR pinned = 1`, and raising `threshold`
 *   until the query-matched set is empty leaves only those (heavily
 *   labelled) rows behind. A smaller, cleaner delivery can look better on
 *   nDCG alone while covering far less of what the incumbent actually
 *   surfaces. The rule is relative and asymmetric on purpose: "lose no more
 *   than half the incumbent's coverage", never "reach some absolute floor" -
 *   an absolute floor would need recalibrating every time the incumbent
 *   itself changed.
 * - **H3 - revival rate.** The gate slot's reinforcement branch can un-park a
 *   memory the night just put to sleep (`dormant_at = NULL`); a policy that
 *   revives more than the incumbent is buying hits with a cost the score
 *   never sees. Counted here already, even though only the (not yet built)
 *   `gate` slot can trigger it - a slot with no writer cannot game this way
 *   yet, but the predicate does not know that and should not have to.
 * - **H9 - weight scaling.** Multiplying every weight by the same positive
 *   constant leaves the relative order of every retrieved row unchanged -
 *   it is not a different policy, only the same one wearing a bigger
 *   number - but it lifts every score above `coreProfile`'s fixed literal of
 *   1 and lets more rows cross a threshold that was not rescaled the same
 *   way. `isScalarMultiple` (stage 1, dream/measure.ts) is the exact
 *   predicate; a candidate whose weight vector is a positive scalar multiple
 *   of the incumbent's is rejected outright.
 *
 * What this module deliberately does NOT do: it never computes coverage, a
 * revival rate, or anything about a frame or a trace. Those are measurements
 * that belong to `evaluate.ts` (AP8) and the night (AP12); `admit` only
 * compares numbers it is handed. Keeping the arithmetic out of here is what
 * keeps this a predicate module - a measurement bug in `evaluate.ts` cannot
 * silently defeat the gate that is supposed to run before it.
 */

/**
 * The already-computed numbers `admit` compares against the incumbent. Both
 * sides of each pair are measured the same way, in the same unit; `admit`
 * itself never derives one from the other.
 */
export interface AdmissionStats {
  /**
   * H1: retrieval breadth for this owner/slot - however the caller counts it
   * (distinct memories ever surfaced, distinct labelled positions reached,
   * and so on), as long as `candidate` and `incumbent` use the same count.
   */
  coverage: { candidate: number; incumbent: number };
  /**
   * H3: revivals (`dormant_at`/`superseded_by` cleared by the write gate's
   * reinforcement branch) per closed trace, or any other rate the caller
   * measures consistently across both arms.
   */
  revivalRate: { candidate: number; incumbent: number };
}

/** What `admit` answers: whether the candidate may go on to be scored. */
export interface AdmissionResult {
  ok: boolean;
  /**
   * Every reason admission failed, never just the first one - a candidate
   * that both leaves the box and games H1 should say so on both counts. Box
   * findings are prefixed `box-violation:<field>`; the H1/H3/H9 findings are
   * `h1-coverage-floor`, `h3-revival-rate` and `h9-weight-scalar-multiple`,
   * so a caller can tell a structural generation error from a genuine
   * anti-gaming rejection without parsing prose.
   */
  findings: string[];
}

/** H1's relative floor: lose no more than half the incumbent's coverage. */
const H1_COVERAGE_RATIO = 0.5;

/** The four scoring terms, in the order `RecallBox.w` and `RecallPolicy.w` share. */
const WEIGHT_TERMS = ['relevance', 'importance', 'recency', 'usage'] as const;

function withinInterval(value: number, [lo, hi]: readonly [number, number]): boolean {
  return value >= lo && value <= hi;
}

/** Set equality, order-independent - `kinds` rides as a literal, not a range (concept 3.4). */
function sameKinds(a: readonly MemoryKind[], b: readonly MemoryKind[]): boolean {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((kind) => bSet.has(kind));
}

/**
 * Every way `candidate` falls outside the box the frames it would replay
 * against were recorded under. `kinds` and `minImportance` are SQL filters
 * rather than scoring terms (concept 3.4): widening either admits rows that
 * were never fetched, so they must match the box's literal exactly, not just
 * fall inside an interval. This is a generation error, not a measurement -
 * see the module doc - and is checked and tested independently of H1/H3/H9.
 */
export function boxViolations(candidate: RecallPolicy, box: RecallBox): string[] {
  const findings: string[] = [];

  if (candidate.limit < 0 || candidate.limit > box.limitMax) findings.push('box-violation:limit');
  if (!withinInterval(candidate.threshold, box.threshold)) findings.push('box-violation:threshold');
  if (!withinInterval(candidate.hopEntity, box.hopEntity)) findings.push('box-violation:hopEntity');
  if (!withinInterval(candidate.hopEdge, box.hopEdge)) findings.push('box-violation:hopEdge');
  for (const term of WEIGHT_TERMS) {
    if (!withinInterval(candidate.w[term], box.w[term])) findings.push(`box-violation:w.${term}`);
  }
  if (!sameKinds(candidate.kinds, box.kinds)) findings.push('box-violation:kinds');
  if (candidate.minImportance !== box.minImportance) findings.push('box-violation:minImportance');

  return findings;
}

/**
 * H1 (concept 10.1): "lose no coverage", not "reach X". The floor is
 * relative to the incumbent on purpose - an absolute floor would need
 * recalibrating every time the incumbent itself moved, and would say nothing
 * about a candidate that simply stopped retrieving almost everything.
 */
export function coverageFloorHolds(
  candidateCoverage: number,
  incumbentCoverage: number,
  ratio = H1_COVERAGE_RATIO,
): boolean {
  return candidateCoverage >= ratio * incumbentCoverage;
}

/**
 * H3 (concept 10.1): a revival is an explicit cost the score never sees, so
 * a candidate may not revive more than the incumbent already does. Equal is
 * fine; strictly more is the rejection.
 */
export function revivalRateHolds(candidateRate: number, incumbentRate: number): boolean {
  return candidateRate <= incumbentRate;
}

/**
 * H9 (concept 10.1): a weight vector that is a positive scalar multiple of
 * the incumbent's changes nothing about the ranking it produces and is
 * rejected outright, via stage 1's `isScalarMultiple`.
 */
export function isWeightScalarMultiple(
  candidateWeights: RecallPolicy['w'],
  incumbentWeights: RecallPolicy['w'],
): boolean {
  // `RecallWeights` carries no index signature of its own, so the widening
  // goes through `unknown`; it is safe because every one of its properties is
  // already a `number`.
  return isScalarMultiple(
    candidateWeights as unknown as Record<string, number>,
    incumbentWeights as unknown as Record<string, number>,
  );
}

/**
 * The admission check: every predicate above, combined. Runs before a
 * candidate is ever scored (S17) - see the module doc for why comparison
 * alone cannot do this job. `findings` is empty exactly when `ok` is `true`.
 */
export function admit(
  candidate: RecallPolicy,
  incumbent: RecallPolicy,
  box: RecallBox,
  stats: AdmissionStats,
): AdmissionResult {
  const findings: string[] = [...boxViolations(candidate, box)];

  if (!coverageFloorHolds(stats.coverage.candidate, stats.coverage.incumbent)) {
    findings.push('h1-coverage-floor');
  }
  if (!revivalRateHolds(stats.revivalRate.candidate, stats.revivalRate.incumbent)) {
    findings.push('h3-revival-rate');
  }
  if (isWeightScalarMultiple(candidate.w, incumbent.w)) {
    findings.push('h9-weight-scalar-multiple');
  }

  return { ok: findings.length === 0, findings };
}
