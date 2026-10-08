import type {
  AbstainReason,
  DreamFrame,
  DreamTrace,
  FrameCorpus,
  RecallBox,
  RecallFrame,
  RecallPolicy,
  RecallWeights,
  RookeryConfig,
} from '../../types.js';
import type { Store } from '../store.js';
import { fetchFrame } from './frame.js';
import { resolvePolicy } from './policy.js';
import { measure, type GainFunction, type MeasureResult } from './measure.js';
import type { FrameScoringPolicy } from './score.js';
import {
  ABSTAIN_REASONS,
  NO_GAIN,
  clampNumber,
  emptyReasons,
  expectedBudgetChars,
  frameDeadline,
  mean,
  readCorpusStamp,
} from './util.js';

/**
 * The night's grid probe (dream stage 1, AP10; concept 6.1, 5.5a, 3.3).
 *
 * Stage 1 needs no candidate writer: the first delivered answer to "is our
 * retrieval any good?" is a fixed, declared grid of parameter placements
 * scored against the incumbent over the recorded frames. Zero model calls,
 * zero promotions, no policy_versions - the result is a number per placement
 * plus a certificate of what that number is worth.
 *
 * Four contracts hold everywhere in this module:
 *
 * - It never writes to the bank. `fetchFrame` has no touch path at all and
 *   `measure` is pure, so `touch: false` is not a flag anyone could flip by
 *   accident - it is the absence of a write path (R6). The test that pins this
 *   compares `access_count` and `usefulness` of every row before and after a
 *   full probe, because a watcher that feeds the feedback loop it watches
 *   would be worse than no watcher.
 * - It never throws. `ask` in sleep.ts never throws either; a phase that
 *   throws would be the first real throw site in the night block. Everything
 *   in here catches and reports into the result instead.
 * - It runs on wall-clock budgets. "Zero model calls" is not "zero cost":
 *   the probe reads frames of 40-90 KB, JSON.parses them and drives 8-12
 *   placements over each, on the one synchronous connection the server uses.
 *   The overall deadline is `dream.maxEvalMs` (reported like modelCalls, R8);
 *   on top of that, no single frame may eat more than FRAME_TIME_LIMIT_MS -
 *   a monstrous frame is abstained, not allowed to starve the shared budget.
 * - The first line of every entry point is the abort guard. There is no
 *   `#throwIfAborted` between the cycle-loop boundaries the probe is wedged
 *   into, so the probe carries its own.
 *
 * What the estimator is worth: with no label writer (stage 1), the night
 * supplies an empty gain and every frame abstains with `no-reachable-label`.
 * That is the honest number - machinery exercised, coverage reported as
 * absent, and Phase 2's label sources turn it into a real one. The estimator
 * is a lower bound (R2) even once labels exist; see the quotation at the head
 * of dream/measure.ts.
 */

/**
 * How many stored frames one night walks, oldest first (the store default).
 * Above the limit the newest frames fall out of the pool - reported through
 * `framesTotal`/`poolTruncated`, never hidden inside a smaller count.
 */
const FRAME_POOL_LIMIT = 500;
/** Cluster-bootstrap draws over sessions, percentile interval 2.5/97.5. */
const BOOTSTRAP_B = 2000;
/** Percentile interval bounds of the bootstrap: 2.5 / 97.5. */
const BOOTSTRAP_LOW_QUANTILE = 0.025;
const BOOTSTRAP_HIGH_QUANTILE = 0.975;
/** Fixed seed: the interval must be reproducible, never per-run random. */
const BOOTSTRAP_SEED = 20260917;
/**
 * Below this |delta| a sign flip between the frozen and the live world is not
 * a finding. The concept's `dream.margin` key belongs to Phase 3's gate and
 * has no reader in stage 1 (R16), so the probe carries the literal.
 */
const FRESHNESS_MARGIN = 0.02;
/** Written by `reindex` and the bulk import (db.ts, AP1); read here. */
const CORPUS_INVALIDATED_KEY = 'dream.corpus_invalidated_at';
/** The grid the stage prescribes: at least 8, at most 12 placements. */
const GRID_MIN = 8;
const GRID_MAX = 12;
/** What a `dream.gridSize` that is not a number falls back to. */
const DEFAULT_GRID_SIZE = 10;
/** The incumbent is placement 0 of every grid, and every delta is read against it. */
const INCUMBENT_INDEX = 0;
/** One hour: the most `dream.maxEvalMs` may ask for. */
const MAX_EVAL_MS_CEILING = 3_600_000;

function addReasons(target: Record<AbstainReason, number>, source: Record<AbstainReason, number>): void {
  for (const reason of ABSTAIN_REASONS) target[reason] += source[reason] ?? 0;
}

