import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '../../config.js';
import type {
  AbstainReason,
  DreamEval,
  DreamFrame,
  DreamLabel,
  DreamLabelSource,
  DreamSlot,
  DreamTrace,
  FrameCorpus,
  RecallFrame,
  RookeryConfig,
} from '../../types.js';
import type { Store } from '../store.js';
import {
  REVIEW_TARGET,
  cohensKappa,
  costOnlyShare,
  gainFrom,
  labelCoverage,
  pairedRatings,
  pairwiseAgreement,
} from './label.js';
import { measure, type DeltaPosition, type GainFunction } from './measure.js';
import { bootstrapCi, freshnessCheck, precheckReason, signsAgree, type PrecheckContext } from './probe.js';
import { pipelineAgent, pipelineAssistant, type FrameScoringPolicy, type PipelineResult } from './score.js';
import {
  ABSTAIN_REASONS,
  NO_GAIN,
  clampNumber,
  emptyReasons,
  expectedBudgetChars,
  frameDeadline,
  mean,
} from './util.js';

/**
 * The evaluation machinery (dream stage 2, AP8; concept 5.3, 5.4, 5.5, 4.4).
 *
 * This module answers one question and refuses to answer a second one: given
 * a recorded pool of frames, a baseline arm and a candidate arm, how much
 * better did the candidate rank the block the model actually read - and is
 * that number worth anything at all? The first half is `evaluateCandidate`,
 * the second half is the validity certificate it carries with it. Whether
 * the candidate is then PROMOTED is not decided here; that is AP9's gate,
 * and keeping the two apart is what makes "the evaluation is invalid"
 * distinguishable from "the candidate lost" (concept 5.4, rule 3).
 *
 * Three contracts hold everywhere in this file:
 *
 * - **It never writes.** It reads frames, traces and labels through the
 *   store's read paths and nothing else. `fetchFrame` (through
 *   `freshnessCheck`) has no touch path at all and `measure` is pure, so
 *   `touch: false` is not a flag anyone could flip - it is the absence of a
 *   write path (S30). The test that pins this compares `access_count` and
 *   `usefulness` of every row before and after a full evaluation, because a
 *   sensor that feeds the feedback loop it watches is worse than no sensor.
 *   The night's corpus fingerprint is a meta WRITE (`store.corpusFingerprint`)
 *   and is therefore never called here: the caller hands its stamp in.
 * - **It never throws.** The night has no throw site in the dream block; an
 *   internal failure is reported into the result and the night carries on.
 * - **It reads no further than the owner it was given.** A frame of another
 *   bank that reached the pool through a join is dropped and counted, never
 *   scored (concept 10.5).
 *
 * The four pieces, in the order the night uses them:
 *
 *   1. `splitOf` - the train/holdout/audit split, deterministic, SESSION-wise
 *      and free of any store, because AP14's recorder stamps a trace with the
 *      very same function (E3).
 *   2. `evaluateCandidate` - paired per trace on the INTERSECTION of both
 *      closed sets, cluster-bootstrapped over sessions, with the abstention
 *      histogram, the coverage rates and the five validity rules.
 *   3. `selectOnTraining` - the ranking runs on the training half; exactly
 *      one candidate goes on to the holdout (E4/S12), and the frozen audit
 *      set is touched exactly once per promotion (S13).
 *   4. `agreementReport` - the label agreement sensor (5.5b), with `user`
 *      privileged. Thin `user` labels are the finding, not a zero.
 *
 * > Der Schaetzer ist eine untere Schranke, kein Punktschaetzer (E8). Jede
 * > Bewertung berichtet ihre Abdeckungsrate, und ein Delta, das ueberwiegend
 * > aus unetikettierten Positionen stammt, ist ungueltig.
 */

/* ------------------------------- constants ------------------------------- */

/**
 * Salt for the split draw. Deliberately NOT the recorder's sampling salt
 * (`runtime.ts`): the sample decides whether a session is framed at all, the
 * split decides which half it lands in, and one hash serving both would make
 * every framed session fall on the same side of the split.
 */
const SPLIT_SALT = 'rookery.dream.split.v1';

/**
 * Split rates. Guessed, like every other bare number in the concept: three
 * in ten sessions held back for the one holdout check, one in ten frozen
 * into the audit set that never selects and never serves as a holdout
 * (concept 5.5d). They are parameters everywhere they are used.
 */
const DEFAULT_HOLDOUT_RATE = 0.3;
const DEFAULT_AUDIT_RATE = 0.1;

/**
 * The one place those two rates live. The recorder stamps a trace with
 * `splitOf` at turn time and the night reads the stamp back months later: if
 * the two sides ever picked their rates separately, a session could change
 * sides between the stamp and the evaluation, and the holdout would quietly
 * stop being one.
 */
export const DEFAULT_SPLIT_RATES: SplitRates = {
  holdoutRate: DEFAULT_HOLDOUT_RATE,
  auditRate: DEFAULT_AUDIT_RATE,
};

/** SQLite takes at most 999 bound parameters; labels are read in batches. */
const TURN_BATCH = 200;

/** Decimals the evidence digest prints a delta with, and a share with. */
const DIGEST_DIGITS = 4;
const SHARE_DIGITS = 3;

/** How many abstention reasons the evidence digest names. */
const WORST_REASONS_SHOWN = 3;

const LABEL_SOURCES: readonly DreamLabelSource[] = ['correction', 'review', 'merge', 'user'];

/**
 * The sources the retrieval policy has a causal path to: a correction is
 * written about what the incumbent surfaced, a merge about what the night
 * condensed, a review about an assignment the same policy fed. `user` is the
 * one source outside that loop, which is why it is privileged (concept 4.2b).
 */
const INFLUENCEABLE: readonly DreamLabelSource[] = ['correction', 'merge', 'review'];

/** How many common targets `user` needs before an agreement means anything. */
const MIN_USER_PAIRS = 10;

/* ------------------------------ the split ------------------------------- */

/** Which half of the evidence a session belongs to (concept 5.3, 5.5d). */
export type DreamSplit = 'train' | 'holdout' | 'audit';

/** The two rates that carve the split; the rest is training. */
export interface SplitRates {
  holdoutRate: number;
  auditRate: number;
}

/**
 * The split draw of one session as a number in [0, 1): FNV-1a over the
 * session id and the split salt. Cheap, stable and portable - it only has to
 * be deterministic, never cryptographic, and it must survive a restart,
 * because a session that changed sides between two nights would put
 * near-duplicate turns on both sides of every comparison.
 */
