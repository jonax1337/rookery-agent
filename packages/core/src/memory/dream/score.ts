import type {
  AbstainReason,
  FrameEntityRef,
  MemoryRecord,
  RecallFrame,
  RecallPolicy,
  ScoreResult,
  ScoredMemory,
} from '../../types.js';
import { SEEDS_CAP } from './frame.js';
import { WEIGHTS, PROFILE_LEAD, byScoreThenId, describe, recencyOf } from '../recall.js';

/**
 * The scoring half of the recall split (dream stage 1, AP6).
 *
 * `scoreFrame` is pure: no store, no clock, no writes. Everything it reads
 * was frozen into the frame at record time, so a replay scores the world that
 * existed, not the world that exists now (concept 3.7). `recall` runs over
 * this function, which is what makes the live path and the replay the same
 * code - the equivalence test in dream-frame.test.js is the acceptance of
 * that claim, not a hope.
 *
 * Weights are normalised to sum 1 and the threshold is scaled by the same
 * factor, which closes H9 for every caller: a candidate that is a positive
 * scalar multiple of another vector changes nothing. For the incumbent the
 * four weights sum to exactly 1.00 and division by 1 is bit-exact, so this
 * is a null step on the live path - the 200-draw equivalence test would fall
 * over at the first score comparison otherwise.
 */

/** A policy point inside the frame's box, as `scoreFrame` accepts it. */
export type FrameScoringPolicy = Partial<RecallPolicy> & {
  /**
   * Switch the second hop off, as the extractor population does. Not a
   * scoring parameter, so it has no interval in the box; it rides the
   * scoring input and defaults to on.
   */
  expand?: boolean;
};

/** What a post-processing chain produces: the block and what went into it. */
export type PipelineResult =
  | { ok: true; lines: ScoredMemory[]; block: string }
  | { ok: false; reason: AbstainReason };

/**
 * Replay one recall decision at a policy point inside the frame's box.
 *
 * Abstains, in order: a `limit` above the box is a recorder error (the box
 * promised closure - if it fires, the recorder lied, concept 5.4); a frame at
 * the seeds cap was discarded rather than inflated; a degraded turn is not a
 * legitimate miss. Note what is NOT here: "rows came but all fell below the
 * threshold" returns an empty, valid ranking - three worlds, not two.
 */
export function scoreFrame(frame: RecallFrame, policy: FrameScoringPolicy = {}): ScoreResult {
  const limit = policy.limit ?? 8;
  if (limit > frame.box.limitMax) return { ok: false, reason: 'limit-out-of-box' };
  if (frame.possibleSeeds.length >= SEEDS_CAP) return { ok: false, reason: 'seeds-capped' };
  if (frame.degraded) return { ok: false, reason: 'degraded-turn' };

  const raw = policy.w ?? WEIGHTS;
  const sum = raw.relevance + raw.importance + raw.recency + raw.usage;
  // A box keeps the lower weight bounds positive, so the sum is too; the
  // fallback only keeps the arithmetic finite if a caller hand-builds a
  // degenerate policy no recorder would declare.
  const divisor = sum > 0 ? sum : 1;
  const w = {
    relevance: raw.relevance / divisor,
    importance: raw.importance / divisor,
    recency: raw.recency / divisor,
    usage: raw.usage / divisor,
  };
  const threshold = (policy.threshold ?? 0.12) / divisor;

  const queryTokens = new Set(frame.query.tokens);
  const scored: ScoredMemory[] = [];
  for (const row of frame.hop1) {
    const record = frame.records[row.id];
    if (!record) continue; // a closed frame always has the record
    const relevance = row.relevance / frame.maxRelevanceClamped;
    const recency = recencyOf(record.updatedAt, frame.now);
    const usage = Math.min(1, Math.log2(record.accessCount + 1) / 5);
    // A memory whose tag the user just said is almost certainly on topic.
    const tagHit = record.tags.some((tag) => queryTokens.has(tag.toLowerCase())) ? 0.1 : 0;
    scored.push({
      ...record,
      score:
        w.relevance * relevance +
        w.importance * record.importance +
        w.recency * recency +
        w.usage * usage +
        tagHit,
      hop: 'direct' as const,
      reason: describe(relevance, record.importance, recency, tagHit > 0),
    });
  }

  const direct = scored.filter((memory) => memory.score >= threshold).sort(byScoreThenId);

  // The second hop: only the best few direct hits pull neighbours in, so a
  // vague question does not drag the whole bank along behind it.
  const expanded =
    policy.expand === false
      ? []
      : expandFromFrame(frame, direct.slice(0, 3), {
          hopEntity: policy.hopEntity ?? 0.45,
          hopEdge: policy.hopEdge ?? 0.6,
          threshold,
        });

  const byId = new Map<string, ScoredMemory>();
  for (const memory of [...direct, ...expanded]) {
    const existing = byId.get(memory.id);
    // Maximum, never a sum: reaching the same memory two ways is one memory.
    if (!existing || memory.score > existing.score) byId.set(memory.id, memory);
  }

  return { ok: true, ranked: [...byId.values()].sort(byScoreThenId).slice(0, limit) };
}

