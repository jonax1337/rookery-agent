import { DEFAULT_CONFIG } from '../../config.js';
import type {
  AbstainReason,
  MemoryRecordSnapshot,
  RecallFrame,
  RecallWeights,
  ScoredMemory,
} from '../../types.js';
import { byScoreThenId } from '../recall.js';
import { groupFromFrame, pipelineAgent, pipelineAssistant, type FrameScoringPolicy } from './score.js';

/**
 * The block measure (dream stage 1, AP8; concept 5.2).
 *
 * What is measured is not what `recall` returned but what the model read: the
 * ordered list of memories whose lines fit the rendered block, produced by the
 * pipeline the frame belongs to. Between the return value and the prompt sit
 * the profile merge, the contradiction drop, the entity grouping and the
 * break-not-continue budget - a candidate can look equal on the return value
 * and be strictly worse on the block, and only the block is the truth.
 *
 * > Dieses Mass ist eine untere Schranke, kein Punktschaetzer. Eine
 * > Erinnerung bekommt nur ueber Kanaele ein Etikett, die voraussetzen, dass
 * > der Amtsinhaber sie hochgespuelt hat. Ein Kandidat, der eine andere,
 * > wirklich bessere Erinnerung holt, bekommt dafuer gain = 0, weil sie nie
 * > jemand etikettiert hat. Die Abdeckungsrate wird je Bewertung berichtet,
 * > und ein Delta, das ueberwiegend aus unetikettierten Positionen stammt,
 * > ist ungueltig.
 *
 * Four decisions carried in the arithmetic (concept 5.2):
 *
 * - The ideal is frame-relative. A label whose target the hop-1 SQL excludes
 *   (`superseded_by`, forgotten, dormant, archived, another owner) is out of
 *   the ideal for every candidate alike, and the trace reports it through
 *   `reachableRate` instead of compressing every delta.
 * - The ideal is rendered with THE SAME renderer as P, under the same
 *   character budget (R14). A flat denominator would hand entity-concentrated
 *   candidates a structural advantage that has nothing to do with relevance:
 *   the grouped renderer writes one header line per group and two indent
 *   characters per entry, and the ideal pays exactly what P pays.
 * - Sum, never ratio. "Hits per character" is won by a guaranteed-relevant
 *   profile row and nothing else; halving the hits and the characters must
 *   change the value (the scale-invariance test).
 * - `gain` is a parameter, not a query. Stage 1 has no label writer, and there
 *   must be none before Phase 2 builds the sources (`dream_labels` waits as an
 *   empty table). The caller supplies the gain; the measure stays pure.
 */

/** The label value of one memory for the traced turn, in [0,1]; 0 is no gain. */
export type GainFunction = (memoryId: string) => number;

/** What `measure` answers: the score with its parts, or an abstention. */
export type MeasureResult =
  | {
      ok: true;
      /** nDCG minus the cost term; comparable only within the same frame. */
      score: number;
      /** DCG(P) / DCG(Ideal), both over renderer-truncated lists. */
      ndcg: number;
      /** Used characters over `frame.budgetChars`, clamped to [0,1]. */
      chars: number;
      /**
       * Share of P's positions the gain function knows a label for. A label
       * that asserts irrelevance (gain exactly 0) is indistinguishable from no
       * label under a gain function, so this is a lower bound on the true
       * label coverage; the probe reports the source's own rate alongside.
       */
      coverage: number;
      /**
       * Share of labelled targets in the frame that no policy could ever
       * deliver again (superseded, forgotten, dormant, archived, foreign
       * owner). Targets outside the frame's records are invisible to a gain
       * function; the probe accounts for those itself.
       */
      reachableRate: number;
    }
  | { ok: false; abstain: AbstainReason };

/** One position that differs between two arms of a comparison (R2). */
export interface DeltaPosition {
  id: string;
  /** Whether any label could exist for this memory in the session window. */
  labelPossible: boolean;
}

/**
 * Positional discount over a rendered list: sum of gain / log2(position + 1),
 * one-based, so the first line pays no discount.
 */