function countAbstains(target: Record<AbstainReason, number>, reasons: readonly AbstainReason[]): void {
  for (const reason of reasons) target[reason] += 1;
}

/** When `reindex` or the bulk import last moved the corpus stamp (0 = never). */
function readInvalidatedAt(store: Store): number {
  const raw = store.getMeta(CORPUS_INVALIDATED_KEY);
  const value = raw === null ? 0 : Number(raw);
  return Number.isFinite(value) ? value : 0;
}

/* ------------------------------- the grid ------------------------------- */

type Interval = readonly [number, number];

/** Where on a box interval a placement sits; `incumbent` is the recorded point. */
type Corner = 'lo' | 'mid' | 'hi' | 'incumbent';

/** Which weight vector a placement uses, beyond the plain corners. */
type WeightChoice = Corner | 'relevance-heavy' | 'context-heavy' | 'usage-off';

/** One declared grid placement, as a choice of corners - never a random draw. */
interface GridSpec {
  w: WeightChoice;
  threshold: Corner;
  hopEntity: Corner;
  hopEdge: Corner;
}

/**
 * The fixed placements, in fixed order. Deterministic and declared in this
 * file (concept 6.1): weights at the box edges, the threshold in three steps,
 * the hop weights in two, plus a few mixed vectors that name the strategies a
 * real candidate would try - all relevance, all context, usage off. The first
 * entry is always the incumbent, because the incumbent is always a candidate
 * and runs in the same pass, never as a number from yesterday (concept 6.3).
 */
const GRID: readonly GridSpec[] = [
  { w: 'incumbent', threshold: 'incumbent', hopEntity: 'incumbent', hopEdge: 'incumbent' },
  { w: 'lo', threshold: 'lo', hopEntity: 'lo', hopEdge: 'lo' },
  { w: 'lo', threshold: 'mid', hopEntity: 'hi', hopEdge: 'hi' },
  { w: 'hi', threshold: 'lo', hopEntity: 'lo', hopEdge: 'lo' },
  { w: 'hi', threshold: 'hi', hopEntity: 'hi', hopEdge: 'hi' },
  { w: 'relevance-heavy', threshold: 'mid', hopEntity: 'incumbent', hopEdge: 'incumbent' },
  { w: 'context-heavy', threshold: 'mid', hopEntity: 'incumbent', hopEdge: 'incumbent' },
  { w: 'incumbent', threshold: 'hi', hopEntity: 'incumbent', hopEdge: 'incumbent' },
  { w: 'incumbent', threshold: 'lo', hopEntity: 'hi', hopEdge: 'hi' },
  { w: 'incumbent', threshold: 'mid', hopEntity: 'hi', hopEdge: 'lo' },
  { w: 'mid', threshold: 'mid', hopEntity: 'mid', hopEdge: 'mid' },
  { w: 'usage-off', threshold: 'lo', hopEntity: 'lo', hopEdge: 'hi' },
];

function cornerValue(corner: Corner, interval: Interval, incumbent: number): number {
  if (corner === 'lo') return interval[0];
  if (corner === 'hi') return interval[1];
  if (corner === 'mid') return (interval[0] + interval[1]) / 2;
  // The recorded point, pulled back into the box it declared - a no-op for
  // every box the recorder stretched over its realised policy.
  return Math.min(interval[1], Math.max(interval[0], incumbent));
}

function weightVector(choice: WeightChoice, box: RecallBox, policy: RecallPolicy): RecallWeights {
  const w = box.w;
  const p = policy.w;
  switch (choice) {
    case 'relevance-heavy':
      // Trust the text match, nothing else.
      return { relevance: w.relevance[1], importance: w.importance[0], recency: w.recency[0], usage: w.usage[0] };
    case 'context-heavy':
      // Trust what the bank claims about itself over the query.
      return { relevance: w.relevance[0], importance: w.importance[1], recency: w.recency[1], usage: w.usage[0] };
    case 'usage-off':
      // Close the usage channel entirely (H2 lives on it) and stay aggressive.
      return { relevance: w.relevance[1], importance: w.importance[1], recency: (w.recency[0] + w.recency[1]) / 2, usage: w.usage[0] };
    default:
      return {
        relevance: cornerValue(choice, w.relevance, p.relevance),
        importance: cornerValue(choice, w.importance, p.importance),
        recency: cornerValue(choice, w.recency, p.recency),
        usage: cornerValue(choice, w.usage, p.usage),
      };
  }
}

/** `dream.gridSize` clamped into the 8..12 the stage prescribes; a non-finite size takes the default. */
function gridCount(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_GRID_SIZE;
  return Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(size)));
}