/**
 * Pull in what the direct hits are connected to, replayed from the frame.
 *
 * Mirrors `expand` in recall.ts branch for branch: the same damping, the same
 * inherited threshold, the same per-entity top 8 (recorded without the seed
 * exclusion, re-excluded here), the same owner and liveness filters in `offer`
 * - in SQL and in JS, because the link table has no owner column of its own.
 */
function expandFromFrame(
  frame: RecallFrame,
  seeds: ScoredMemory[],
  params: { hopEntity: number; hopEdge: number; threshold: number },
): ScoredMemory[] {
  if (!seeds.length) return [];
  const seedIds = seeds.map((memory) => memory.id);
  const out = new Map<string, ScoredMemory>();

  const offer = (record: MemoryRecord, score: number, hop: 'entity' | 'edge', reason: string): void => {
    if (seedIds.includes(record.id)) return;
    // One bank only; the frame may hold cross-owner rows the edge path
    // recorded, and they must not turn the second hop into a cross-owner read.
    if (record.owner !== frame.owner) return;
    if (record.forgotten || record.dormantAt || record.supersededBy || record.archivedAt) return;
    const existing = out.get(record.id);
    if (existing && existing.score >= score) return;
    out.set(record.id, { ...record, score, hop, reason });
  };

  for (const seed of seeds) {
    for (const entity of frame.entities[seed.id] ?? []) {
      if (entity.mentions <= 1) continue;
      const damping = Math.min(1, 3 / Math.max(1, entity.mentions));
      const inherited = params.hopEntity * seed.score * damping;
      if (inherited < params.threshold * 0.5) continue;
      const neighbours = (frame.entityNeighbours[entity.entityId] ?? [])
        .filter((id) => !seedIds.includes(id))
        .slice(0, 8);
      for (const id of neighbours) {
        const record = frame.records[id];
        if (!record) continue;
        offer(record, inherited * (0.6 + 0.4 * record.importance), 'entity', 'connected through ' + entity.name);
      }
    }
  }

  const seedIdSet = new Set(seedIds);
  for (const edge of frame.edges) {
    if (!seedIdSet.has(edge.srcId)) continue;
    const seed = seeds.find((memory) => memory.id === edge.srcId);
    if (!seed) continue;
    const record = frame.records[edge.dstId];
    if (!record || record.owner !== frame.owner) continue;
    offer(
      record,
      params.hopEdge * seed.score * edge.weight,
      'edge',
      edge.relation === 'refines' ? 'refines a match' : 'explains a match',
    );
  }

  return [...out.values()].sort(byScoreThenId);
}

/** Rebuild the profile rows as scored memories, from the frozen records. */
function profileRows(frame: RecallFrame, limit: number): ScoredMemory[] {
  const rows: ScoredMemory[] = [];
  for (const entry of frame.profile.slice(0, Math.max(0, limit))) {
    const record = frame.records[entry.id];
    if (!record) continue;
    rows.push({
      ...record,
      // The incumbent formula from coreProfile, unchanged: the profile is not
      // part of the policy space, so its score stays on the normalised scale
      // where PROFILE_LEAD keeps every profile row ahead of any direct hit.
      score:
        PROFILE_LEAD +
        (record.pinned ? 1 : 0) +
        (record.kind === 'insight' ? 0.5 : 0) +
        WEIGHTS.importance * record.importance +
        WEIGHTS.recency * recencyOf(record.updatedAt, frame.now),
      hop: 'direct' as const,
      reason: entry.reason,
    });
  }
  return rows;
}

/**
 * Merge the frame's profile into a ranking, as the turn does: profile rows
 * first, the ranking overwriting on an id clash, never truncated to `limit` -
 * the character budget does the truncating later, at render time. `limit` is
 * the recall limit of the turn; the profile carries `max(3, floor(limit / 2))`
 * rows, the count the live path derives at the same limit.
 */
export function mergeProfile(frame: RecallFrame, ranked: ScoredMemory[], limit: number): ScoredMemory[] {
  const byId = new Map<string, ScoredMemory>();
  for (const row of profileRows(frame, Math.max(3, Math.floor(limit / 2)))) byId.set(row.id, row);
  for (const memory of ranked) byId.set(memory.id, memory);
  return [...byId.values()];
}

/**
 * Of a pair that cannot both be true, only the newer one goes into a prompt -
 * replayed from the frame's contradiction pairs instead of a live query.
 * Mirrors `dropContradicted` in recall.ts decision for decision.
 */
