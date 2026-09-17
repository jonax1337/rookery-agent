import {
  ASSISTANT_MEMORY_OWNER,
  type DreamDegraded,
  type DreamPipeline,
  type DreamSite,
  type FrameEdgeRef,
  type FrameEntityRef,
  type FrameHop1Row,
  type MemoryRecordSnapshot,
  type RecallBox,
  type RecallFrame,
} from '../../types.js';
import { type Store, mapMemory } from '../store.js';
import { WEIGHTS, coreProfile, recencyOf, toMatchQuery, tokenize, type RecallOptions } from '../recall.js';

/**
 * The frame: a recorded recall decision (dream stage 1, AP6).
 *
 * `fetchFrame` records the permissive corner of the declared parameter box,
 * not the path that was taken. Everything a replay needs is frozen here:
 * the raw bm25 relevances, the row snapshots, the entity neighbourhoods
 * without the seed exclusion, the edges from every possible seed. `recall`
 * itself runs over this pair (`fetchFrame` + `scoreFrame` in dream/score.ts)
 * so the live path and the replay are the same code, not two code paths that
 * have to be kept alike by hand.
 *
 * This module never writes. `touch: false` is not an option on a frame - the
 * frame simply has no touch path at all (R6); the only write in the recall
 * path stays in `recall()`, outside.
 */

/** The per-entity limit the live second hop uses (`expand` in recall.ts). */
const HOP2_ENTITY_LIMIT = 8;

/**
 * Hard cap on `|possibleSeeds|`. The list grows with the width of the box:
 * as any weight's lower bound approaches zero, every frontier row qualifies
 * and the frame would bloat until it fits nothing. Above the cap the frame is
 * discarded with the abstention reason `seeds-capped` instead of growing
 * (concept 3.1). The cap is inclusive - a frame whose list reaches the cap
 * abstains even if the raw count was exactly the cap, which is the safe
 * direction: an abstention, never a plausible wrong number. The budget gate
 * (AP11) expects p95 `|possibleSeeds|` around 12; the cap sits at twice that.
 */
export const SEEDS_CAP = 24;

/** What a frame is recorded from: a recall call plus its declared box. */
export interface FetchFrameOptions extends RecallOptions {
  /**
   * The declared parameter space the frame must stay closed under. Defaults
   * to the realised point (see `boxFromOptions`), which is what an untraced
   * `recall` passes: the frontier then stays `limit * 4` exactly as before.
   * Only a caller with an open trace - the recorder, AP9 - widens it.
   */
  box?: RecallBox;
  /** Where the call came from. Stage 1 scores only `turn` (concept 3.5). */
  site?: DreamSite;
  /** Which post-processing chain the frame belongs to (concept 3.6). */
  pipeline?: DreamPipeline;
  /** Budget the block was rendered with; part of the cost term's world. */
  budgetChars?: number;
  /** Subject string the block was rendered with. */
  subject?: string;
  /**
   * The corpus stamp in effect (R10). Empty on an untraced turn; the
   * recorder stamps the id of the night's `meta` fingerprint onto the frame
   * it saves (AP7/AP9).
   */
  corpusStampId?: string;
}

/**
 * The declared box around one realised recall call: every interval collapses
 * to the point the caller actually used. `recall` frames with this box, so an
 * untraced turn sees exactly the `limit * 4` frontier it has always seen and
 * no turn pays for the dream just by happening.
 */
export function boxFromOptions(options: RecallOptions): RecallBox {
  const threshold = options.threshold ?? 0.12;
  const hopEntity = options.hopEntity ?? 0.45;
  const hopEdge = options.hopEdge ?? 0.6;
  const point = <T,>(value: T): [T, T] => [value, value];
  return {
    limitMax: options.limit ?? 8,
    w: {
      relevance: point(WEIGHTS.relevance),
      importance: point(WEIGHTS.importance),
      recency: point(WEIGHTS.recency),
      usage: point(WEIGHTS.usage),
    },
    threshold: point(threshold),
    hopEntity: point(hopEntity),
    hopEdge: point(hopEdge),
    kinds: options.kinds ?? [],
    minImportance: options.minImportance ?? 0,
  };
}

/**
 * Whether every interval of the box collapsed to the point the caller used
 * (`lo === hi` everywhere). A point box is what an untraced `recall` frames
 * with, and on it the interval arithmetic above is not an estimate but the
 * exact score - which is what lets `scoreFrame` treat the seeds cap as a
 * measurement-validity statement rather than a delivery decision there.
 */
export function isPointBox(box: RecallBox): boolean {
  const collapsed = <T,>(interval: readonly [T, T]): boolean => interval[0] === interval[1];
  return (
    collapsed(box.w.relevance) &&
    collapsed(box.w.importance) &&
    collapsed(box.w.recency) &&
    collapsed(box.w.usage) &&
    collapsed(box.threshold) &&
    collapsed(box.hopEntity) &&
    collapsed(box.hopEdge)
  );
}