/**
 * The fixed grid over one frame's declared box, around its recorded policy.
 * `size` is `dream.gridSize`, clamped into the 8..12 the stage prescribes -
 * a config that bypassed the patch schema (E21) cannot ask for a 2-placement
 * grid or a 500-placement one. Every returned point sits inside the box by
 * construction, so no placement can hit `limit-out-of-box` (that reason
 * firing is a recorder error, concept 5.4 - the box promised closure).
 */
export function buildGrid(policy: RecallPolicy, box: RecallBox, size: number): FrameScoringPolicy[] {
  const limit = Math.max(0, Math.min(policy.limit, box.limitMax));
  return GRID.slice(0, gridCount(size)).map((spec) => ({
    limit,
    threshold: cornerValue(spec.threshold, box.threshold, policy.threshold),
    hopEntity: cornerValue(spec.hopEntity, box.hopEntity, policy.hopEntity),
    hopEdge: cornerValue(spec.hopEdge, box.hopEdge, policy.hopEdge),
    w: weightVector(spec.w, box, policy),
  }));
}

/* ----------------------------- corpus drift ----------------------------- */

/**
 * Whether the document frequency of THIS frame's tokens moved further than
 * `tolerance` between the stamp the frame was recorded under and `today`
 * (R10, concept 3.3). bm25 is frozen in the frame and can never be
 * revalidated, so the corpus is the only observable that correlates with a
 * frame going stale - and this is the check on it, run against the
 * once-per-night fingerprint, never inside a turn.
 *
 * A frame without a recorded stamp is waived, not condemned: before the first
 * night there was nothing to stamp, and abstaining that entire pool would
 * kill the very first probe. Frames older than a reindex or bulk import are
 * `corpus-invalidated`, a different reason - never guessed here.
 *
 * A token one of the stamps never measured is unknown, not df 0: the nightly
 * stamp covers only the tokens of its own pool, so a query token that entered
 * the bank after the recording night moved nothing that was measured. Such a
 * token falls out of the comparison - only tokens with a df on both sides
 * count, and a frame with none of those is waived here, never condemned: a
 * stamp that cannot be read certifies nothing (and the store writes measured
 * zeros explicitly, so a missing key really is an unmeasured token).
 */
export function corpusDrifted(
  frame: RecallFrame,
  today: FrameCorpus,
  tolerance: number,
  recorded?: FrameCorpus | null,
): boolean {
  if (!recorded) return false;
  let worst = 0;
  for (const token of frame.query.tokens) {
    const then = recorded.df[token];
    const now = today.df[token];
    if (then === undefined || now === undefined) continue;
    // max(1, then): a token that went from 0 to 1 has moved as far as a
    // token can - df 0 cannot halve, and dividing by 0 would say otherwise.
    worst = Math.max(worst, Math.abs(now - then) / Math.max(1, then));
  }
  return worst > tolerance;
}

/* ------------------------- the cluster bootstrap ------------------------- */

/**
 * Deterministic PRNG (mulberry32). The percentile interval must be
 * reproducible across runs - a confidence interval that moves between two
 * identical nights is noise dressed up as statistics.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile interval (2.5/97.5) of the mean over a cluster bootstrap
 * (concept 5.3): `clusterDeltas` holds the per-trace deltas grouped by
 * SESSION - consecutive turns of one session share topic, bank cutout and
 * entity neighbourhood, so bootstrapping over traces would understate the
 * variance and let `ci_low > 0` fire on leakage. Each draw samples clusters
 * with replacement and takes the mean of every delta of the drawn clusters;
 * the reported interval is approximate, and the stage says so next to the
 * number rather than in a footnote.
 */
export function bootstrapCi(
  clusterDeltas: readonly (readonly number[])[],
  b: number = BOOTSTRAP_B,
): { low: number; high: number } | null {
  const clusters = clusterDeltas.filter((cluster) => cluster.length > 0);
  if (!clusters.length) return null;
  const random = mulberry32(BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let draw = 0; draw < b; draw += 1) {
    let sum = 0;
    let count = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[Math.floor(random() * clusters.length)]!;
      for (const delta of cluster) {
        sum += delta;
        count += 1;
      }
    }
    means.push(count ? sum / count : 0);
  }
  means.sort((x, y) => x - y);
  const low = means[Math.min(means.length - 1, Math.floor(BOOTSTRAP_LOW_QUANTILE * means.length))]!;
  const high = means[
    Math.max(0, Math.min(means.length - 1, Math.ceil(BOOTSTRAP_HIGH_QUANTILE * means.length) - 1))
  ]!;
  return { low, high: Math.max(high, low) };
}

/* ------------------------------ the pre-checks ------------------------------ */

/** A stored frame with the trace it was recorded under, as `store.framesFor` hands it over. */
export interface RecordedFrame {
  trace: DreamTrace;
  frame: DreamFrame;
}