function dcg(gains: number[]): number {
  let sum = 0;
  for (let index = 0; index < gains.length; index += 1) {
    sum += (gains[index] ?? 0) / Math.log2(index + 2);
  }
  return sum;
}

/**
 * Normalise a weight vector to sum 1 (R13).
 *
 * The threshold that rides these weights must be divided by the same divisor;
 * `scoreFrame` does that inline on the live path, and Phase 3's gate calls
 * this function and applies the divisor to the threshold the same way. For the
 * incumbent weights this is a null step: 0.55 + 0.2 + 0.15 + 0.1 is exactly
 * 1.00 in the summation order used here (the same order `scoreFrame` sums in,
 * so a replay and the live path stay bit-equal).
 */
export function normaliseWeights(w: RecallWeights): RecallWeights {
  const divisor = w.relevance + w.importance + w.recency + w.usage;
  if (divisor === 1) return w;
  // A box keeps the lower weight bounds positive; the guard only keeps the
  // arithmetic finite for a degenerate vector no recorder would declare.
  const safe = divisor > 0 ? divisor : 1;
  return {
    relevance: w.relevance / safe,
    importance: w.importance / safe,
    recency: w.recency / safe,
    usage: w.usage / safe,
  };
}

/**
 * The H9 predicate (R13): is `a` a positive scalar multiple of `b`?
 *
 * A candidate whose whole weight vector is a positive multiple of another
 * changes nothing - the score is linear in the weights and the threshold
 * scales with the same factor - so the gate must refuse it as an illusion of
 * change. Works over any named numeric vector, so it also answers for grids
 * built from box corners. Key sets must match; the reference coordinate is
 * the largest-magnitude entry of `b`; a zero `b` has no multiple.
 */
export function isScalarMultiple(
  a: Record<string, number>,
  b: Record<string, number>,
  eps = 1e-9,
): boolean {
  const keys = Object.keys(b);
  const first = keys[0];
  if (!first || keys.length !== Object.keys(a).length) return false;
  for (const key of keys) if (!(key in a)) return false;

  let reference = first;
  for (const key of keys) {
    if (Math.abs(b[key] ?? 0) > Math.abs(b[reference] ?? 0)) reference = key;
  }
  const referenceValue = b[reference] ?? 0;
  if (referenceValue === 0) return false;

  const scale = (a[reference] ?? 0) / referenceValue;
  if (!Number.isFinite(scale) || scale <= 0) return false;
  for (const key of keys) {
    const observed = a[key] ?? 0;
    const expected = scale * (b[key] ?? 0);
    if (Math.abs(observed - expected) > eps * Math.max(1, Math.abs(observed), Math.abs(expected))) {
      return false;
    }
  }
  return true;
}

/**
 * Whether a delta is label-backed (R2): a delta that is predominantly
 * positions no label could ever exist for is not a delta - it is noise the
 * cost term dresses up as change. Stage 1 reports this; the gate of Phase 3
 * enforces it. An empty delta is backed vacuously (the separate
 * `no-labelled-move` accounting covers arms that moved nothing labelled).
 */
export function deltaIsLabelBacked(positions: readonly DeltaPosition[]): boolean {
  if (!positions.length) return true;
  const possible = positions.filter((position) => position.labelPossible).length;
  return possible > positions.length / 2;
}

/**
 * Whether any policy inside the box could ever deliver this frozen row: the
 * hop-1 SQL, the profile SQL and the second hop's `offer` all hard-filter
 * forgotten, dormant, superseded and archived rows, and both hops keep to one
 * bank. A labelled target that fails this is unreachable for every candidate
 * alike - it leaves the ideal and shows up in `reachableRate`.
 */
function deliverable(record: MemoryRecordSnapshot, owner: string): boolean {
  return (
    record.owner === owner &&
    !record.forgotten &&
    !record.dormantAt &&
    !record.supersededBy &&
    !record.archivedAt
  );
}

