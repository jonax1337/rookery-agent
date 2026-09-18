import { DEFAULT_CONFIG } from '../../config.js';
import type { PolicyOrigin, RecallPolicy, RookeryConfig } from '../../types.js';
import type { Store } from '../store.js';
import { WEIGHTS } from '../recall.js';

/**
 * The one truth about the recall parameters (dream stage 1-3, concept 9.3).
 *
 * Before this function existed, two effective policies lived in one code
 * base: the assistant path hands `hopEntity`/`hopEdge` from
 * `config.memory.graph` into `recall`, the agent path does not and silently
 * runs on the literals in recall.ts. The values happen to be equal, so
 * nobody noticed - until a promotion changes the config and one path keeps
 * running on the factory setting. Stage 1 wired the assistant path through
 * here (runtime.ts); the agent call in org/controller.ts joins in a later
 * wave (AP14, S18) - rerouting it is not this module's job.
 *
 * Stage 1 had no promoted version, so the weights were always the incumbent
 * literals from recall.ts with origin 'default'. Stage 3 (AP10) adds the
 * other half: `store.activePolicy(owner, slot)` may now hold a promoted
 * `policy_versions` row, and a field it sets is laid over the default -
 * unless the field is one the settings page also controls and the user has
 * moved it off the factory default. The one classification the concept
 * demands: a config value that deviates from its factory default is 'user',
 * never 'default' - otherwise a later promotion would quietly override a
 * knob the user set, or the settings page would lie about a value the dream
 * moved. With no promoted version this is exactly stage 1's no-op.
 *
 * `rookery config set` bypasses the zod patch schema entirely, so every
 * value is clamped here at read time (E21), never trusted because it was
 * written - a promoted value gets the identical clamp, because a
 * `policy_versions` row is no more trustworthy than a hand-edited config
 * file once it is sitting in a column.
 */

const FACTORY = DEFAULT_CONFIG.memory;

