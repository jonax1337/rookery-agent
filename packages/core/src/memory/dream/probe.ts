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

/** How many stored frames one night walks, oldest first (the store default). */
const FRAME_POOL_LIMIT = 500;
/**
 * Inner sub-cap of `dream.maxEvalMs`: the processing of a single frame is cut
 * off after this many milliseconds and the frame is abstained - no monstrous
 * frame may eat the shared wall clock on its own (build plan, AP10).
 */
const FRAME_TIME_LIMIT_MS = 2000;
/** Cluster-bootstrap draws over sessions, percentile interval 2.5/97.5. */
const BOOTSTRAP_B = 2000;
/** Fixed seed: the interval must be reproducible, never per-run random. */
const BOOTSTRAP_SEED = 20260917;
/**
 * Below this |delta| a sign flip between the frozen and the live world is not
 * a finding. The concept's `dream.margin` key belongs to Phase 3's gate and
 * has no reader in stage 1 (R16), so the probe carries the literal.
 */
const FRESHNESS_MARGIN = 0.02;
/** Mirrors the prefix `Store` writes corpus stamps under (store.ts, AP7). */
const CORPUS_STAMP_PREFIX = 'dream.corpus_stamp.';
/** Written by `reindex` and the bulk import (db.ts, AP1); read here. */
const CORPUS_INVALIDATED_KEY = 'dream.corpus_invalidated_at';
/** The grid the stage prescribes: at least 8, at most 12 placements. */
const GRID_MIN = 8;
const GRID_MAX = 12;

/** Every reason a frame can go unscored, zeroed - counted, never swallowed. */
const ABSTAIN_REASONS: readonly AbstainReason[] = [
  'limit-out-of-box',
  'seeds-capped',
  'degraded-turn',
  'frame-missing',
  'corpus-drifted',
  'corpus-invalidated',
  'budget-changed',
  'no-reachable-label',
  'no-labelled-move',
  'pipeline-mismatch',
  'no-label-source',
  'unfinished',
];

function emptyReasons(): Record<AbstainReason, number> {
  const reasons = {} as Record<AbstainReason, number>;
  for (const reason of ABSTAIN_REASONS) reasons[reason] = 0;
  return reasons;
}

function addReasons(target: Record<AbstainReason, number>, source: Record<AbstainReason, number>): void {
  for (const reason of ABSTAIN_REASONS) target[reason] += source[reason] ?? 0;
}

/** Clamp to a range, for dream keys read outside the patch schema (E21). */
function clampNumber(value: number, lo: number, hi: number): number {
  const safe = Number.isFinite(value) ? value : lo;
  return Math.min(hi, Math.max(lo, safe));
}

/**
 * The corpus stamp a frame was recorded under, read from `meta`. The prefix
 * mirrors the writer in store.ts (AP7 owns it; this module only reads). An
 * empty id - a frame recorded before any night stamped a fingerprint - and a
 * corrupted row both return null: a stamp that cannot be read certifies
 * nothing, and the drift check is waived rather than guessed.
 */