/**
 * The renderer's truncation with its by-product: which memories' lines fit,
 * in prompt order. Branch-for-branch the loop `renderFrameBlock` walks in
 * dream/score.ts - same `groupFromFrame`, same line formats, same
 * break-not-continue - because the ideal must be cut by the renderer P was
 * cut by, not by a second opinion (R14). `measure` sends only the ideal
 * through here; P itself is whatever the real pipeline kept.
 */
function renderIncluded(
  frame: RecallFrame,
  memories: ScoredMemory[],
  budget: number,
  flat: boolean,
): ScoredMemory[] {
  if (!memories.length) return [];
  const included: ScoredMemory[] = [];
  let used = 0;
  const push = (line: string, memory?: ScoredMemory): boolean => {
    if (used + line.length > budget) return false;
    if (memory) included.push(memory);
    used += line.length + 1;
    return true;
  };

  const groups = flat ? null : groupFromFrame(frame, memories);
  if (groups && groups.grouped.length) {
    for (const group of groups.grouped) {
      if (!push(group.entity.name + ':')) break;
      let full = false;
      for (const memory of group.memories) {
        if (!push('  - (' + memory.kind + ') ' + memory.content, memory)) {
          full = true;
          break;
        }
      }
      if (full) break;
    }
    for (const memory of groups.loose) {
      if (!push('- (' + memory.kind + ') ' + memory.content, memory)) break;
    }
  } else {
    for (const memory of memories) {
      if (!push('- (' + memory.kind + ') ' + memory.content, memory)) break;
    }
  }
  return included;
}

/**
 * Score one frame at one policy point against a caller-supplied gain
 * (concept 5.2). P is the pipeline's own kept-lines list - never rebuilt
 * here - and the ideal is the frame's reachable, deliverable, positively
 * labelled rows in gain order, cut by the same renderer under the same
 * budget. Abstains with the pipeline's reason when the pipeline abstains
 * (a degraded turn is not a legitimate miss; a limit outside the box is a
 * recorder error), and with `no-reachable-label` when DCG(Ideal) is 0.
 */
export function measure(
  frame: RecallFrame,
  policy: FrameScoringPolicy,
  gain: GainFunction,
  costWeight?: number,
): MeasureResult {
  const lambda = costWeight ?? DEFAULT_CONFIG.memory.dream.costWeight;
  const run =
    frame.pipeline === 'agent' ? pipelineAgent(frame, policy) : pipelineAssistant(frame, policy);
  if (!run.ok) return { ok: false, abstain: run.reason };

  // The ideal: labelled rows of the reachable set that a policy could still
  // deliver, gain-descending with the R11 tie-break (the score IS the gain on
  // this list, so `byScoreThenId` is exactly that order).
  const ideal: ScoredMemory[] = [];
  let labelledInFrame = 0;
  let reachableLabels = 0;
  for (const record of Object.values(frame.records)) {
    if (gain(record.id) <= 0) continue;
    labelledInFrame += 1;
    if (!deliverable(record, frame.owner)) continue;
    reachableLabels += 1;
    ideal.push({ ...record, score: gain(record.id), hop: 'direct', reason: 'ideal' });
  }
  ideal.sort(byScoreThenId);

  const idealKept = renderIncluded(frame, ideal, frame.budgetChars, frame.pipeline === 'agent');
  const idcg = dcg(idealKept.map((memory) => gain(memory.id)));
  if (idcg === 0) return { ok: false, abstain: 'no-reachable-label' };

  const dcgOfP = dcg(run.lines.map((memory) => gain(memory.id)));
  const ndcg = dcgOfP / idcg;
  // The block as delivered, wrapper included: the whole string went into the
  // prompt, and the wrapper is constant within a frame, so paired deltas on
  // the same frame are unaffected by it.
  const chars = Math.min(1, run.block.length / frame.budgetChars);
  const coverage = run.lines.length
    ? run.lines.filter((memory) => gain(memory.id) > 0).length / run.lines.length
    : 0;

  return {
    ok: true,
    score: ndcg - lambda * chars,
    ndcg,
    chars,
    coverage,
    reachableRate: labelledInFrame ? reachableLabels / labelledInFrame : 1,
  };
}