/** The score interval of one frontier row over the box, tag bonus included. */
function scoreBounds(
  relevance: number,
  importance: number,
  recency: number,
  usage: number,
  tagHit: number,
  box: RecallBox,
): { lo: number; hi: number } {
  return {
    lo:
      box.w.relevance[0] * relevance +
      box.w.importance[0] * importance +
      box.w.recency[0] * recency +
      box.w.usage[0] * usage +
      tagHit,
    hi:
      box.w.relevance[1] * relevance +
      box.w.importance[1] * importance +
      box.w.recency[1] * recency +
      box.w.usage[1] * usage +
      tagHit,
  };
}

/**
 * Record everything any policy inside the declared box could need to replay
 * this one recall decision. Reads only; the caller owns the clock the frame
 * freezes (`now` is read here, after the frontier query, exactly where the
 * old live path read it).
 */
export function fetchFrame(store: Store, options: FetchFrameOptions): RecallFrame {
  const owner = options.owner ?? ASSISTANT_MEMORY_OWNER;
  const limit = options.limit ?? 8;
  const kinds = options.kinds ?? [];
  const minImportance = options.minImportance ?? 0;
  const matchQuery = toMatchQuery(options.text);
  const queryTokens = tokenize(options.text);
  const box = options.box ?? boxFromOptions(options);
  // Only an open trace widens the frontier: with the point box above,
  // max(limit, limitMax) collapses to limit and the SQL sees the limit * 4
  // rows it has always seen.
  const frontier = Math.max(limit, box.limitMax) * 4;

  const kindFilter = kinds.length ? ' AND m.kind IN (' + kinds.map(() => '?').join(', ') + ')' : '';
  // bm25() returns a negative number where lower is better; negate it so the
  // scale runs the same direction as every other signal. Byte-for-byte the
  // live query, tie-breaker included.
  const sql =
    `SELECT m.*, -bm25(memories_fts, 1.0, 0.5) AS relevance
       FROM memories_fts
       JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
        AND m.owner = ?
        AND m.forgotten = 0
        AND m.dormant_at IS NULL
        AND m.superseded_by IS NULL
        AND m.archived_at IS NULL
        AND m.importance >= ?` +
    kindFilter +
    ` ORDER BY relevance DESC, m.id LIMIT ?`;

  let rows: Record<string, unknown>[] = [];
  let degraded: DreamDegraded | null = null;
  if (!matchQuery) {
    degraded = 'no-tokens';
  } else {
    try {
      rows = store.db
        .prepare(sql)
        .all(matchQuery, owner, minImportance, ...kinds, frontier) as Record<string, unknown>[];
    } catch {
      // A malformed MATCH must degrade to "no memories", never break the
      // turn - and never turn into an error at replay time either.
      degraded = 'fts-threw';
    }
  }

  const now = Date.now();
  // AFTER the Math.max(..., 1) clamp, on purpose: renormalising without the
  // clamp inflates queries with a low bm25 by a plausible-looking factor.
  const maxRelevanceClamped = Math.max(...rows.map((row) => Number(row.relevance) || 0), 1);

  const records: Record<string, MemoryRecordSnapshot> = {};
  const hop1: FrameHop1Row[] = [];
  for (const row of rows) {
    const record = mapMemory(row);
    records[record.id] = record;
    hop1.push({ id: record.id, relevance: Number(row.relevance) || 0 });
  }

  // The profile is recorded at the permissive corner of the box, not at the
  // realised limit: a profile recorded at limit 8 is not closed over limit 16
  // (R12). mergeProfile slices per candidate instead.
  const profile: { id: string; reason: string }[] = [];
  if (!degraded) {
    const profileRows = coreProfile(store, { owner, limit: Math.max(3, Math.floor(box.limitMax / 2)) });
    for (const row of profileRows) {
      const { score: _score, hop: _hop, reason, ...record } = row;
      records[record.id] = record;
      profile.push({ id: record.id, reason });
    }
  }

  // Possible seeds by interval arithmetic over the box: a row can become a
  // second-hop seed exactly when its best score can still reach the
  // third-largest worst score, and clear the lowest threshold in the box.
  // This is a superset of the true seeds; an error in the bound degrades to
  // an abstention, never to a plausible wrong number.
  const queryTokenSet = new Set(queryTokens);
  const bounds = hop1.map((row) => {
    const record = records[row.id];
    const relevance = row.relevance / maxRelevanceClamped;
    const recency = record ? recencyOf(record.updatedAt, now) : 0;
    const usage = record ? Math.min(1, Math.log2(record.accessCount + 1) / 5) : 0;
    const tagHit =
      record && record.tags.some((tag) => queryTokenSet.has(tag.toLowerCase())) ? 0.1 : 0;
    return {
      id: row.id,
      ...scoreBounds(relevance, record ? record.importance : 0, recency, usage, tagHit, box),
    };
  });
  const worstScores = bounds.map((bound) => bound.lo).sort((a, b) => b - a);
  const thirdLargestWorst =
    worstScores.length >= 3 ? (worstScores[2] ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY;
  const seedFloor = Math.max(box.threshold[0], thirdLargestWorst);
  // Seed-first order before any truncation: the most likely seeds lead, so a
  // cut at the cap costs the least. Deterministic - hi desc, then id asc.
  const possibleSeeds = bounds
    .filter((bound) => bound.hi >= seedFloor)
    .sort((a, b) => b.hi - a.hi || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, SEEDS_CAP)
    .map((bound) => bound.id);

  // Which entities can still hand out neighbours is decided at the box's most
  // permissive corner (hopEntity at its upper bound, threshold at its lower
  // bound), never at the realised point: a candidate may sit anywhere inside.
  const hiById = new Map(bounds.map((bound) => [bound.id, bound.hi] as const));
  const seedSide = [...new Set([...hop1.map((row) => row.id), ...profile.map((row) => row.id)])];
  const seedEntities = store.entitiesForMany(seedSide);
  const visitedEntities: FrameEntityRef[] = [];
  const seenEntities = new Set<string>();
  for (const seedId of possibleSeeds) {
    for (const entity of seedEntities.get(seedId) ?? []) {
      if (entity.mentions <= 1) continue;
      const damping = Math.min(1, 3 / Math.max(1, entity.mentions));
      const inheritedMax = box.hopEntity[1] * (hiById.get(seedId) ?? 0) * damping;
      if (inheritedMax < box.threshold[0] * 0.5) continue;
      if (seenEntities.has(entity.id)) continue;
      seenEntities.add(entity.id);
      visitedEntities.push({ entityId: entity.id, name: entity.name, mentions: entity.mentions });
    }
  }

  // Neighbours WITHOUT the seed exclusion, 8 + |possibleSeeds| rows per
  // entity: removing at most |seeds| ids from a prefix of 8 + |seeds| leaves
  // exactly the top 8 the live query with `exclude` returned. Superseded rows
  // are included on purpose - the SQL limit bites before `offer` filters
  // them, so a replay that never saw them would be a replay of another world.
  const entityNeighbours: Record<string, string[]> = {};
  if (visitedEntities.length) {
    const neighbours = store.memoriesForEntities(
      visitedEntities.map((entity) => entity.entityId),
      { owner, perEntity: true, limit: HOP2_ENTITY_LIMIT + possibleSeeds.length },
    );
    for (const row of neighbours) {
      const { hopEntityId, ...record } = row;
      records[record.id] = record;
      const key = hopEntityId ?? '';
      const bucket = entityNeighbours[key];
      if (bucket) bucket.push(record.id);
      else entityNeighbours[key] = [record.id];
    }
  }

  // Edges from every possible seed, not the realised ones: a candidate that
  // reorders the top three needs the neighbourhood of a seed that never ran.
  const edges: FrameEdgeRef[] = [];
  for (const edge of store.edgesFrom(possibleSeeds, ['refines', 'caused_by'])) {
    edges.push({
      id: edge.id,
      srcId: edge.srcId,
      dstId: edge.dstId,
      relation: edge.relation,
      weight: edge.weight,
    });
    if (!(edge.dstId in records)) {
      // edgesFrom does not filter on owner, so the destination may sit in
      // another bank; record it anyway and let the replay re-run the owner
      // check - owner filtering is needed twice, in SQL and in JS (10.5).
      const destination = store.getMemory(edge.dstId);
      if (destination) records[destination.id] = destination;
    }
  }

  // The reachable set R: hop1 plus profile plus every neighbour plus every
  // edge destination. `entities` covers all of R because the grouped
  // renderer reads entities for every delivered memory, not just the seeds.
  const reachable = Object.keys(records);
  const entities: Record<string, FrameEntityRef[]> = {};
  for (const [id, list] of store.entitiesForMany(reachable)) {
    entities[id] = list.map((entity) => ({
      entityId: entity.id,
      name: entity.name,
      mentions: entity.mentions,
    }));
  }

  // Contradiction pairs over R, for the store-free dropContradicted twin.
  const contradicts: { srcId: string; dstId: string }[] = [];
  for (const edge of store.edgesFrom(reachable, ['contradicts'])) {
    contradicts.push({ srcId: edge.srcId, dstId: edge.dstId });
  }

  return {
    v: 1,
    site: options.site ?? 'turn',
    pipeline: options.pipeline ?? 'assistant',
    owner,
    box,
    query: { text: options.text, matchQuery: matchQuery, tokens: queryTokens },
    now,
    corpusStampId: options.corpusStampId ?? '',
    maxRelevanceClamped,
    budgetChars: options.budgetChars ?? 2000,
    subject: options.subject ?? 'this user',
    records,
    hop1,
    possibleSeeds,
    entities,
    entityNeighbours,
    edges,
    contradicts,
    profile,
    degraded,
  };
}