function stampById(store: Store, id: string): FrameCorpus | null {
  if (!id) return null;
  const raw = store.getMeta(CORPUS_STAMP_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FrameCorpus;
  } catch {
    return null;
  }
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
  const pick = (corner: Corner, interval: Interval, value: number): number =>
    cornerValue(corner, interval, value);
  switch (choice) {
    case 'incumbent':
      return {
        relevance: pick('incumbent', w.relevance, p.relevance),
        importance: pick('incumbent', w.importance, p.importance),
        recency: pick('incumbent', w.recency, p.recency),
        usage: pick('incumbent', w.usage, p.usage),
      };
    case 'lo':
    case 'hi':
    case 'mid':
      return {
        relevance: pick(choice, w.relevance, p.relevance),
        importance: pick(choice, w.importance, p.importance),
        recency: pick(choice, w.recency, p.recency),
        usage: pick(choice, w.usage, p.usage),
      };
    case 'relevance-heavy':
      // Trust the text match, nothing else.
      return { relevance: w.relevance[1], importance: w.importance[0], recency: w.recency[0], usage: w.usage[0] };
    case 'context-heavy':
      // Trust what the bank claims about itself over the query.
      return { relevance: w.relevance[0], importance: w.importance[1], recency: w.recency[1], usage: w.usage[0] };
    case 'usage-off':
      // Close the usage channel entirely (H2 lives on it) and stay aggressive.
      return { relevance: w.relevance[1], importance: w.importance[1], recency: (w.recency[0] + w.recency[1]) / 2, usage: w.usage[0] };
  }
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
  const count = Number.isFinite(size) ? Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(size))) : 10;
  const limit = Math.max(0, Math.min(policy.limit, box.limitMax));
  return GRID.slice(0, count).map((spec) => ({
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
  const low = means[Math.min(means.length - 1, Math.floor(0.025 * means.length))]!;
  const high = means[Math.max(0, Math.min(means.length - 1, Math.ceil(0.975 * means.length) - 1))]!;
  return { low, high: Math.max(high, low) };
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
  entries: readonly { trace: DreamTrace; frame: DreamFrame }[],
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

  const gain = options.gain;
  const frozenDeltas: number[] = [];
  const liveDeltas: number[] = [];
  let rowsDiffer = 0;
  let compared = 0;

  for (const entry of entries) {
    if (options.signal?.aborted) break;
    const now = Date.now();
    if (options.deadline !== undefined && now > options.deadline) break;
    const frameDeadline =
      options.deadline !== undefined
        ? Math.min(options.deadline, now + FRAME_TIME_LIMIT_MS)
        : now + FRAME_TIME_LIMIT_MS;

    const payload = entry.frame.payload;
    const policy =
      entry.trace.policySet.recall ??
      resolvePolicy(store, options.config, entry.trace.owner, 'recall');
    const grid = buildGrid(policy, payload.box, GRID_MIN);
    const baseline = options.baseline ?? grid[0]!;
    const candidate = options.candidate ?? grid[1]!;

    // The live re-fetch. A MATCH the parser rejects degrades inside the
    // frame (three worlds, not two); anything else that throws skips this
    // frame's live side as `frame-missing` rather than breaking the night.
    let fresh: RecallFrame | null = null;
    try {
      fresh = fetchFrame(store, {
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
      fresh = null;
    }

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

    // A frame past its sub-cap is abstained: no monstrous frame may eat the
    // shared wall clock on its own.
    if (Date.now() > frameDeadline) {
      report.frameTimeouts += 1;
      report.entries.push(entryOut);
      continue;
    }

    const frozenBase = measure(payload, baseline, gain, options.costWeight);
    const frozenCand = measure(payload, candidate, gain, options.costWeight);
    if (!frozenBase.ok) report.abstainReasons[frozenBase.abstain] += 1;
    if (!frozenCand.ok) report.abstainReasons[frozenCand.abstain] += 1;
    if (frozenBase.ok && frozenCand.ok) {
      entryOut.frozenDelta = frozenCand.score - frozenBase.score;
      report.closedFrozen += 1;
    }

    if (fresh) {
      const liveBase = measure(fresh, baseline, gain, options.costWeight);
      const liveCand = measure(fresh, candidate, gain, options.costWeight);
      if (!liveBase.ok) report.abstainReasons[liveBase.abstain] += 1;
      if (!liveCand.ok) report.abstainReasons[liveCand.abstain] += 1;
      if (liveBase.ok && liveCand.ok) {
        entryOut.liveDelta = liveCand.score - liveBase.score;
        report.closedLive += 1;
      }
    }

    if (entryOut.frozenDelta !== null && entryOut.liveDelta !== null) {
      report.closedBoth += 1;
      frozenDeltas.push(entryOut.frozenDelta);
      liveDeltas.push(entryOut.liveDelta);
    }
    report.entries.push(entryOut);
  }

  const mean = (values: number[]): number | null =>
    values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
  report.deltaFrozen = mean(frozenDeltas);
  report.deltaLive = mean(liveDeltas);
  report.rowsDifferShare = compared ? rowsDiffer / compared : 0;
  if (report.deltaFrozen !== null && report.deltaLive !== null) {
    if (Math.abs(report.deltaFrozen) <= FRESHNESS_MARGIN) report.signAgree = null;
    else {
      const frozenSign = Math.sign(report.deltaFrozen);
      const liveSign = Math.sign(report.deltaLive);
      report.signAgree = frozenSign === liveSign ? 1 : 0;
    }
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

/** The budget the assistant turn renders with; mirrors runtime.ts (AP9). */
function expectedBudgetChars(config: RookeryConfig): number {
  return Math.floor(config.memory.contextBudget * 0.4);
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
  const state: ProbeReport = emptyProbeReport();
  try {
    const dream = config.memory.dream;
    const maxEvalMs = clampNumber(dream.maxEvalMs, 0, 3_600_000);
    // A zero budget is a legitimate off state, not an error: the probe
    // reports nothing scored and the night carries on (the wall-clock test).
    if (maxEvalMs <= 0) {
      state.deadlineHit = true;
      state.evalMs = Date.now() - startedAt;
      return state;
    }
    const deadline = startedAt + maxEvalMs;
    const gain = options.gain ?? ((): number => 0);
    const costWeight = clampNumber(dream.costWeight, 0, 1);
    const tolerance = clampNumber(dream.corpusTolerance, 0, 10);

    // Frames this very night wrote are not measuring material - a night
    // never scores its own writes (in stage 1 it writes none, but the
    // exclusion is the reason the run id is a parameter at all).
    const entries = store
      .framesFor(owner, { limit: FRAME_POOL_LIMIT })
      .filter((entry) => entry.trace.sleepRunId !== runId);
    state.frames = entries.length;
    state.tracesSeen = new Set(entries.map((entry) => entry.trace.id)).size;

    // The night's one corpus fingerprint, over the tokens of its own frames
    // (R10): the vocabulary scan walks the whole index, which is why it runs
    // here and never inside a turn. It also becomes the stamp the next day's
    // turns carry.
    const corpus = store.corpusFingerprint(
      owner,
      [...new Set(entries.flatMap((entry) => entry.frame.payload.query.tokens))],
    );
    state.corpusStampId = corpus.id;
    const invalidatedAt = readInvalidatedAt(store);
    const budget = expectedBudgetChars(config);

    const preReasons = emptyReasons();
    const eligible: { trace: DreamTrace; frame: DreamFrame }[] = [];
    const clusters: string[] = [];
    const grids: FrameScoringPolicy[][] = [];
    const armsByFrame: { placement: number; result: MeasureResult }[][] = [];

    for (const entry of entries) {
      if (signal.aborted) break;
      const now = Date.now();
      if (now > deadline) {
        state.deadlineHit = true;
        break;
      }
      const frameDeadline = Math.min(deadline, now + FRAME_TIME_LIMIT_MS);
      const payload = entry.frame.payload;

      let reason: AbstainReason | null = null;
      if (!entry.trace.finishedAt) reason = 'unfinished';
      else if (invalidatedAt > 0 && entry.frame.createdAt < invalidatedAt) {
        reason = 'corpus-invalidated';
        state.invalidated += 1;
      } else if (
        corpusDrifted(payload, corpus, tolerance, stampById(store, payload.corpusStampId))
      ) {
        reason = 'corpus-drifted';
      } else if (payload.pipeline === 'assistant' && payload.budgetChars !== budget) {
        reason = 'budget-changed';
      }

      if (reason) {
        preReasons[reason] += 1;
        state.abstainReasons[reason] += 1;
        continue;
      }

      eligible.push(entry);
      clusters.push(entry.trace.sessionId ?? entry.trace.id);
      const policy = entry.trace.policySet.recall ?? resolvePolicy(store, config, owner, 'recall');
      const grid = buildGrid(policy, payload.box, dream.gridSize);
      grids.push(grid);

      const arms: { placement: number; result: MeasureResult }[] = [];
      for (let index = 0; index < grid.length; index += 1) {
        // The inner sub-cap: one frame may not eat the shared wall clock.
        if (Date.now() > frameDeadline) {
          state.frameTimeouts += 1;
          break;
        }
        const result = measure(payload, grid[index]!, gain, costWeight);
        state.framesScored += 1;
        if (!result.ok) state.abstainReasons[result.abstain] += 1;
        arms.push({ placement: index, result });
      }
      armsByFrame.push(arms);
    }

    // Aggregate per placement, paired against the incumbent of the SAME
    // frame: both arms come from one grid, so a delta is a within-frame
    // comparison and never a number against yesterday's incumbent.
    const placementCount = grids[0]?.length ?? 0;
    for (let index = 0; index < placementCount; index += 1) {
      const ownReasons = emptyReasons();
      addReasons(ownReasons, preReasons);
      const deltas: { cluster: string; value: number }[] = [];
      const coverages: number[] = [];
      let closed = 0;
      for (let entryIndex = 0; entryIndex < eligible.length; entryIndex += 1) {
        const arms = armsByFrame[entryIndex] ?? [];
        const arm = arms.find((candidate) => candidate.placement === index);
        const base = arms.find((candidate) => candidate.placement === 0);
        if (!arm || !base) continue;
        if (!arm.result.ok) {
          ownReasons[arm.result.abstain] += 1;
          continue;
        }
        coverages.push(arm.result.coverage);
        if (base.result.ok) {
          closed += 1;
          if (index > 0) {
            deltas.push({
              cluster: clusters[entryIndex] ?? '',
              value: arm.result.score - base.result.score,
            });
          }
        }
      }
      const grouped = new Map<string, number[]>();
      for (const delta of deltas) {
        const bucket = grouped.get(delta.cluster);
        if (bucket) bucket.push(delta.value);
        else grouped.set(delta.cluster, [delta.value]);
      }
      const ci =
        index === 0 || !deltas.length ? null : bootstrapCi([...grouped.values()]);
      state.placements.push({
        index,
        incumbent: index === 0,
        closed,
        delta:
          index === 0
            ? closed > 0
              ? 0
              : null
            : deltas.length
              ? deltas.reduce((total, delta) => total + delta.value, 0) / deltas.length
              : null,
        ciLow: ci?.low ?? null,
        ciHigh: ci?.high ?? null,
        coverage: coverages.length
          ? coverages.reduce((total, value) => total + value, 0) / coverages.length
          : null,
        abstainReasons: ownReasons,
      });
    }

    // The freshness sensor over what passed the pre-checks, inside the same
    // wall clock. Its default arms are each frame's own incumbent and first
    // non-incumbent placement - deterministic, and in-box by construction.
    if (eligible.length) {
      state.freshness = freshnessCheck(store, eligible, {
        config,
        gain,
        costWeight,
        deadline,
        signal,
      });
    }
    if (Date.now() > deadline) state.deadlineHit = true;
    if (state.invalidated > 0 && invalidatedAt > 0) state.invalidatedAt = invalidatedAt;
    state.evalMs = Date.now() - startedAt;
    return state;
  } catch (cause) {
    // `ask` never throws and neither does the probe: an internal failure is
    // reported, and the night goes on (the corrupted-payload test).
    state.error = (cause as Error).message;
    state.evalMs = Date.now() - startedAt;
    return state;
  }
}