/** Clamp to the same range the server's patch schema enforces, and no wider. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** A promoted `params` blob is `Record<string, unknown>` - read it like one. */
function numberAt(params: Record<string, unknown> | undefined, key: string): number | null {
  const value = params?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Same, one level down: `params.w.<key>`. */
function weightAt(params: Record<string, unknown> | undefined, key: string): number | null {
  const w = params?.w;
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  return numberAt(w as Record<string, unknown>, key);
}

/** One resolved value with where it came from. */
interface ResolvedField {
  value: number;
  origin: PolicyOrigin;
}

/**
 * A field the settings page also owns (`limit`, `threshold`, `hopEntity`,
 * `hopEdge`): if the config has moved off the factory default, that is
 * `origin: 'user'` and a promoted value for this field is never looked at
 * (9.3 - the collision rule). Otherwise a valid promoted value wins as
 * `'dream'`; with none, it is the untouched default.
 */
function resolveConfigBacked(
  configValue: number,
  factoryValue: number,
  promoted: number | null,
  lo: number,
  hi: number,
): ResolvedField {
  const clampedConfig = clamp(configValue, lo, hi);
  if (clampedConfig !== factoryValue) return { value: clampedConfig, origin: 'user' };
  if (promoted !== null) return { value: clamp(promoted, lo, hi), origin: 'dream' };
  return { value: clampedConfig, origin: 'default' };
}

/**
 * A field with no config surface at all (the four scoring weights): there is
 * no way for a user to set it, so the only choice is the factory literal or
 * a promoted value.
 */
function resolveDreamOnly(
  factoryValue: number,
  promoted: number | null,
  lo: number,
  hi: number,
): ResolvedField {
  if (promoted !== null) return { value: clamp(promoted, lo, hi), origin: 'dream' };
  return { value: clamp(factoryValue, lo, hi), origin: 'default' };
}

/**
 * The factory parameter set (concept 10.2, condition 2b): the literals the
 * frozen audit set is scored against, never the live config and never a
 * promoted version. This is what makes the audit comparison a check against
 * where the product shipped rather than against last night's winner - a
 * chain of individually-significant promotions cannot walk the audit
 * baseline away with it, because this function never reads one.
 */
export function factoryPolicy(): RecallPolicy {
  return {
    limit: clamp(Math.round(FACTORY.recallLimit), 0, 50),
    threshold: clamp(FACTORY.recallThreshold, 0, 1),
    w: {
      relevance: clamp(WEIGHTS.relevance, 0, 1),
      importance: clamp(WEIGHTS.importance, 0, 1),
      recency: clamp(WEIGHTS.recency, 0, 1),
      usage: clamp(WEIGHTS.usage, 0, 1),
    },
    hopEntity: clamp(FACTORY.graph.hopEntity, 0, 1),
    hopEdge: clamp(FACTORY.graph.hopEdge, 0, 1),
    kinds: [],
    minImportance: 0,
    origin: {
      limit: 'default',
      threshold: 'default',
      hopEntity: 'default',
      hopEdge: 'default',
      relevance: 'default',
      importance: 'default',
      recency: 'default',
      usage: 'default',
    },
  };
}

/**
 * Resolve the effective recall policy for one owner and slot.
 *
 * Reads `store.activePolicy(owner, slot)`: the promoted, not-retired,
 * highest-version row for this owner and slot, or `null` when nothing has
 * ever been promoted - the exact case that leaves every field at today's
 * behaviour, byte for byte.
 */
export function resolvePolicy(
  store: Store,
  config: RookeryConfig,
  owner: string,
  slot: 'recall',
): RecallPolicy {
  const active = store.activePolicy(owner, slot);
  const params = active?.params;

  // The clamps mirror the server's memory patch schema (recallLimit an int
  // in 0..50, recallThreshold in 0..1). The hop weights and the scoring
  // weights have no patch schema - `memory.graph` is not settable over HTTP
  // and the weights have no config surface at all - so 0..1 is the honest
  // range for all four.
  const limit = resolveConfigBacked(
    Math.round(config.memory.recallLimit),
    FACTORY.recallLimit,
    numberAt(params, 'limit'),
    0,
    50,
  );
  const threshold = resolveConfigBacked(
    config.memory.recallThreshold,
    FACTORY.recallThreshold,
    numberAt(params, 'threshold'),
    0,
    1,
  );
  const hopEntity = resolveConfigBacked(
    config.memory.graph.hopEntity,
    FACTORY.graph.hopEntity,
    numberAt(params, 'hopEntity'),
    0,
    1,
  );
  const hopEdge = resolveConfigBacked(
    config.memory.graph.hopEdge,
    FACTORY.graph.hopEdge,
    numberAt(params, 'hopEdge'),
    0,
    1,
  );
  const relevance = resolveDreamOnly(WEIGHTS.relevance, weightAt(params, 'relevance'), 0, 1);
  const importance = resolveDreamOnly(WEIGHTS.importance, weightAt(params, 'importance'), 0, 1);
  const recency = resolveDreamOnly(WEIGHTS.recency, weightAt(params, 'recency'), 0, 1);
  const usage = resolveDreamOnly(WEIGHTS.usage, weightAt(params, 'usage'), 0, 1);

  return {
    limit: Math.round(limit.value),
    threshold: threshold.value,
    w: {
      relevance: relevance.value,
      importance: importance.value,
      recency: recency.value,
      usage: usage.value,
    },
    hopEntity: hopEntity.value,
    hopEdge: hopEdge.value,
    kinds: [],
    minImportance: 0,
    origin: {
      limit: limit.origin,
      threshold: threshold.origin,
      hopEntity: hopEntity.origin,
      hopEdge: hopEdge.origin,
      relevance: relevance.origin,
      importance: importance.origin,
      recency: recency.origin,
      usage: usage.origin,
    },
  };
}
