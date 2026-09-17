import { DEFAULT_CONFIG } from '../../config.js';
import type { PolicyOrigin, RecallPolicy, RookeryConfig } from '../../types.js';
import type { Store } from '../store.js';
import { WEIGHTS } from '../recall.js';

/**
 * The one truth about the recall parameters (dream stage 1, concept 9.3).
 *
 * Before this function existed, two effective policies lived in one code
 * base: the assistant path hands `hopEntity`/`hopEdge` from
 * `config.memory.graph` into `recall`, the agent path does not and silently
 * runs on the literals in recall.ts. The values happen to be equal, so
 * nobody noticed - until a promotion changes the config and one path keeps
 * running on the factory setting. Stage 1 wires the assistant path through
 * here (runtime.ts, AP9); the agent call in org/controller.ts deliberately
 * keeps its raw config read, because rerouting it would change behaviour
 * whenever `memory.graph` deviates - outside the two declared exceptions of
 * the stage (R15). So today this is one truth for the assistant, not yet
 * for both: the agent path joins when a stage is allowed to move it.
 *
 * Stage 1 has no promoted version, so the weights are always the incumbent
 * literals from recall.ts with origin 'default'. The one classification the
 * concept does demand now: a config value that deviates from its factory
 * default is 'user', never 'default' - otherwise a later promotion would
 * quietly override a knob the user set, or the settings page would lie about
 * a value the dream moved.
 *
 * `rookery config set` bypasses the zod patch schema entirely, so every value
 * is clamped here at read time (E21), never trusted because it was written.
 */

const FACTORY = DEFAULT_CONFIG.memory;

/** Clamp to the same range the server's patch schema enforces, and no wider. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function originOf(effective: number, factory: number): PolicyOrigin {
  return effective !== factory ? 'user' : 'default';
}

/**
 * Resolve the effective recall policy for one owner and slot.
 *
 * The `store`, `owner` and `slot` parameters are the Phase 3 hooks: that is
 * where a promoted `policy_versions` row will be looked up per owner and
 * slot. Stage 1 always answers from the config and the factory literals,
 * which is itself the fix - one answer instead of two.
 */
export function resolvePolicy(
  store: Store,
  config: RookeryConfig,
  owner: string,
  slot: 'recall',
): RecallPolicy {
  // The clamps mirror the server's memory patch schema (recallLimit an int
  // in 0..50, recallThreshold in 0..1). The hop weights have no patch schema
  // because memory.graph is not settable over HTTP; they are weights, so
  // 0..1 is the honest range.
  const limit = clamp(Math.round(config.memory.recallLimit), 0, 50);
  const threshold = clamp(config.memory.recallThreshold, 0, 1);
  const hopEntity = clamp(config.memory.graph.hopEntity, 0, 1);
  const hopEdge = clamp(config.memory.graph.hopEdge, 0, 1);

  return {
    limit,
    threshold,
    w: {
      relevance: clamp(WEIGHTS.relevance, 0, 1),
      importance: clamp(WEIGHTS.importance, 0, 1),
      recency: clamp(WEIGHTS.recency, 0, 1),
      usage: clamp(WEIGHTS.usage, 0, 1),
    },
    hopEntity,
    hopEdge,
    kinds: [],
    minImportance: 0,
    origin: {
      limit: originOf(limit, FACTORY.recallLimit),
      threshold: originOf(threshold, FACTORY.recallThreshold),
      hopEntity: originOf(hopEntity, FACTORY.graph.hopEntity),
      hopEdge: originOf(hopEdge, FACTORY.graph.hopEdge),
      relevance: 'default',
      importance: 'default',
      recency: 'default',
      usage: 'default',
    },
  };
}