/** What the pre-checks compare a frame against. */
export interface PrecheckContext {
  /** The night's fingerprint; without one the drift check is skipped. */
  corpus?: FrameCorpus | null;
  tolerance: number;
  /** The budget the assistant turn would render with today. */
  budget: number;
  /** When a reindex or bulk import last moved the corpus (0 or absent = never, the rule is skipped). */
  invalidatedAt?: number;
}

/**
 * The one place the pre-check order lives: an unfinished trace first, then
 * `corpus-invalidated` (older than a reindex or bulk import - never guessed as
 * drift), then `corpus-drifted` against the night's fingerprint, then
 * `budget-changed`. `null` = the frame may be scored. Shared by the probe and
 * the candidate evaluation, so both nights ask the same questions in the same
 * order.
 */
export function precheckReason(
  store: Store,
  entry: RecordedFrame,
  context: PrecheckContext,
): AbstainReason | null {
  const payload = entry.frame.payload;
  const invalidatedAt = context.invalidatedAt ?? 0;
  if (!entry.trace.finishedAt) return 'unfinished';
  if (invalidatedAt > 0 && entry.frame.createdAt < invalidatedAt) return 'corpus-invalidated';
  if (
    context.corpus &&
    corpusDrifted(payload, context.corpus, context.tolerance, readCorpusStamp(store, payload.corpusStampId))
  ) {
    return 'corpus-drifted';
  }
  if (payload.pipeline === 'assistant' && payload.budgetChars !== context.budget) return 'budget-changed';
  return null;
}

/* ---------------------------- the freshness test ---------------------------- */

/** What "the rows" of a frame are, for the frozen-versus-live comparison. */
function rowsSignature(frame: RecallFrame): string {
  return JSON.stringify([
    frame.hop1.map((row) => [row.id, row.relevance]),
    frame.possibleSeeds,
    frame.profile.map((row) => row.id),
  ]);
}

/**
 * Whether the frozen and the live delta point the same way; `null` when the
 * frozen delta sits inside `margin`, where the comparison is moot and
 * "undetermined" is the honest answer - not "they disagree" (concept 5.5a).
 */
export function signsAgree(frozenDelta: number, liveDelta: number, margin: number): boolean | null {
  if (Math.abs(frozenDelta) <= margin) return null;
  return Math.sign(frozenDelta) === Math.sign(liveDelta);
}

/**
 * The live re-fetch of a frame's own query. A MATCH the parser rejects
 * degrades inside the frame (three worlds, not two); anything else that throws
 * skips this frame's live side - the caller counts it as `frame-missing`
 * rather than breaking the night.
 */
function refetchLive(store: Store, payload: RecallFrame): RecallFrame | null {
  try {
    return fetchFrame(store, {
      text: payload.query.text,
      owner: payload.owner,
      limit: payload.box.limitMax,
      kinds: payload.box.kinds,
      minImportance: payload.box.minImportance,
      box: payload.box,
      site: payload.site,
      pipeline: payload.pipeline,
      budgetChars: payload.budgetChars,
      subject: payload.subject,
    });
  } catch {
    return null;
  }
}

/** One frame's paired delta of a candidate arm over a baseline arm, and why either arm abstained. */
function pairedDelta(
  frame: RecallFrame,
  baseline: FrameScoringPolicy,
  candidate: FrameScoringPolicy,
  options: Pick<FreshnessOptions, 'gain' | 'costWeight'>,
): { delta: number | null; abstained: AbstainReason[] } {
  const base = measure(frame, baseline, options.gain, options.costWeight);
  const cand = measure(frame, candidate, options.gain, options.costWeight);
  const abstained: AbstainReason[] = [];
  if (!base.ok) abstained.push(base.abstain);
  if (!cand.ok) abstained.push(cand.abstain);
  return { delta: base.ok && cand.ok ? cand.score - base.score : null, abstained };
}

export interface FreshnessOptions {
  /** The config the default arms resolve against (recorded policy first). */
  config: RookeryConfig;
  /** Fixed baseline arm for every frame; default is each frame's own incumbent. */
  baseline?: FrameScoringPolicy;
  /** Fixed candidate arm; default is each frame's first non-incumbent placement. */
  candidate?: FrameScoringPolicy;
  gain: GainFunction;
  costWeight?: number;
  /** Wall-clock deadline in epoch ms; the check stops when it passes. */
  deadline?: number;
  signal?: AbortSignal;
}

export interface FreshnessEntry {
  /** The stored record the comparison started from. */
  frozen: DreamFrame;
  /** The live re-fetch - same query text, same owner, same box (concept 5.5a). */
  fresh: RecallFrame | null;
  rowsDiffer: boolean;
  frozenDelta: number | null;
  liveDelta: number | null;
}

