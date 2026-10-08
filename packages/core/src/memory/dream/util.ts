import type { AbstainReason, FrameCorpus, RookeryConfig } from '../../types.js';
import type { Store } from '../store.js';
import type { GainFunction } from './measure.js';

/**
 * Small helpers the dream stages share. Each one used to be copied into every
 * module that needed it; a statistical gate must not be able to drift apart
 * from its twin because one copy was edited.
 */

/** Mirrors the prefix `Store` writes corpus stamps under (store.ts, AP7); read-only here. */
export const CORPUS_STAMP_PREFIX = 'dream.corpus_stamp.';

/**
 * Inner sub-cap of `dream.maxEvalMs`: the processing of a single frame is cut
 * off after this many milliseconds and the frame is abstained - no monstrous
 * frame may eat the shared wall clock on its own (build plan, AP10).
 */
export const FRAME_TIME_LIMIT_MS = 2000;

/** Every reason a frame can go unscored, zeroed - counted, never swallowed. */
export const ABSTAIN_REASONS: readonly AbstainReason[] = [
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

export function emptyReasons(): Record<AbstainReason, number> {
  const reasons = {} as Record<AbstainReason, number>;
  for (const reason of ABSTAIN_REASONS) reasons[reason] = 0;
  return reasons;
}

/**
 * Clamp to a range, for dream keys read outside the patch schema (E21/S23).
 * A non-finite value falls to `lo`: a key that cannot be read as a number
 * takes the most conservative end of its range.
 */
export function clampNumber(value: number, lo: number, hi: number): number {
  const safe = Number.isFinite(value) ? value : lo;
  return Math.min(hi, Math.max(lo, safe));
}

/** The budget the assistant turn renders with; mirrors runtime.ts (AP9). */
export function expectedBudgetChars(config: RookeryConfig): number {
  return Math.floor(config.memory.contextBudget * 0.4);
}

/**
 * The corpus stamp a frame was recorded under, read from `meta`. An empty id -
 * a frame recorded before any night stamped a fingerprint - and a corrupted
 * row both return null: a stamp that cannot be read certifies nothing, and
 * the drift check is waived rather than guessed.
 */
export function readCorpusStamp(store: Store, id: string): FrameCorpus | null {
  if (!id) return null;
  const raw = store.getMeta(CORPUS_STAMP_PREFIX + id);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FrameCorpus;
  } catch {
    return null;
  }
}

/** Arithmetic mean, summed left to right; `null` for no values (never 0, never NaN). */
export function mean(values: readonly number[]): number | null {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * When the frame that starts at `now` must be done: the shared wall-clock
 * `deadline`, if any, but never later than `FRAME_TIME_LIMIT_MS` from now.
 */
export function frameDeadline(now: number, deadline: number | undefined): number {
  const limit = now + FRAME_TIME_LIMIT_MS;
  return deadline === undefined ? limit : Math.min(deadline, limit);
}

/** The honest empty gain: no label is known, so every frame abstains `no-reachable-label`. */
export const NO_GAIN: GainFunction = () => 0;