export function dropContradictedFromFrame(frame: RecallFrame, memories: ScoredMemory[]): ScoredMemory[] {
  if (memories.length < 2) return memories;
  if (!frame.contradicts.length) return memories;
  const loser = new Set<string>();
  for (const pair of frame.contradicts) {
    const a = memories.find((memory) => memory.id === pair.srcId);
    const b = memories.find((memory) => memory.id === pair.dstId);
    if (!a || !b) continue;
    loser.add(a.updatedAt >= b.updatedAt ? b.id : a.id);
  }
  return memories
    .map((memory) =>
      loser.has(memory.id)
        ? { ...memory, reason: memory.reason + ', outdated by a newer note' }
        : memory,
    )
    .filter((memory) => !loser.has(memory.id));
}

/**
 * Bucket memories under the entity that best explains them, from the frame.
 * Store-free twin of `groupByEntity` in recall.ts: each memory appears once,
 * under its rarest entity, and a group of one reads better as a plain line.
 */
export function groupFromFrame(
  frame: RecallFrame,
  memories: ScoredMemory[],
): { grouped: { entity: FrameEntityRef; memories: ScoredMemory[] }[]; loose: ScoredMemory[] } {
  const buckets = new Map<string, { entity: FrameEntityRef; memories: ScoredMemory[] }>();
  const loose: ScoredMemory[] = [];

  for (const memory of memories) {
    const entities = (frame.entities[memory.id] ?? []).filter((entity) => entity.mentions > 1);
    if (!entities.length) {
      loose.push(memory);
      continue;
    }
    const best = entities.reduce((a, b) => (a.mentions <= b.mentions ? a : b));
    const bucket = buckets.get(best.entityId);
    if (bucket) bucket.memories.push(memory);
    else buckets.set(best.entityId, { entity: best, memories: [memory] });
  }

  const grouped: { entity: FrameEntityRef; memories: ScoredMemory[] }[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.memories.length > 1) grouped.push(bucket);
    else loose.push(...bucket.memories);
  }
  grouped.sort(
    (a, b) => b.memories.length - a.memories.length || (a.entity.entityId < b.entity.entityId ? -1 : 1),
  );
  loose.sort(byScoreThenId);
  return { grouped, loose };
}

/**
 * Render the block a frame's memories produce, grouped or flat.
 *
 * Store-free twin of `renderMemoryBlock` in recall.ts, character for
 * character - including the break-not-continue when the budget rips, which is
 * exactly why a redundant line costs the line behind it. `flat` selects the
 * agent chain's rendering, the one the live path produces without a store.
 */
export function renderFromFrame(
  frame: RecallFrame,
  memories: ScoredMemory[],
  budget = 2000,
  subject = 'this user',
  flat = false,
): string {
  return renderFrameBlock(frame, memories, budget, subject, flat).block;
}

/**
 * The renderer with its by-product: which memories' lines actually fit, in
 * prompt order. That ordered list is the measurement target (concept 5.1) -
 * what the model read, not what `recall` returned.
 */
function renderFrameBlock(
  frame: RecallFrame,
  memories: ScoredMemory[],
  budget: number,
  subject: string,
  flat: boolean,
): { block: string; included: ScoredMemory[] } {
  if (!memories.length) return { block: '', included: [] };
  const lines: string[] = [];
  const included: ScoredMemory[] = [];
  let used = 0;
  const push = (line: string, memory?: ScoredMemory): boolean => {
    if (used + line.length > budget) return false;
    lines.push(line);
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

  if (!lines.length) return { block: '', included: [] };
  return {
    block:
      'What you already know about ' + subject + ' (from earlier work):\n' +
      lines.join('\n') +
      '\nUse this naturally. Do not announce that you are reading from memory.',
    included,
  };
}

/**
 * The assistant chain: merge the profile at `max(3, floor(limit / 2))`, drop
 * contradicted pairs, sort, render grouped - the sequence runtime.ts walks on
 * a turn, as one function over the frame.
 */
export function pipelineAssistant(frame: RecallFrame, policy: FrameScoringPolicy = {}): PipelineResult {
  const scored = scoreFrame(frame, policy);
  if (!scored.ok) return scored;
  const limit = policy.limit ?? 8;
  const merged = mergeProfile(frame, scored.ranked, limit);
  const kept = dropContradictedFromFrame(frame, merged);
  const sorted = [...kept].sort(byScoreThenId);
  const rendered = renderFrameBlock(frame, sorted, frame.budgetChars, frame.subject, false);
  return { ok: true, lines: rendered.included, block: rendered.block };
}

/**
 * The agent chain: profile capped at the literal 3, no contradiction drop,
 * flat rendering - because that is what the agent path actually does
 * (org/controller.ts never calls dropContradicted, org/prompts.ts renders
 * without a store). Scoring an agent frame through the assistant chain would
 * score a prompt that never existed (R15).
 */
export function pipelineAgent(frame: RecallFrame, policy: FrameScoringPolicy = {}): PipelineResult {
  const scored = scoreFrame(frame, policy);
  if (!scored.ok) return scored;
  const merged = mergeProfile(frame, scored.ranked, 3);
  const sorted = [...merged].sort(byScoreThenId);
  const rendered = renderFrameBlock(frame, sorted, frame.budgetChars, frame.subject, true);
  return { ok: true, lines: rendered.included, block: rendered.block };
}