export interface FreshnessReport {
  frames: number;
  /** Frames whose frozen arms both closed. */
  closedFrozen: number;
  /** Frames whose live arms both closed. */
  closedLive: number;
  /** Frames where both worlds closed - the only frames the sign is read on. */
  closedBoth: number;
  deltaFrozen: number | null;
  deltaLive: number | null;
  /** 1 = same sign, 0 = opposite sign, null = undetermined or below margin. */
  signAgree: 1 | 0 | null;
  /**
   * Share of frames whose rows differ between the frozen record and a live
   * fetch. On a quiet bank frozen and live are identical and the test has no
   * teeth - that test strength must be visible, not hidden (concept, open
   * question 11).
   */
  rowsDifferShare: number;
  abstainReasons: Record<AbstainReason, number>;
  frameTimeouts: number;
  entries: FreshnessEntry[];
}

/**
 * The frame-ageing sensor (concept 5.5a): baseline and candidate run twice,
 * once against the frozen frames and once against a FRESH `fetchFrame` with
 * the same query text, the same owner and the same box. The live run is
 * knowingly polluted - entity recounts, night-written edges, drifting
 * importance all push both arms the same way - which is exactly why a sign
 * FLIP means the ordering of the two policies is not robust against bank
 * movement, the thing the bootstrap cannot see because it holds the bank
 * fixed. A polluted number may serve as a comparator, never as a measurement.
 *
 * This function never writes: the fresh fetch goes through `fetchFrame`,
 * which has no touch path at all (R6).
 */
export function freshnessCheck(
  store: Store,
  entries: readonly RecordedFrame[],
  options: FreshnessOptions,
): FreshnessReport {
  const report: FreshnessReport = {
    frames: entries.length,
    closedFrozen: 0,
    closedLive: 0,
    closedBoth: 0,
    deltaFrozen: null,
    deltaLive: null,
    signAgree: null,
    rowsDifferShare: 0,
    abstainReasons: emptyReasons(),
    frameTimeouts: 0,
    entries: [],
  };
  // First line of work: the abort guard.
  if (options.signal?.aborted) return report;

  const frozenDeltas: number[] = [];
  const liveDeltas: number[] = [];
  let rowsDiffer = 0;
  let compared = 0;

  for (const entry of entries) {
    if (options.signal?.aborted) break;
    const now = Date.now();
    if (options.deadline !== undefined && now > options.deadline) break;
    const cutoff = frameDeadline(now, options.deadline);

    const payload = entry.frame.payload;
    const policy =
      entry.trace.policySet.recall ??
      resolvePolicy(store, options.config, entry.trace.owner, 'recall');
    const grid = buildGrid(policy, payload.box, GRID_MIN);
    const baseline = options.baseline ?? grid[0]!;
    const candidate = options.candidate ?? grid[1]!;

    const fresh = refetchLive(store, payload);
    const differ = fresh !== null && rowsSignature(payload) !== rowsSignature(fresh);
    if (fresh !== null) {
      compared += 1;
      if (differ) rowsDiffer += 1;
    } else {
      report.abstainReasons['frame-missing'] += 1;
    }

    const entryOut: FreshnessEntry = {
      frozen: entry.frame,
      fresh,
      rowsDiffer: differ,
      frozenDelta: null,
      liveDelta: null,
    };
    report.entries.push(entryOut);

    // A frame past its sub-cap is abstained: no monstrous frame may eat the
    // shared wall clock on its own.
    if (Date.now() > cutoff) {
      report.frameTimeouts += 1;
      continue;
    }

    const frozen = pairedDelta(payload, baseline, candidate, options);
    countAbstains(report.abstainReasons, frozen.abstained);
    entryOut.frozenDelta = frozen.delta;
    if (frozen.delta !== null) report.closedFrozen += 1;

    if (fresh) {
      const live = pairedDelta(fresh, baseline, candidate, options);
      countAbstains(report.abstainReasons, live.abstained);
      entryOut.liveDelta = live.delta;
      if (live.delta !== null) report.closedLive += 1;
    }

    if (entryOut.frozenDelta !== null && entryOut.liveDelta !== null) {
      report.closedBoth += 1;
      frozenDeltas.push(entryOut.frozenDelta);
      liveDeltas.push(entryOut.liveDelta);
    }
  }

  report.deltaFrozen = mean(frozenDeltas);
  report.deltaLive = mean(liveDeltas);
  report.rowsDifferShare = compared ? rowsDiffer / compared : 0;
  if (report.deltaFrozen !== null && report.deltaLive !== null) {
    const agree = signsAgree(report.deltaFrozen, report.deltaLive, FRESHNESS_MARGIN);
    report.signAgree = agree === null ? null : agree ? 1 : 0;
  }
  return report;
}