function splitDraw(sessionId: string): number {
  let hash = 0x811c9dc5;
  const input = sessionId + SPLIT_SALT;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Which half a session falls in (E3). The unit is the SESSION, never the
 * trace: consecutive turns of one session share topic, bank cutout and
 * entity neighbourhood, so a per-trace split would lay near-duplicates on
 * both sides and let `ci_low > 0` fire on leakage rather than on an effect.
 *
 * AP14's recorder stamps `dream_traces.holdout` and `.audit` with this same
 * function, which is why it takes no store and reads no config: the recorder
 * calls it inside a turn, the night calls it over a pool, and both must get
 * the same answer for the same session id.
 *
 * The two bands sit at opposite ends of the unit interval on purpose. The
 * audit set is the FROZEN one (concept 5.5d) - it takes the top band, so
 * raising or lowering the holdout rate never moves a session in or out of
 * it. A session without an id of its own (a trace outside any conversation)
 * is its own cluster; the caller passes `trace.sessionId ?? trace.id` and
 * gets a stable answer either way.
 */
export function splitOf(sessionId: string, rates: SplitRates): DreamSplit {
  const audit = clampNumber(rates.auditRate, 0, 1);
  const holdout = clampNumber(rates.holdoutRate, 0, 1);
  const draw = splitDraw(sessionId);
  // Audit first: where the two bands would overlap, the frozen set wins -
  // it is the floor the other two stand on, not a leftover.
  if (audit > 0 && draw >= 1 - audit) return 'audit';
  if (holdout > 0 && draw < holdout) return 'holdout';
  return 'train';
}

/** One recorded frame with its trace, exactly as `store.framesFor` hands it over. */
export interface FrameEntry {
  trace: DreamTrace;
  frame: DreamFrame;
}

/** The three halves of a pool, split session-wise. */
export interface SplitPool {
  train: FrameEntry[];
  holdout: FrameEntry[];
  audit: FrameEntry[];
}

/**
 * Split a recorded pool by session. A trace that was STAMPED at record time
 * keeps its stamp - `dream_traces.holdout`/`.audit` are what the turn
 * decided, and re-deriving them from today's rates would silently move
 * yesterday's evidence. Only an unstamped trace (every trace recorded before
 * AP14 wires the stamp) is drawn here, with the same function.
 */
export function splitPool(entries: readonly FrameEntry[], rates: SplitRates): SplitPool {
  const pool: SplitPool = { train: [], holdout: [], audit: [] };
  for (const entry of entries) {
    const where = entry.trace.audit
      ? 'audit'
      : entry.trace.holdout
        ? 'holdout'
        : splitOf(entry.trace.sessionId ?? entry.trace.id, rates);
    pool[where].push(entry);
  }
  return pool;
}

/* --------------------------- the validity rules --------------------------- */

/** The thresholds concept 5.4 reads out of `dream`, clamped on read (S23). */
export interface ValidityLimits {
  minTraces: number;
  abstainEps: number;
  abstainFloor: number;
  reachableFloor: number;
  coverageFloor: number;
  costOnlyCeiling: number;
}

/** The counts validity rule 1 is decided on. */
export interface PairedCounts {
  /** Traces the baseline arm closed. */
  closedBaseline: number;
  /** Traces the candidate arm closed. */
  closedCandidate: number;
  /** Traces that went into the paired mean. */
  closed: number;
  /** Deltas that were actually formed - one per closed trace, never more. */
  paired: number;
}

/**
 * Validity rule 1 (concept 5.4): baseline and candidate are scored on the
 * INTERSECTION, never each arm on its own set. A candidate that abstained on
 * the hard third of the pool and was averaged over the easy two thirds would
 * win against a baseline that answered everywhere, and the number would not
 * be wrong - it would be about a different set.
 *
 * The predicate is deliberately a check on the counts rather than a comment
 * on the loop that produced them: it is the one rule that can only be broken
 * by a mistake inside this file, and the test that pins it must be able to
 * state that mistake in numbers.
 */
export function pairedOnIntersection(counts: PairedCounts): boolean {
  return (
    counts.paired === counts.closed &&
    counts.closed <= Math.min(counts.closedBaseline, counts.closedCandidate)
  );
}

/**
 * Validity rule 2 (concept 5.4): the candidate may abstain at most
 * `abstainEps` more often than the baseline, and BOTH arms must stay under
 * `abstainFloor`. A candidate that wins because it was only ever tested
 * where it felt comfortable is rejected - the delta it reports is real, and
 * it is about the frames it did not run away from.
 */
export function abstainRuleHolds(
  candidateRate: number,
  baselineRate: number,
  limits: Pick<ValidityLimits, 'abstainEps' | 'abstainFloor'>,
): boolean {
  if (candidateRate > baselineRate + limits.abstainEps) return false;
  return candidateRate < limits.abstainFloor && baselineRate < limits.abstainFloor;
}

/**
 * Validity rule 3 (concept 5.4): below `minTraces` closed traces the
 * evaluation is INVALID, not "the candidate lost". The distinction is the
 * whole point of the rule - a thin night must not be readable as evidence
 * against a candidate, or the ratchet turns on noise.
 */
export function traceFloorHolds(closed: number, minTraces: number): boolean {
  return closed >= minTraces;
}

/**
 * Validity rule 4 (concept 5.4): a mean `reachable_rate` under
 * `reachableFloor` means most labelled targets are unreachable for EVERY
 * candidate alike (superseded, forgotten, dormant, archived). The ideal is
 * then built from what is left, and the ratio says more about the bank's
 * condensation than about any policy.
 */
export function reachableFloorHolds(reachableRate: number, floor: number): boolean {
  return reachableRate >= floor;
}

/**
 * Validity rule 5 (concept 4.4, S10): `label_coverage` over the floor and
 * `cost_only_share` under the ceiling. Below the coverage floor an
 * evaluation cannot tell a real delta from missing labels; above the
 * cost-only ceiling the delta is predominantly block length, and a delta
 * drawn from unlabelled positions is not a delta.
 */
export function coverageRuleHolds(
  coverage: number,
  costOnly: number,
  limits: Pick<ValidityLimits, 'coverageFloor' | 'costOnlyCeiling'>,
): boolean {
  return coverage >= limits.coverageFloor && costOnly <= limits.costOnlyCeiling;
}

/* --------------------------- what an evaluation is --------------------------- */

/** The freshness sensor's verdict over a pool (concept 5.5a). */
export interface FreshnessSummary {
  /** Frames the sensor re-fetched. */
  frames: number;
  /** Frames where the frozen AND the live world both closed both arms. */
  closedBoth: number;
  deltaFrozen: number | null;
  deltaLive: number | null;
  /** `true` = same sign, `false` = flipped, `null` = undetermined. */
  signAgree: boolean | null;
  /** Share of re-fetched frames whose rows moved; the sensor's own strength. */
  rowsDifferShare: number;
}

/**
 * One finished evaluation - everything a `dream_evals` row needs, plus the
 * certificate that says what the row is worth. AP9 adds `policyId`,
 * `sleepRunId` and `promoted`; the structural assertion at the bottom of
 * this file is what keeps that promise honest across a column rename.
 */
export interface DreamEvalResult {
  slot: DreamSlot;
  /** Offered: frames of this owner the evaluation was handed. */
  traces: number;
  /** Closed and scored, after the intersection and the cost-only exclusion. */
  closed: number;
  abstained: number;
  abstainReasons: Record<AbstainReason, number>;
  reachableRate: number;
  labelCoverage: number;
  costOnlyShare: number;
  /** Mean candidate score over the closed traces. */
  score: number;
  /** Mean baseline score over the same traces. */
  baseline: number;
  delta: number;
  /** Cluster bootstrap over SESSIONS, B = 2000, percentile 2.5/97.5 - approximate (S11). */
  ciLow: number;
  ciHigh: number;
  auditDelta?: number;
  auditCiLow?: number;
  deltaLive?: number;
  signAgree: boolean | null;
  evalMs: number;
  /** sha256 over the sorted trace ids this evaluation closed over. */
  traceSetHash: string;
  /** Condensed reasoning, numbers and vocabulary only - never verbatim text (E19). */
  evidenceDigest?: string;
  detail?: DreamEvalDetail;
  /** False when any of the five rules of concept 5.4 failed. */
  valid: boolean;
  /** Which of them failed, one name each. Empty exactly when `valid`. */
  violations: string[];
  /** Distinct sessions behind the closed traces - the bootstrap's clusters. */
  sessions: number;
  closedBaseline: number;
  closedCandidate: number;
  abstainRateBaseline: number;
  abstainRateCandidate: number;
  freshness: FreshnessSummary | null;
  /** Set when something inside threw; the evaluation reports instead of breaking. */
  error: string | null;
}

/** `dream_evals.detail`: score per label source, plus the counters (concept 8.6). */
export interface DreamEvalDetail {
  /** Paired delta computed from each label source alone (concept 5.5b). */
  deltaBySource: Partial<Record<DreamLabelSource, number>>;
  /** Labels per source behind this pool. */
  labelsBySource: Partial<Record<DreamLabelSource, number>>;
  /** Targets two sources disagreed about; counted, never silently resolved (S2). */
  conflicts: number;
  /** Frames of another bank that reached the pool through a join (concept 10.5). */
  foreignOwner: number;
  /** Traces both arms closed, before the cost-only exclusion. */
  intersection: number;
  /** Traces excluded as `no-labelled-move` (concept 4.4). */
  costOnly: number;
  /** Frames the per-frame sub-cap cut short. */
  frameTimeouts: number;
  /** Whether the wall clock ended the evaluation early. */
  deadlineHit: boolean;
  [key: string]: unknown;
}

/** What one candidate evaluation needs. */
export interface EvaluateInput {
  owner: string;
  slot: DreamSlot;
  config: RookeryConfig;
  /** The pool this evaluation runs over - one split, never the whole thing. */
  entries: readonly FrameEntry[];
  /** The arm the candidate is measured against; usually the incumbent. */
  baseline: FrameScoringPolicy;
  candidate: FrameScoringPolicy;
  /**
   * The night's corpus fingerprint, when the caller has one. Omitted, the
   * drift pre-check is waived rather than guessed: computing a fingerprint
   * WRITES a meta row, and this module never writes.
   */
  corpus?: FrameCorpus | null;
  /** Run the freshness sensor (concept 5.5a). Default: on. */
  freshness?: boolean;
  /** Compute the per-source deltas the agreement check reads. Default: on. */
  sourceDeltas?: boolean;
  /** Wall-clock deadline in epoch ms. */
  deadline?: number;
  signal?: AbortSignal;
}

/* ------------------------------- internals ------------------------------- */

/** What one scoring pass needs besides the entries and the gain: both arms and the clocks. */
interface ScoringPass {
  config: RookeryConfig;
  baseline: FrameScoringPolicy;
  candidate: FrameScoringPolicy;
  costWeight: number;
  deadline?: number;
  signal?: AbortSignal;
}

/** The caller aborted or the shared wall clock ran out: stop starting new work. */
function mustStop(pass: Pick<ScoringPass, 'deadline' | 'signal'>): boolean {
  return pass.signal?.aborted === true || (pass.deadline !== undefined && Date.now() > pass.deadline);
}

/** The chain the frame belongs to - never the other one (R15). */
function replay(frame: RecallFrame, policy: FrameScoringPolicy): PipelineResult {
  return frame.pipeline === 'agent' ? pipelineAgent(frame, policy) : pipelineAssistant(frame, policy);
}

/** Labels grouped by their source; the keys come in first-seen order. */
function groupBySource(labels: readonly DreamLabel[]): Map<DreamLabelSource, DreamLabel[]> {
  const bySource = new Map<DreamLabelSource, DreamLabel[]>();
  for (const label of labels) {
    const bucket = bySource.get(label.source);
    if (bucket) bucket.push(label);
    else bySource.set(label.source, [label]);
  }
  return bySource;
}

function countBySource(labels: readonly DreamLabel[]): Partial<Record<DreamLabelSource, number>> {
  const counts: Partial<Record<DreamLabelSource, number>> = {};
  for (const [source, bucket] of groupBySource(labels)) counts[source] = bucket.length;
  return counts;
}

/** What the pre-checks left of the offered pool. */
interface PoolScreening {
  eligible: FrameEntry[];
  /** Abstentions the pre-checks counted, per reason. */
  reasons: Record<AbstainReason, number>;
  /** Frames of another bank that reached the pool through a join (concept 10.5). */
  foreignOwner: number;
}

/**
 * The owner filter comes first and is not an abstention: a frame of another
 * bank is not a frame this evaluation may read at all. The pre-checks then
 * fire in the order `precheckReason` fixes.
 */
function screenPool(store: Store, input: EvaluateInput, context: PrecheckContext): PoolScreening {
  const screening: PoolScreening = { eligible: [], reasons: emptyReasons(), foreignOwner: 0 };
  for (const entry of input.entries) {
    if (entry.frame.owner !== input.owner || entry.trace.owner !== input.owner) {
      screening.foreignOwner += 1;
      continue;
    }
    const reason = precheckReason(store, entry, context);
    if (reason) screening.reasons[reason] += 1;
    else screening.eligible.push(entry);
  }
  return screening;
}

/**
 * Read the labels of a pool's turns and sessions in batches, so a pool of
 * five hundred frames cannot walk into SQLite's bound-parameter limit. Both
 * scopes are read: a session-wide label never yields a gain (S3), but it is
 * part of the labelled universe `label_coverage` is measured against and it
 * takes part in the agreement check.
 */
function labelsOfPool(store: Store, owner: string, entries: readonly FrameEntry[]): DreamLabel[] {
  const turnIds = [...new Set(entries.map((entry) => entry.trace.turnId))];
  const sessionIds = [
    ...new Set(entries.map((entry) => entry.trace.sessionId).filter((id): id is string => !!id)),
  ];
  const labels = [
    ...readInBatches(turnIds, (batch) => store.labelsForTurns(batch, owner)),
    ...readInBatches(sessionIds, (batch) => store.labelsForSessions(batch, owner)),
  ];
  // `labelsForSessions` selects on `turn_id`, so a session id that is also a
  // turn id would come back twice; the key is what makes a label one label.
  const seen = new Set<string>();
  return labels.filter((label) => {
    const key = label.turnId + ' ' + label.target + ' ' + label.source;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readInBatches(ids: readonly string[], read: (batch: string[]) => DreamLabel[]): DreamLabel[] {
  const labels: DreamLabel[] = [];
  for (let from = 0; from < ids.length; from += TURN_BATCH) {
    labels.push(...read(ids.slice(from, from + TURN_BATCH)));
  }
  return labels;
}

/** One gain function per turn, plus the contradictions folding them found. */
interface GainIndex {
  gainFor: (turnId: string) => GainFunction;
  /** Every target the window knows a label for - the universe of 4.4. */
  universe: ReadonlySet<string>;
  conflicts: number;
}

/**
 * Fold a pool's labels into one gain function per turn (concept 4.1). The
 * labelled universe is every target any label of the window names, both
 * scopes included and the `review` sentinel excluded - that universe is what
 * `label_coverage` asks about ("could a label exist for this position at
 * all"), which is a question about the window, not about this turn.
 */
function indexLabels(labels: readonly DreamLabel[]): GainIndex {
  const byTurn = new Map<string, DreamLabel[]>();
  const universe = new Set<string>();
  for (const label of labels) {
    if (label.target !== REVIEW_TARGET) universe.add(label.target);
    const bucket = byTurn.get(label.turnId);
    if (bucket) bucket.push(label);
    else byTurn.set(label.turnId, [label]);
  }
  const gains = new Map<string, GainFunction>();
  let conflicts = 0;
  for (const [turnId, bucket] of byTurn) {
    const folded = gainFrom(bucket);
    conflicts += folded.conflicts;
    gains.set(turnId, folded.gain);
  }
  return { gainFor: (turnId: string) => gains.get(turnId) ?? NO_GAIN, universe, conflicts };
}

/** What one paired pass over a pool produced, at one gain. */
interface PairedRun {
  closedBaseline: number;
  closedCandidate: number;
  /** Traces both arms closed - before the cost-only exclusion. */
  intersection: number;
  costOnly: number;
  /** Traces that went into the paired mean. */
  closed: number;
  scoreCandidate: number | null;
  scoreBaseline: number | null;
  delta: number | null;
  clusters: number[][];
  sessions: number;
  reachableRate: number | null;
  labelCoverage: number;
  costOnlyShare: number;
  traceIds: string[];
  /** The intersection entries, for the freshness sensor to re-fetch. */
  pairedEntries: FrameEntry[];
  reasons: Record<AbstainReason, number>;
  frameTimeouts: number;
  deadlineHit: boolean;
}

/**
 * The paired pass (concept 5.3): score both arms over every eligible frame,
 * keep only the traces where BOTH closed, and form one delta per kept trace.
 *
 * Two things happen here that are easy to get subtly wrong, and both have
 * their own test. The intersection is formed before any mean is taken, never
 * after - each arm averaged over its own set is the mistake rule 1 names.
 * And a trace whose two arms moved no labelled position at all abstains as
 * `no-labelled-move` (concept 4.4): its delta could only ever come from the
 * cost term, and a block that is shorter by four characters is not a better
 * ranking. Those traces leave the mean and stay in `cost_only_share`.
 */
function pairedRun(
  entries: readonly FrameEntry[],
  index: GainIndex,
  pass: ScoringPass,
): PairedRun {
  const reasons = emptyReasons();
  const clusters = new Map<string, number[]>();
  const positions: string[] = [];
  const deltaPositions: DeltaPosition[][] = [];
  const candidateScores: number[] = [];
  const baselineScores: number[] = [];
  const reachable: number[] = [];
  const traceIds: string[] = [];
  const pairedEntries: FrameEntry[] = [];
  let closedBaseline = 0;
  let closedCandidate = 0;
  let intersection = 0;
  let costOnly = 0;
  let frameTimeouts = 0;
  let deadlineHit = false;

  for (const entry of entries) {
    if (pass.signal?.aborted) break;
    const now = Date.now();
    if (pass.deadline !== undefined && now > pass.deadline) {
      deadlineHit = true;
      break;
    }
    const cutoff = frameDeadline(now, pass.deadline);

    const payload = entry.frame.payload;
    const gain = index.gainFor(entry.trace.turnId);
    const baseResult = measure(payload, pass.baseline, gain, pass.costWeight);
    const candResult = measure(payload, pass.candidate, gain, pass.costWeight);
    if (!baseResult.ok) reasons[baseResult.abstain] += 1;
    else closedBaseline += 1;
    if (!candResult.ok) reasons[candResult.abstain] += 1;
    else closedCandidate += 1;
    if (!baseResult.ok || !candResult.ok) continue;

    intersection += 1;
    reachable.push(candResult.reachableRate);

    // A frame past its sub-cap leaves the paired set rather than eating the
    // shared wall clock; it still counted towards both arms' closures.
    if (Date.now() > cutoff) {
      frameTimeouts += 1;
      continue;
    }

    // What the model read on each arm. `measure` returns the number, not the
    // list, so the rendered lines are replayed once more here - the price of
    // keeping `measure` a pure score with no by-products to keep in step.
    const baseIds = renderedIds(payload, pass.baseline);
    const candIds = renderedIds(payload, pass.candidate);
    if (!baseIds || !candIds) continue;
    for (const id of new Set([...baseIds, ...candIds])) positions.push(id);

    const moved = movedPositions(baseIds, candIds, index.universe);
    deltaPositions.push(moved);

    if (!moved.some((position) => position.labelPossible)) {
      costOnly += 1;
      reasons['no-labelled-move'] += 1;
      continue;
    }

    const cluster = entry.trace.sessionId ?? entry.trace.id;
    const bucket = clusters.get(cluster);
    const delta = candResult.score - baseResult.score;
    if (bucket) bucket.push(delta);
    else clusters.set(cluster, [delta]);
    candidateScores.push(candResult.score);
    baselineScores.push(baseResult.score);
    traceIds.push(entry.trace.id);
    pairedEntries.push(entry);
  }

  const scoreCandidate = mean(candidateScores);
  const scoreBaseline = mean(baselineScores);
  return {
    closedBaseline,
    closedCandidate,
    intersection,
    costOnly,
    closed: traceIds.length,
    scoreCandidate,
    scoreBaseline,
    delta:
      scoreCandidate !== null && scoreBaseline !== null ? scoreCandidate - scoreBaseline : null,
    clusters: [...clusters.values()],
    sessions: clusters.size,
    reachableRate: mean(reachable),
    labelCoverage: labelCoverage(positions, index.universe),
    costOnlyShare: costOnlyShare(deltaPositions),
    traceIds,
    pairedEntries,
    reasons,
    frameTimeouts,
    deadlineHit,
  };
}

/** The ids of the memories one arm rendered for a frame; `null` when the replay did not close. */
function renderedIds(frame: RecallFrame, policy: FrameScoringPolicy): Set<string> | null {
  const replayed = replay(frame, policy);
  return replayed.ok ? new Set(replayed.lines.map((memory) => memory.id)) : null;
}

/** The positions exactly one of the two arms rendered, each marked with whether a label could exist for it. */
function movedPositions(
  baseIds: ReadonlySet<string>,
  candIds: ReadonlySet<string>,
  universe: ReadonlySet<string>,
): DeltaPosition[] {
  const moved: DeltaPosition[] = [];
  for (const id of baseIds) {
    if (!candIds.has(id)) moved.push({ id, labelPossible: universe.has(id) });
  }
  for (const id of candIds) {
    if (!baseIds.has(id)) moved.push({ id, labelPossible: universe.has(id) });
  }
  return moved;
}

/** sha256 over the sorted trace ids - order in, one hash out (concept 5.3). */
export function traceSetHash(traceIds: readonly string[]): string {
  return createHash('sha256').update([...traceIds].sort().join('\n')).digest('hex');
}

/* -------------------------- the evidence digest -------------------------- */

function signed(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'na';
  return (value >= 0 ? '+' : '') + value.toFixed(DIGEST_DIGITS);
}

function share(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(SHARE_DIGITS);
}

/**
 * The condensed justification stored on the evaluation (E19,
 * `dream_evals.evidence_digest`).
 *
 * Retention is what makes this a type of its own rather than a sentence:
 * frames die after `frameRetainDays` and evaluations live for
 * `retainDays`, so a justification that quoted the frames would either
 * outlive the memories it quoted - which S21 forbids - or vanish before the
 * calibration that needs it. So the digest carries NUMBERS and the closed
 * vocabulary of this file (abstention reasons, label sources, rule names)
 * and no verbatim text at all. The test asserts exactly that, over frames
 * whose contents are distinctive words.
 */
export function renderEvidenceDigest(result: DreamEvalResult): string {
  const worst = worstAbstainReasons(result);
  const sources = deltaBySourceSummary(result.detail);

  const parts = [
    'slot=' + result.slot,
    'n=' + result.traces,
    'closed=' + result.closed,
    'sess=' + result.sessions,
    'abst=' + share(result.abstainRateBaseline) + '/' + share(result.abstainRateCandidate),
    'reach=' + share(result.reachableRate),
    'cov=' + share(result.labelCoverage),
    'cost=' + share(result.costOnlyShare),
    'd=' + signed(result.delta),
    'ci=[' + signed(result.ciLow) + ',' + signed(result.ciHigh) + ']',
    'live=' + signed(result.deltaLive),
    'sign=' + (result.signAgree === null ? 'na' : result.signAgree ? '1' : '0'),
    'audit=' + signed(result.auditDelta) + '/' + signed(result.auditCiLow),
    'valid=' + (result.valid ? '1' : '0'),
    'hash=' + result.traceSetHash.slice(0, 12),
  ];
  if (sources) parts.push('src=' + sources);
  if (worst) parts.push('abstain=' + worst);
  if (result.violations.length) parts.push('violations=' + result.violations.join(','));
  // The estimator is a lower bound, and that stands next to the number
  // rather than in a footnote (E8); `ci` is a percentile interval of a
  // cluster bootstrap and approximate, never exact (S11/E6).
  parts.push('bound=lower', 'ci-kind=approximate');
  return parts.join(' ');
}

/** The three most frequent abstention reasons, `reason:count`, most frequent first. */
function worstAbstainReasons(result: DreamEvalResult): string {
  return ABSTAIN_REASONS.filter((reason) => (result.abstainReasons[reason] ?? 0) > 0)
    .sort((a, b) => (result.abstainReasons[b] ?? 0) - (result.abstainReasons[a] ?? 0))
    .slice(0, WORST_REASONS_SHOWN)
    .map((reason) => reason + ':' + result.abstainReasons[reason])
    .join(',');
}

/** `source:delta` for every source whose delta was measured, in `LABEL_SOURCES` order. */
function deltaBySourceSummary(detail: DreamEvalDetail | undefined): string {
  return LABEL_SOURCES.filter((source) => detail?.deltaBySource[source] !== undefined)
    .map((source) => source + ':' + signed(detail?.deltaBySource[source]))
    .join('|');
}

/* --------------------------- the freshness sensor --------------------------- */

/**
 * The frame-ageing sensor over a pool (concept 5.5a), through probe.ts's
 * `freshnessCheck`.
 *
 * `freshnessCheck` takes ONE gain function, and a gain is a statement about
 * one turn - so the pool is walked entry by entry, each with its own turn's
 * gain, and the per-frame deltas are averaged here. That is the only honest
 * way to hand a per-turn label set to a per-pool sensor; folding every
 * turn's labels into one function would let a memory proven relevant in one
 * turn score in every other.
 *
 * `touch: false` needs no flag: the live re-fetch goes through `fetchFrame`,
 * which has no touch path at all (S30). The sensor is a comparator, never a
 * measurement - the live world is knowingly polluted, and a sign FLIP is the
 * only thing read out of it.
 */
function runFreshness(
  store: Store,
  entries: readonly FrameEntry[],
  index: GainIndex,
  pass: ScoringPass,
): FreshnessSummary {
  const summary: FreshnessSummary = {
    frames: 0,
    closedBoth: 0,
    deltaFrozen: null,
    deltaLive: null,
    signAgree: null,
    rowsDifferShare: 0,
  };
  const frozen: number[] = [];
  const live: number[] = [];
  let compared = 0;
  let differ = 0;

  for (const entry of entries) {
    if (mustStop(pass)) break;
    const report = freshnessCheck(store, [entry], {
      config: pass.config,
      baseline: pass.baseline,
      candidate: pass.candidate,
      gain: index.gainFor(entry.trace.turnId),
      costWeight: pass.costWeight,
      deadline: pass.deadline,
      signal: pass.signal,
    });
    summary.frames += 1;
    const one = report.entries[0];
    if (!one) continue;
    if (one.fresh) {
      compared += 1;
      if (one.rowsDiffer) differ += 1;
    }
    if (one.frozenDelta !== null && one.liveDelta !== null) {
      summary.closedBoth += 1;
      frozen.push(one.frozenDelta);
      live.push(one.liveDelta);
    }
  }

  summary.deltaFrozen = mean(frozen);
  summary.deltaLive = mean(live);
  summary.rowsDifferShare = compared ? differ / compared : 0;
  if (summary.deltaFrozen !== null && summary.deltaLive !== null) {
    const margin = clampNumber(pass.config.memory.dream.margin, 0, 1);
    summary.signAgree = signsAgree(summary.deltaFrozen, summary.deltaLive, margin);
  }
  return summary;
}

/* --------------------------- evaluateCandidate --------------------------- */

function emptyResult(slot: DreamSlot): DreamEvalResult {
  return {
    slot,
    traces: 0,
    closed: 0,
    abstained: 0,
    abstainReasons: emptyReasons(),
    reachableRate: 0,
    labelCoverage: 0,
    costOnlyShare: 0,
    score: 0,
    baseline: 0,
    delta: 0,
    ciLow: 0,
    ciHigh: 0,
    signAgree: null,
    evalMs: 0,
    traceSetHash: traceSetHash([]),
    valid: false,
    violations: [],
    sessions: 0,
    closedBaseline: 0,
    closedCandidate: 0,
    abstainRateBaseline: 0,
    abstainRateCandidate: 0,
    freshness: null,
    error: null,
  };
}

/** The numbers of one paired pass, as the finished result carries them. */
function measuredFields(
  run: PairedRun,
  preReasons: Record<AbstainReason, number>,
  traces: number,
): Pick<
  DreamEvalResult,
  | 'abstainReasons'
  | 'closed'
  | 'closedBaseline'
  | 'closedCandidate'
  | 'abstained'
  | 'abstainRateBaseline'
  | 'abstainRateCandidate'
  | 'reachableRate'
  | 'labelCoverage'
  | 'costOnlyShare'
  | 'score'
  | 'baseline'
  | 'delta'
  | 'sessions'
  | 'traceSetHash'
  | 'ciLow'
  | 'ciHigh'
> {
  const abstainReasons = emptyReasons();
  for (const reason of ABSTAIN_REASONS) {
    abstainReasons[reason] = preReasons[reason] + run.reasons[reason];
  }
  // The interval: B = 2000 draws of SESSIONS with replacement, percentile
  // 2.5/97.5, and it is reported as approximate - at the ten to twenty-five
  // clusters this pool produces, the coverage of a percentile interval on a
  // skewed paired mean sits noticeably under its nominal value (S11).
  const interval = bootstrapCi(run.clusters);
  const abstainRate = (closed: number): number => (traces ? (traces - closed) / traces : 0);
  return {
    abstainReasons,
    closed: run.closed,
    closedBaseline: run.closedBaseline,
    closedCandidate: run.closedCandidate,
    abstained: Math.max(0, traces - run.closed),
    abstainRateBaseline: abstainRate(run.closedBaseline),
    abstainRateCandidate: abstainRate(run.closedCandidate),
    reachableRate: run.reachableRate ?? 0,
    labelCoverage: run.labelCoverage,
    costOnlyShare: run.costOnlyShare,
    score: run.scoreCandidate ?? 0,
    baseline: run.scoreBaseline ?? 0,
    delta: run.delta ?? 0,
    sessions: run.sessions,
    traceSetHash: traceSetHash(run.traceIds),
    ciLow: interval?.low ?? 0,
    ciHigh: interval?.high ?? 0,
  };
}

/**
 * Per-source deltas (concept 5.5b): the same paired pass, with each source
 * alone supplying the gain. One source in the pool means the combined gain
 * already IS that source's, and the second pass is skipped rather than paid
 * for.
 */
function deltasBySource(
  eligible: readonly FrameEntry[],
  labels: readonly DreamLabel[],
  pass: ScoringPass,
  combinedDelta: number,
): Partial<Record<DreamLabelSource, number>> {
  const present = LABEL_SOURCES.filter((source) => labels.some((label) => label.source === source));
  const deltas: Partial<Record<DreamLabelSource, number>> = {};
  if (present.length === 1) {
    deltas[present[0]!] = combinedDelta;
    return deltas;
  }
  for (const source of present) {
    if (mustStop(pass)) break;
    const only = indexLabels(labels.filter((label) => label.source === source));
    const sourceRun = pairedRun(eligible, only, pass);
    if (sourceRun.delta !== null) deltas[source] = sourceRun.delta;
  }
  return deltas;
}

/** The limits of concept 5.4, clamped as they are read (S23). */
export function validityLimits(config: RookeryConfig): ValidityLimits {
  const dream = config.memory.dream;
  return {
    minTraces: Math.max(0, Math.floor(clampNumber(dream.minTraces, 0, 1_000_000))),
    abstainEps: clampNumber(dream.abstainEps, 0, 1),
    abstainFloor: clampNumber(dream.abstainFloor, 0, 1),
    reachableFloor: clampNumber(dream.reachableFloor, 0, 1),
    coverageFloor: clampNumber(dream.coverageFloor, 0, 1),
    costOnlyCeiling: clampNumber(dream.costOnlyCeiling, 0, 1),
  };
}

/**
 * The five rules of concept 5.4 over a finished result. Every failure is a
 * named violation and the result stays readable - an invalid evaluation is
 * not an error, it is a measurement that does not certify anything, and the
 * numbers it did produce are still worth storing.
 */
export function validityOf(
  result: DreamEvalResult,
  limits: ValidityLimits,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  if (
    !pairedOnIntersection({
      closedBaseline: result.closedBaseline,
      closedCandidate: result.closedCandidate,
      closed: result.closed,
      paired: result.closed,
    })
  ) {
    violations.push('not-paired-on-intersection');
  }
  if (!abstainRuleHolds(result.abstainRateCandidate, result.abstainRateBaseline, limits)) {
    violations.push('abstain-rate');
  }
  // Rule 3 is the one that must never read as "the candidate lost".
  if (!traceFloorHolds(result.closed, limits.minTraces)) violations.push('n-closed-below-min');
  if (!reachableFloorHolds(result.reachableRate, limits.reachableFloor)) {
    violations.push('reachable-rate');
  }
  if (!coverageRuleHolds(result.labelCoverage, result.costOnlyShare, limits)) {
    if (result.labelCoverage < limits.coverageFloor) violations.push('label-coverage');
    if (result.costOnlyShare > limits.costOnlyCeiling) violations.push('cost-only-share');
  }
  return { valid: violations.length === 0, violations };
}

/**
 * Evaluate one candidate arm against one baseline arm over a recorded pool
 * (concept 5.3, 5.4, 4.4).
 *
 * The order of work is the contract. The pre-checks fire first and in a
 * fixed order - a frame of another owner is dropped outright (10.5), then
 * `unfinished`, then `corpus-drifted` against the stamp the caller handed
 * in, then `budget-changed` against the config the turn would render with
 * today. What survives is scored on both arms; the intersection of the two
 * closed sets is what a delta may be formed over, and the bootstrap draws
 * SESSIONS, not traces. The five validity rules run last, over the finished
 * numbers, so their verdict is reproducible from the stored row alone.
 *
 * Nothing here writes, and nothing here throws.
 */
export function evaluateCandidate(store: Store, input: EvaluateInput): DreamEvalResult {
  const startedAt = Date.now();
  const result = emptyResult(input.slot);
  // First line of work: the abort guard. There is no `#throwIfAborted` in the
  // night's dream block, so an aborted run reports an empty, invalid result.
  if (input.signal?.aborted) {
    result.violations.push('aborted');
    result.evalMs = Date.now() - startedAt;
    return result;
  }

  try {
    const dream = input.config.memory.dream;
    const pass: ScoringPass = {
      config: input.config,
      baseline: input.baseline,
      candidate: input.candidate,
      costWeight: clampNumber(dream.costWeight, 0, 1),
      deadline: input.deadline,
      signal: input.signal,
    };

    const screening = screenPool(store, input, {
      corpus: input.corpus,
      tolerance: clampNumber(dream.corpusTolerance, 0, 10),
      budget: expectedBudgetChars(input.config),
    });
    result.traces = input.entries.length - screening.foreignOwner;

    const labels = labelsOfPool(store, input.owner, screening.eligible);
    const index = indexLabels(labels);
    const run = pairedRun(screening.eligible, index, pass);
    Object.assign(result, measuredFields(run, screening.reasons, result.traces));

    const deltaBySource =
      input.sourceDeltas === false
        ? {}
        : deltasBySource(screening.eligible, labels, pass, result.delta);

    // The freshness sensor, over the traces that actually paired - the only
    // ones whose sign there is anything to compare.
    if (input.freshness !== false && run.pairedEntries.length) {
      result.freshness = runFreshness(store, run.pairedEntries, index, pass);
      if (result.freshness.deltaLive !== null) result.deltaLive = result.freshness.deltaLive;
      result.signAgree = result.freshness.signAgree;
    }

    result.detail = {
      deltaBySource,
      labelsBySource: countBySource(labels),
      conflicts: index.conflicts,
      foreignOwner: screening.foreignOwner,
      intersection: run.intersection,
      costOnly: run.costOnly,
      frameTimeouts: run.frameTimeouts,
      deadlineHit: run.deadlineHit,
    };

    const verdict = validityOf(result, validityLimits(input.config));
    result.valid = verdict.valid;
    result.violations = verdict.violations;
    result.evalMs = Date.now() - startedAt;
    result.evidenceDigest = renderEvidenceDigest(result);
    return result;
  } catch (cause) {
    // Like the probe: an internal failure is reported, and the night goes on.
    result.error = (cause as Error).message;
    result.evalMs = Date.now() - startedAt;
    result.valid = false;
    if (!result.violations.includes('error')) result.violations.push('error');
    result.evidenceDigest = renderEvidenceDigest(result);
    return result;
  }
}

/* --------------------------- selection and audit --------------------------- */

/** One candidate with what the training half said about it. */
export interface RankedCandidate {
  /** Position in the caller's candidate list; the incumbent is index 0 there. */
  index: number;
  policy: FrameScoringPolicy;
  training: DreamEvalResult;
}

/** What one selection produced, end to end. */
export interface SelectionReport {
  split: { train: number; holdout: number; audit: number };
  /** Every candidate's training evaluation, valid ones first, best delta first. */
  ranked: RankedCandidate[];
  /** The ONE candidate that went on to the holdout (E4/S12), or none. */
  chosen: RankedCandidate | null;
  /** The chosen candidate against the incumbent, on the holdout half. */
  holdout: DreamEvalResult | null;
  /** The chosen candidate against the FACTORY default, on the frozen audit set. */
  audit: DreamEvalResult | null;
  /** S13: 0 or 1 per selection, never more. */
  auditTouched: number;
  findings: string[];
}

/** What one selection needs. */
export interface SelectionInput {
  owner: string;
  slot: DreamSlot;
  config: RookeryConfig;
  /** The whole recorded pool; this function splits it (E3). */
  entries: readonly FrameEntry[];
  /** The arm every candidate is ranked against. */
  incumbent: FrameScoringPolicy;
  /** The factory default parameter set the audit set compares against (10.2, 2b). */
  factory: FrameScoringPolicy;
  candidates: readonly FrameScoringPolicy[];
  rates?: SplitRates;
  corpus?: FrameCorpus | null;
  freshness?: boolean;
  sourceDeltas?: boolean;
  deadline?: number;
  signal?: AbortSignal;
}

/**
 * Rank the candidates on the training half and send exactly one of them to
 * the holdout (E4/S12).
 *
 * Testing six candidates against one 95 percent interval is six-fold
 * testing, and the concept's answer is not a correction but a discipline:
 * the ranking happens where a wrong answer costs nothing, and the one
 * interval that will be read is computed once, on data the ranking never
 * saw. A candidate that is not ahead of the incumbent on training has no
 * business on the holdout at all - the margin test itself belongs to the
 * holdout (promotion condition 2a), so the bar here is plain improvement.
 *
 * The frozen audit set (concept 5.5d) is touched exactly once per promotion
 * (S13), and only when a promotion is actually on the table: the holdout
 * must be valid, over the margin and with `ci_low > 0` before the audit set
 * is opened at all. Without that rule the set would be consumed by every
 * night that measured something, and a set that is read every night is not
 * a frozen set - it is just another holdout with a longer name.
 */
export function selectOnTraining(store: Store, input: SelectionInput): SelectionReport {
  const pool = splitPool(input.entries, input.rates ?? DEFAULT_SPLIT_RATES);
  const report: SelectionReport = {
    split: { train: pool.train.length, holdout: pool.holdout.length, audit: pool.audit.length },
    ranked: [],
    chosen: null,
    holdout: null,
    audit: null,
    auditTouched: 0,
    findings: [],
  };

  const evaluateOn = (
    arms: Pick<EvaluateInput, 'entries' | 'baseline' | 'candidate' | 'freshness'>,
  ): DreamEvalResult =>
    evaluateCandidate(store, {
      owner: input.owner,
      slot: input.slot,
      config: input.config,
      corpus: input.corpus,
      sourceDeltas: input.sourceDeltas,
      deadline: input.deadline,
      signal: input.signal,
      ...arms,
    });

  report.ranked = rankOnTraining(input.candidates, input.signal, (policy) =>
    evaluateOn({
      entries: pool.train,
      baseline: input.incumbent,
      candidate: policy,
      // The training half ranks; the freshness sensor is a promotion
      // sensor and costs a live fetch per frame, so it runs once, on the
      // one evaluation that can lead anywhere.
      freshness: false,
    }),
  );

  const best = report.ranked.find((entry) => entry.training.valid && entry.training.delta > 0);
  if (!best) {
    report.findings.push('no-candidate-ahead-on-training');
    return report;
  }
  report.chosen = best;

  if (!pool.holdout.length) {
    report.findings.push('holdout-empty');
    return report;
  }
  report.holdout = evaluateOn({
    entries: pool.holdout,
    baseline: input.incumbent,
    candidate: best.policy,
    freshness: input.freshness,
  });

  const margin = clampNumber(input.config.memory.dream.margin, 0, 1);
  const promotable =
    report.holdout.valid && report.holdout.delta > margin && report.holdout.ciLow > 0;
  if (!promotable) {
    // The audit set stays shut: nothing is on the table, so nothing spends
    // the one touch this promotion would have had (S13).
    report.findings.push('holdout-not-promotable');
    return report;
  }
  if (!pool.audit.length) {
    report.findings.push('audit-set-empty');
    return report;
  }

  report.auditTouched = 1;
  report.audit = evaluateOn({
    entries: pool.audit,
    // Cumulative, against the FACTORY default rather than the incumbent
    // (condition 2b): a chain of individually significant steps, each only
    // against its own predecessor, is a random walk with a ratchet.
    baseline: input.factory,
    candidate: best.policy,
    freshness: false,
  });
  report.holdout.auditDelta = report.audit.delta;
  report.holdout.auditCiLow = report.audit.ciLow;
  report.holdout.evidenceDigest = renderEvidenceDigest(report.holdout);
  return report;
}

/** Every candidate's training evaluation: valid ones first, best delta first, then widest lower bound. */
function rankOnTraining(
  candidates: readonly FrameScoringPolicy[],
  signal: AbortSignal | undefined,
  evaluate: (policy: FrameScoringPolicy) => DreamEvalResult,
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (signal?.aborted) break;
    const policy = candidates[index]!;
    ranked.push({ index, policy, training: evaluate(policy) });
  }
  return ranked.sort((a, b) => {
    if (a.training.valid !== b.training.valid) return a.training.valid ? -1 : 1;
    if (b.training.delta !== a.training.delta) return b.training.delta - a.training.delta;
    if (b.training.ciLow !== a.training.ciLow) return b.training.ciLow - a.training.ciLow;
    return a.index - b.index;
  });
}

/* --------------------------- the agreement sensor --------------------------- */

/** Two sources' agreement over the targets they both judged. */
export interface SourceAgreement {
  a: DreamLabelSource;
  b: DreamLabelSource;
  pairs: number;
  /** `null` where kappa is undefined: no common target, or a degenerate rater. */
  kappa: number | null;
  /** The plain fallback the concept allows where kappa is undefined. */
  agreement: number | null;
}

export interface AgreementOptions {
  /** `dream.agreementFloor`. */
  floor?: number;
  /** `dream.margin` - what counts as "flat" on `user`. */
  margin?: number;
  /** How many common targets `user` needs before its agreement means anything. */
  minUserPairs?: number;
  /** Per-source paired deltas, as `evaluateCandidate` reports them. */
  deltaBySource?: Partial<Record<DreamLabelSource, number>>;
  /**
   * `dream.requireUserLabels`. Whether too few `user` labels is itself a
   * finding. Off, only user evidence that exists can veto.
   */
  requireUserLabels?: boolean;
}

/** What the label agreement sensor answers (concept 5.5b). */
export interface AgreementReport {
  labelsBySource: Partial<Record<DreamLabelSource, number>>;
  pairs: SourceAgreement[];
  /** Common targets `user` shares with any other source. */
  userPairs: number;
  userKappa: number | null;
  userAgreement: number | null;
  /**
   * False when `user` cannot be compared at all. That is the FINDING, not a
   * zero: the proxy is unvalidated, and an unvalidated proxy does not
   * promote a slot (concept 5.5b).
   */
  validated: boolean;
  floorHolds: boolean;
  /** A delta positive on the influenceable sources and flat or negative on `user`. */
  influenceableOnly: boolean;
  findings: string[];
  /** True exactly when there is no finding. */
  ok: boolean;
}

/**
 * The label agreement sensor (concept 5.5b, E12): Cohen's kappa per source
 * pair over their common targets, with `user` privileged.
 *
 * `user` is privileged because it is the one source the retrieval policy has
 * no causal path to. Everything else is written downstream of what the
 * incumbent surfaced, so a candidate can move all of them together and be
 * measuring its own reflection. Hence the second finding: a delta that is
 * positive on the influenceable sources and flat or negative on `user` is
 * flagged, not averaged away.
 *
 * And when `user` has too few common targets for an agreement at all, the
 * report says `validated: false` and never falls back on the sources that
 * agree with each other because they were written by the same process.
 * Whether that absence is also a finding (`user-labels-thin`) is
 * `dream.requireUserLabels`: a bank whose owner never hand-edits a memory
 * can only ever promote with it off, and the checks that need user
 * evidence to exist - the floor and the influenceable-only delta - still
 * veto the moment it does.
 */
export function agreementReport(
  labels: readonly DreamLabel[],
  options: AgreementOptions = {},
): AgreementReport {
  const floor = clampNumber(
    options.floor ?? DEFAULT_CONFIG.memory.dream.agreementFloor,
    -1,
    1,
  );
  const margin = clampNumber(options.margin ?? DEFAULT_CONFIG.memory.dream.margin, 0, 1);
  const minUserPairs = Math.max(1, Math.floor(options.minUserPairs ?? MIN_USER_PAIRS));
  const requireUserLabels =
    options.requireUserLabels ?? DEFAULT_CONFIG.memory.dream.requireUserLabels;

  const pairs = agreementPairs(groupBySource(labels));

  // The privileged comparison: the best-supported pair `user` takes part in.
  const bestUser = pairs
    .filter((pair) => pair.a === 'user' || pair.b === 'user')
    .reduce<SourceAgreement | null>(
      (best, pair) => (!best || pair.pairs > best.pairs ? pair : best),
      null,
    );
  const userPairs = bestUser?.pairs ?? 0;
  // Kappa where it is defined, the plain rate where it is not: `merge`
  // writes nothing but zeroes, so a kappa against it is degenerate by
  // construction and a fabricated number would be worse than the fallback.
  const userScore = bestUser ? (bestUser.kappa ?? bestUser.agreement) : null;
  const validated = userPairs >= minUserPairs && userScore !== null;
  const floorHolds = validated && (userScore ?? 0) >= floor;

  const deltas = options.deltaBySource ?? {};
  const influenceableUp = INFLUENCEABLE.some((source) => (deltas[source] ?? 0) > margin);
  const userDelta = deltas.user;
  const influenceableOnly = influenceableUp && userDelta !== undefined && userDelta <= margin;

  const findings: string[] = [];
  if (!validated) {
    if (requireUserLabels) findings.push('user-labels-thin');
  } else if (!floorHolds) findings.push('agreement-below-floor');
  if (influenceableOnly) findings.push('influenceable-only-delta');

  return {
    labelsBySource: countBySource(labels),
    pairs,
    userPairs,
    userKappa: bestUser?.kappa ?? null,
    userAgreement: bestUser?.agreement ?? null,
    validated,
    floorHolds,
    influenceableOnly,
    findings,
    ok: findings.length === 0,
  };
}

/** Cohen's kappa and the plain rate for every source pair that judged a common target. */
function agreementPairs(bySource: ReadonlyMap<DreamLabelSource, DreamLabel[]>): SourceAgreement[] {
  const pairs: SourceAgreement[] = [];
  for (let i = 0; i < LABEL_SOURCES.length; i += 1) {
    for (let j = i + 1; j < LABEL_SOURCES.length; j += 1) {
      const a = LABEL_SOURCES[i]!;
      const b = LABEL_SOURCES[j]!;
      const left = bySource.get(a) ?? [];
      const right = bySource.get(b) ?? [];
      if (!left.length || !right.length) continue;
      const common = pairedRatings(left, right);
      if (!common.length) continue;
      pairs.push({
        a,
        b,
        pairs: common.length,
        kappa: cohensKappa(left, right),
        agreement: pairwiseAgreement(left, right),
      });
    }
  }
  return pairs;
}

/* ------------------------------ the structural contract ------------------------------ */

/**
 * The compiler's assertion that a finished evaluation really does carry
 * every column of the row AP9 writes: `dream_evals` minus the four fields
 * that belong to the promotion, not to the measurement. A column renamed on
 * either side fails the build here, where the reason is written down,
 * instead of at whichever call site AP12 writes next.
 */
type Satisfies<Shape, T extends Shape> = T;

type ResultCoversTheRow = Satisfies<
  Omit<DreamEval, 'id' | 'sleepRunId' | 'policyId' | 'promoted' | 'createdAt'>,
  DreamEvalResult
>;

/** And the store's read path really does hand over what this module consumes. */
type StoredFrameIsAnEntry = Satisfies<FrameEntry, ReturnType<Store['framesFor']>[number]>;
