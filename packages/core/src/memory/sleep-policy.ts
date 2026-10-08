import type { RecallPolicy } from '../types.js';
import type { FrameScoringPolicy } from './dream/score.js';

/** Every field of a proposed point comes from the dream, by construction. */
const DREAM_ORIGIN: RecallPolicy['origin'] = {
  limit: 'dream',
  threshold: 'dream',
  hopEntity: 'dream',
  hopEdge: 'dream',
  relevance: 'dream',
  importance: 'dream',
  recency: 'dream',
  usage: 'dream',
};

/**
 * A grid placement is a point, not a policy: it carries the four weights and
 * the four knobs and nothing else. `kinds` and `minImportance` come from the
 * incumbent, because they are SQL filters rather than scoring terms and
 * widening either would admit rows the frame never fetched (concept 3.4).
 */
export function liftPolicy(placement: FrameScoringPolicy, incumbent: RecallPolicy): RecallPolicy {
  return {
    limit: Math.round(placement.limit ?? incumbent.limit),
    threshold: placement.threshold ?? incumbent.threshold,
    w: placement.w ?? incumbent.w,
    hopEntity: placement.hopEntity ?? incumbent.hopEntity,
    hopEdge: placement.hopEdge ?? incumbent.hopEdge,
    kinds: incumbent.kinds,
    minImportance: incumbent.minImportance,
    origin: DREAM_ORIGIN,
  };
}

/**
 * The `params` blob a promoted version stores, in exactly the shape
 * `resolvePolicy` reads back (`POLICY_FIELDS`, dream/promote.ts). A key the
 * resolver never looks at could not change behaviour and does not belong in
 * a version row.
 */
export function paramsOf(policy: FrameScoringPolicy, incumbent: RecallPolicy): Record<string, unknown> {
  const point = liftPolicy(policy, incumbent);
  return {
    limit: point.limit,
    threshold: point.threshold,
    hopEntity: point.hopEntity,
    hopEdge: point.hopEdge,
    w: { ...point.w },
  };
}

/** A stored `params` blob back to a policy point, or null if it cannot be read. */
export function policyFromParams(
  params: Record<string, unknown>,
  incumbent: RecallPolicy,
): RecallPolicy | null {
  const read = (source: Record<string, unknown> | undefined, key: string): number | null => {
    const value = source?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const weights = params.w;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return null;
  const w = weights as Record<string, unknown>;

  const limit = read(params, 'limit');
  const threshold = read(params, 'threshold');
  const hopEntity = read(params, 'hopEntity');
  const hopEdge = read(params, 'hopEdge');
  const relevance = read(w, 'relevance');
  const importance = read(w, 'importance');
  const recency = read(w, 'recency');
  const usage = read(w, 'usage');
  if (
    limit === null || threshold === null || hopEntity === null || hopEdge === null ||
    relevance === null || importance === null || recency === null || usage === null
  ) {
    return null;
  }
  return {
    limit: Math.round(limit),
    threshold,
    w: { relevance, importance, recency, usage },
    hopEntity,
    hopEdge,
    kinds: incumbent.kinds,
    minImportance: incumbent.minImportance,
    origin: DREAM_ORIGIN,
  };
}