/* ------------------------------ the grid probe ------------------------------ */

export interface ProbeOptions {
  /**
   * The gain the placements are measured against. Stage 1 has no label
   * writer, so the night supplies none and the default is honestly empty -
   * every frame then abstains `no-reachable-label` and the report says so,
   * rather than pretending a number. Phase 2 derives this from `dream_labels`.
   */
  gain?: GainFunction;
  /**
   * The caller's own wall clock, as an absolute timestamp, replacing the one
   * the probe would compute from `dream.maxEvalMs`.
   *
   * Concept 6.1 gives the model-free evaluation ONE ceiling, and the night
   * spends it across the probe AND the slot that follows it. Left out - a
   * probe called on its own, as the tests do - the probe computes its own
   * from the same key, which is the same clock started here instead of
   * there. Handed in and already past, the probe scores nothing and says
   * `deadlineHit`, exactly as a zero budget does.
   */
  deadline?: number;
}

/** One grid placement's paired result against the incumbent. */
export interface GridPlacementReport {
  index: number;
  /** True for index 0 - the incumbent is always a candidate (concept 6.3). */
  incumbent: boolean;
  /** Frames where this placement AND the incumbent both closed. */
  closed: number;
  /** Mean paired delta over the closed frames; null when nothing closed. */
  delta: number | null;
  /** Percentile interval of the session-clustered bootstrap; null when none. */
  ciLow: number | null;
  ciHigh: number | null;
  /** Mean label coverage (R2) over the frames this placement closed. */
  coverage: number | null;
  abstainReasons: Record<AbstainReason, number>;
}

export interface ProbeReport {
  /** Distinct traces in the night's pool. */
  tracesSeen: number;
  /** Stored frames in the pool (one per trace and slot in stage 1). */
  frames: number;
  /**
   * All stored frames of the owner, pool limit aside. The pool walks the
   * oldest `FRAME_POOL_LIMIT` frames first, so above the limit the NEWEST
   * frames fall out of the measurement and the freshness sensor - reported
   * here so a shrunken pool never passes silently.
   */
  framesTotal: number;
  /** True when the pool cap dropped frames (`framesTotal > frames`). */
  poolTruncated: boolean;
  /** Grid scorings completed - the `sleep_runs.dream_frames_scored` counter. */
  framesScored: number;
  placements: GridPlacementReport[];
  abstainReasons: Record<AbstainReason, number>;
  /** Frames abstained as older than a reindex or bulk import (R17 world). */
  invalidated: number;
  /** When that import/reindex happened, if any. */
  invalidatedAt: number | null;
  /** The fingerprint this night stamped into `meta` (once per night, R10). */
  corpusStampId: string;
  /** Wall clock spent, reported like modelCalls (R8). */
  evalMs: number;
  /** Whether `dream.maxEvalMs` cut the probe short. */
  deadlineHit: boolean;
  /** Frames abstained by the per-frame sub-cap. */
  frameTimeouts: number;
  /** Always 0 in stage 1: the probe is model-free, the ceiling certifies it. */
  modelCalls: 0;
  /** Set when something inside threw; the probe reports instead of breaking. */
  error: string | null;
  freshness: FreshnessReport | null;
}

function emptyProbeReport(): ProbeReport {
  return {
    tracesSeen: 0,
    frames: 0,
    framesTotal: 0,
    poolTruncated: false,
    framesScored: 0,
    placements: [],
    abstainReasons: emptyReasons(),
    invalidated: 0,
    invalidatedAt: null,
    corpusStampId: '',
    evalMs: 0,
    deadlineHit: false,
    frameTimeouts: 0,
    modelCalls: 0,
    error: null,
    freshness: null,
  };
}

/** What one probe run shares between its steps. `report` fills in as the steps go. */
interface ProbeRun {
  store: Store;
  config: RookeryConfig;
  signal: AbortSignal;
  gain: GainFunction;
  costWeight: number;
  /** Wall-clock deadline in epoch ms. */
  deadline: number;
  /** Written to as the steps proceed, so a throw leaves everything measured so far. */
  report: ProbeReport;
}

/** The frames that passed the pre-checks, with every placement scored on each. */
interface ScoredPool {
  frames: RecordedFrame[];
  /** Per frame, the cluster the bootstrap draws it under (its session). */
  clusters: string[];
  /** Per frame, one result per placement, in grid order; shorter when the sub-cap cut it. */
  armsByFrame: MeasureResult[][];
  /** Abstentions every placement shares, counted once per frame. */
  preReasons: Record<AbstainReason, number>;
}

/**
 * One wall clock for the whole dream, not one per part (concept 6.1): where
 * the night hands its own deadline down, that is the ceiling. A pool cut into
 * pieces must not be able to buy itself a second budget, and the probe running
 * its own copy of `maxEvalMs` was exactly that - it could legally spend the
 * whole of it and leave the slot behind it starting past its deadline.
 */
function resolveDeadline(handed: number | undefined, startedAt: number, maxEvalMs: number): number {
  if (handed !== undefined && Number.isFinite(handed)) return handed;
  return startedAt + clampNumber(maxEvalMs, 0, MAX_EVAL_MS_CEILING);
}

/**
 * Load the night's pool. Frames this very night wrote are not measuring
 * material - a night never scores its own writes (in stage 1 it writes none,
 * but the exclusion is the reason the run id is a parameter at all).
 *
 * The pool cut is reported before anything that could throw: `framesFor`
 * walks oldest first, so a pool at the limit has dropped the newest frames -
 * the measurement covers fewer frames than exist, and the report says so
 * instead of hiding it.
 */
function loadPool(run: ProbeRun, owner: string, runId: string): RecordedFrame[] {
  const { store, report } = run;
  const pool = store.framesFor(owner, { limit: FRAME_POOL_LIMIT });
  report.framesTotal = store.dreamFrameCount(owner);
  report.poolTruncated = report.framesTotal > pool.length;
  const frames = pool.filter((entry) => entry.trace.sleepRunId !== runId);
  report.frames = frames.length;
  report.tracesSeen = new Set(frames.map((entry) => entry.trace.id)).size;
  return frames;
}

/**
 * The night's one corpus fingerprint, over the tokens of its own frames (R10):
 * the vocabulary scan walks the whole index, which is why it runs here and
 * never inside a turn. It also becomes the stamp the next day's turns carry.
 */
function stampNightCorpus(
  run: ProbeRun,
  owner: string,
  frames: readonly RecordedFrame[],
): FrameCorpus {
  const tokens = [...new Set(frames.flatMap((entry) => entry.frame.payload.query.tokens))];
  const corpus = run.store.corpusFingerprint(owner, tokens);
  run.report.corpusStampId = corpus.id;
  return corpus;
}

/** Score every placement of one frame's grid, stopping at the frame's sub-cap. */
function scoreGrid(
  run: ProbeRun,
  payload: RecallFrame,
  grid: readonly FrameScoringPolicy[],
  cutoff: number,
): MeasureResult[] {
  const { report } = run;
  const arms: MeasureResult[] = [];
  for (const placement of grid) {
    // The inner sub-cap: one frame may not eat the shared wall clock.
    if (Date.now() > cutoff) {
      report.frameTimeouts += 1;
      break;
    }
    const result = measure(payload, placement, run.gain, run.costWeight);
    report.framesScored += 1;
    if (!result.ok) report.abstainReasons[result.abstain] += 1;
    arms.push(result);
  }
  return arms;
}

/**
 * Pre-check and score the pool, oldest frame first, until it is exhausted,
 * aborted or out of wall clock. A frame a pre-check abstains is counted in
 * `preReasons` and in the report, and never scored.
 */
function scorePool(
  run: ProbeRun,
  frames: readonly RecordedFrame[],
  precheck: PrecheckContext,
  gridSize: number,
): ScoredPool {
  const { store, config, report } = run;
  const scored: ScoredPool = { frames: [], clusters: [], armsByFrame: [], preReasons: emptyReasons() };

  for (const entry of frames) {
    if (run.signal.aborted) break;
    const now = Date.now();
    if (now > run.deadline) {
      report.deadlineHit = true;
      break;
    }
    const payload = entry.frame.payload;

    const reason = precheckReason(store, entry, precheck);
    if (reason) {
      if (reason === 'corpus-invalidated') report.invalidated += 1;
      scored.preReasons[reason] += 1;
      report.abstainReasons[reason] += 1;
      continue;
    }

    scored.frames.push(entry);
    scored.clusters.push(entry.trace.sessionId ?? entry.trace.id);
    const policy = entry.trace.policySet.recall ?? resolvePolicy(store, config, entry.trace.owner, 'recall');
    const grid = buildGrid(policy, payload.box, gridSize);
    scored.armsByFrame.push(scoreGrid(run, payload, grid, frameDeadline(now, run.deadline)));
  }
  return scored;
}

/**
 * One placement's result paired against the incumbent of the SAME frame: both
 * arms come from one grid, so a delta is a within-frame comparison and never
 * a number against yesterday's incumbent.
 */
function placementReport(index: number, pool: ScoredPool): GridPlacementReport {
  const reasons = emptyReasons();
  addReasons(reasons, pool.preReasons);
  const deltas: number[] = [];
  const deltasBySession = new Map<string, number[]>();
  const coverages: number[] = [];
  let closed = 0;
  pool.armsByFrame.forEach((arms, frameIndex) => {
    const arm = arms[index];
    const base = arms[INCUMBENT_INDEX];
    if (!arm || !base) return;
    if (!arm.ok) {
      reasons[arm.abstain] += 1;
      return;
    }
    coverages.push(arm.coverage);
    if (!base.ok) return;
    closed += 1;
    if (index === INCUMBENT_INDEX) return;
    const delta = arm.score - base.score;
    deltas.push(delta);
    const session = pool.clusters[frameIndex] ?? '';
    const bucket = deltasBySession.get(session);
    if (bucket) bucket.push(delta);
    else deltasBySession.set(session, [delta]);
  });
  const interval = bootstrapCi([...deltasBySession.values()]);
  return {
    index,
    incumbent: index === INCUMBENT_INDEX,
    closed,
    delta: index === INCUMBENT_INDEX ? (closed > 0 ? 0 : null) : mean(deltas),
    ciLow: interval?.low ?? null,
    ciHigh: interval?.high ?? null,
    coverage: mean(coverages),
    abstainReasons: reasons,
  };
}

/**
 * Run the night's model-free evaluation: load the stored frames, score the
 * declared grid against each frame's own incumbent, aggregate paired per
 * trace, bootstrap over sessions, and run the freshness sensor over what
 * passed the pre-checks. Nothing is promoted, nothing but the nightly corpus
 * stamp is written (`corpusFingerprint`, the one meta write R10 prescribes),
 * nothing is thrown - the result is numbers plus their certificates.
 *
 * The pre-checks fire in a fixed order, and the order is the contract: an
 * unfinished trace first, then `corpus-invalidated` (older than a reindex or
 * bulk import - never guessed as drift), then `corpus-drifted` against the
 * night's fingerprint, then `budget-changed` against the config the turn
 * would render with today. `no-label-source` does not fire here because
 * stage 1 probes only the assistant's bank - the only owner whose replay
 * phase can ever earn a correction label.
 */
export function runGridProbe(
  store: Store,
  config: RookeryConfig,
  owner: string,
  runId: string,
  signal: AbortSignal,
  options: ProbeOptions = {},
): ProbeReport {
  // The abort guard is the first line: there is no #throwIfAborted between
  // the cycle-loop boundaries this call is wedged into (build plan, AP10).
  if (signal.aborted) return emptyProbeReport();

  const startedAt = Date.now();
  const report = emptyProbeReport();
  try {
    const dream = config.memory.dream;
    const deadline = resolveDeadline(options.deadline, startedAt, dream.maxEvalMs);
    // A budget that is switched off, or one the caller has already spent, is
    // a legitimate state and not an error: the probe reports nothing scored
    // and the night carries on (the wall-clock test).
    if (deadline <= startedAt) {
      report.deadlineHit = true;
      report.evalMs = Date.now() - startedAt;
      return report;
    }
    const run: ProbeRun = {
      store,
      config,
      signal,
      gain: options.gain ?? NO_GAIN,
      costWeight: clampNumber(dream.costWeight, 0, 1),
      deadline,
      report,
    };

    const frames = loadPool(run, owner, runId);
    const corpus = stampNightCorpus(run, owner, frames);
    const invalidatedAt = readInvalidatedAt(store);
    const precheck: PrecheckContext = {
      corpus,
      tolerance: clampNumber(dream.corpusTolerance, 0, 10),
      budget: expectedBudgetChars(config),
      invalidatedAt,
    };
    const pool = scorePool(run, frames, precheck, dream.gridSize);

    const placementCount = pool.frames.length ? gridCount(dream.gridSize) : 0;
    for (let index = 0; index < placementCount; index += 1) {
      report.placements.push(placementReport(index, pool));
    }

    // The freshness sensor over what passed the pre-checks, inside the same
    // wall clock. Its default arms are each frame's own incumbent and first
    // non-incumbent placement - deterministic, and in-box by construction.
    if (pool.frames.length) {
      report.freshness = freshnessCheck(store, pool.frames, {
        config,
        gain: run.gain,
        costWeight: run.costWeight,
        deadline,
        signal,
      });
    }
    if (Date.now() > deadline) report.deadlineHit = true;
    if (report.invalidated > 0 && invalidatedAt > 0) report.invalidatedAt = invalidatedAt;
    report.evalMs = Date.now() - startedAt;
    return report;
  } catch (cause) {
    // `ask` never throws and neither does the probe: an internal failure is
    // reported, and the night goes on (the corrupted-payload test).
    report.error = (cause as Error).message;
    report.evalMs = Date.now() - startedAt;
    return report;
  }
}

