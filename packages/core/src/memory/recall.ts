import {
  ASSISTANT_MEMORY_OWNER,
  type MemoryEntity,
  type MemoryKind,
  type MemoryQuery,
  type RecallBox,
  type ScoredMemory,
} from '../types.js';
import { mapMemory, type Store } from './store.js';
// The dream split: recall is touch(scoreFrame(fetchFrame(...))), so this
// module and memory/dream/ import each other. Every cross-reference sits
// inside a function body, never at module-initialisation time, which is what
// keeps that cycle safe under ESM.
import { boxFromOptions, fetchFrame } from './dream/frame.js';
import { scoreFrame } from './dream/score.js';

/**
 * Memory recall.
 *
 * A memory surfaces on a blend of four signals rather than raw text match
 * alone, because for a personal assistant "what matters" is not the same as
 * "what shares words with the question":
 *
 *   relevance  - FTS5 BM25 over content and tags
 *   importance - how much weight the memory was given when stored
 *   recency    - exponential decay, halving roughly every 30 days
 *   usage      - log-scaled access count, so proven-useful memories stick
 *
 * Every query is scoped to one owner: the assistant's bank by default, or
 * one agent's. An agent never sees what the assistant knows about the user
 * and the assistant never recalls an agent's working notes.
 */

export const WEIGHTS = { relevance: 0.55, importance: 0.2, recency: 0.15, usage: 0.1 };
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The ceiling of a direct hit on the retrieval scale: the four incumbent
 * weights sum to exactly 1.00 and the tag bonus adds 0.1 on top.
 */
const RECALL_CEILING = 1.1;
/**
 * Where profile rows sit on that same scale. Held at the direct ceiling so a
 * profile row can never be displaced from the head of the merged block by a
 * direct hit (R13); before this, a near-ceiling direct hit could push the
 * literal-scored profile rows out of the head of the block.
 */
export const PROFILE_LEAD = RECALL_CEILING;

/**
 * Total order for every in-JS sort of scored memories: score descending,
 * then id ascending. Sorting on score alone leaves ties to insertion order,
 * which is whatever SQLite happened to return first (R11).
 */
export const byScoreThenId = (a: ScoredMemory, b: ScoredMemory): number =>
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Exponential recency decay over the half-life above, mirroring `recall`'s. */
export function recencyOf(updatedAt: number, now: number): number {
  return Math.pow(0.5, (now - updatedAt) / RECENCY_HALF_LIFE_MS);
}

/** Words too common to narrow anything down, in the two languages Rookery targets. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'in', 'on', 'at', 'for', 'with', 'my', 'me', 'i', 'you', 'it', 'that', 'this', 'do', 'does',
  'did', 'what', 'how', 'why', 'when', 'can', 'could', 'would', 'should', 'please',
  'der', 'die', 'das', 'und', 'oder', 'ist', 'sind', 'war', 'ein', 'eine', 'einen', 'zu', 'von',
  'im', 'in', 'am', 'auf', 'fuer', 'für', 'mit', 'mein', 'meine', 'mir', 'mich', 'ich', 'du',
  'es', 'dass', 'was', 'wie', 'warum', 'wann', 'kann', 'koennte', 'bitte', 'nicht', 'den', 'dem',
]);

/**
 * Turn free text into a safe FTS5 MATCH expression.
 * Every token is quoted, so punctuation can never be read as FTS syntax.
 */
export function toMatchQuery(text: string): string {
  const tokens = tokenize(text);
  if (!tokens.length) return '';
  // Prefix-match the tokens so "deploy" also finds "deployment".
  return tokens.map((token) => '"' + token + '"*').join(' OR ');
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
    .slice(0, 24);
}

export interface RecallOptions extends MemoryQuery {
  /** Drop candidates scoring below this. */
  threshold?: number;
  /** Mark the returned memories as accessed. Off for read-only inspection. */
  touch?: boolean;
  /**
   * Reach past the literal match through the graph. On by default; the
   * inspector switches it off so a search shows what actually matched.
   */
  expand?: boolean;
  /** Score a memory inherits through a shared entity. */
  hopEntity?: number;
  /** Score a memory inherits through a `refines` or `caused_by` edge. */
  hopEdge?: number;
  /**
   * Recorder context for `memory_touches` (dream stage 1): forwarded to
   * `Store.touchMemories(ids, ctx)` unchanged. Without it the touch path is
   * byte-identical to what it has always been - the recorder at the call
   * site (AP9) fills it in, never anything inside the dream modules.
   */
  touchContext?: { traceId: string; owner: string; policyId?: string };
}

/**
 * Find the memories worth putting in front of the model for this turn.
 * Returns an empty array for an unsearchable query rather than dumping
 * everything, so a greeting does not drag in the whole memory bank.
 *
 * The dream split (stage 1): `fetchFrame` records the decision, `scoreFrame`
 * replays it, and this function is the composition plus the one write the
 * recall path has ever had. The frame is built over the realised point - the
 * box below collapses `max(limit, limitMax)` to `limit`, so an untraced turn
 * sees exactly the `limit * 4` frontier and the `limit * 4` rows it has
 * always seen. Only a caller with an open trace (the recorder, AP9) hands
 * `fetchFrame` a wider box, because only a traced turn gets replayed.
 */
export function recall(store: Store, options: RecallOptions): ScoredMemory[] {
  const box: RecallBox = boxFromOptions(options);
  const frame = fetchFrame(store, { ...options, box, site: 'turn', pipeline: 'assistant' });
  const result = scoreFrame(frame, options);
  if (!result.ok) return [];
  const top = result.ranked;

  if (options.touch !== false && top.length) {
    store.touchMemories(top.map((memory) => memory.id), options.touchContext);
  }
  return top;
}

/**
 * Of a pair that cannot both be true, only the newer one goes into a prompt.
 * The older one stays in the bank and stays visible in the inspector - the
 * night reports contradictions, it never decides them, and neither does this.
 */
export function dropContradicted(store: Store, memories: ScoredMemory[]): ScoredMemory[] {
  if (memories.length < 2) return memories;
  const ids = memories.map((memory) => memory.id);
  const edges = store.edgesFrom(ids, ['contradicts']);
  if (!edges.length) return memories;
  const loser = new Set<string>();
  for (const edge of edges) {
    const a = memories.find((memory) => memory.id === edge.srcId);
    const b = memories.find((memory) => memory.id === edge.dstId);
    if (!a || !b) continue;
    loser.add(a.updatedAt >= b.updatedAt ? b.id : a.id);
  }
  return memories.map((memory) =>
    loser.has(memory.id)
      ? { ...memory, reason: memory.reason + ', outdated by a newer note' }
      : memory,
  ).filter((memory) => !loser.has(memory.id));
}

/**
 * The memories that belong in every turn regardless of the question.
 *
 * Lexical recall can only match words that are actually present, so a
 * question about a category ("which programming language do I prefer?") will
 * never match a memory naming the instance ("works mainly with TypeScript").
 * A small, high-importance profile carried in every turn closes that gap far
 * more cheaply than an embedding model would, and it is what makes the
 * assistant feel like it knows you rather than like it is running a search.
 */
export function coreProfile(
  store: Store,
  options: { limit?: number; minImportance?: number; owner?: string } = {},
): ScoredMemory[] {
  const limit = options.limit ?? 5;
  const minImportance = options.minImportance ?? 0.7;
  const owner = options.owner ?? ASSISTANT_MEMORY_OWNER;
  const now = Date.now();

  // Pinned first, then insights, then plain weight: what the user fixed in
  // place and what the nights concluded outrank whatever scored highest.
  const rows = store.db
    .prepare(
      `SELECT * FROM memories
        WHERE owner = ? AND forgotten = 0 AND dormant_at IS NULL AND superseded_by IS NULL
          AND archived_at IS NULL
          AND (importance >= ? OR pinned = 1)
        ORDER BY pinned DESC, (kind = 'insight') DESC, importance DESC, updated_at DESC, id
        LIMIT ?`,
    )
    .all(owner, minImportance, limit) as Record<string, unknown>[];

  return rows.map((row) => {
    const record = mapMemory(row);
    return {
      ...record,
      // A score on the retrieval scale instead of the flat literal 1, so the
      // turn merge orders profile rows by the same currency that orders
      // direct hits. The bonuses mirror the SQL order above: pinned (1.0)
      // beats any insight-plus-weights rest (at most 0.5 + 0.2 + 0.15), and
      // PROFILE_LEAD keeps every profile row on or above the best possible
      // direct hit (R13).
      score:
        PROFILE_LEAD +
        (record.pinned ? 1 : 0) +
        (record.kind === 'insight' ? 0.5 : 0) +
        WEIGHTS.importance * record.importance +
        WEIGHTS.recency * recencyOf(record.updatedAt, now),
      hop: 'direct' as const,
      reason: record.pinned ? 'pinned' : record.kind === 'insight' ? 'insight' : 'core profile',
    };
  });
}

export function describe(relevance: number, importance: number, recency: number, taggedHit: boolean): string {
  const parts: string[] = [];
  if (relevance > 0.6) parts.push('strong text match');
  else if (relevance > 0.25) parts.push('text match');
  if (importance >= 0.75) parts.push('high importance');
  if (recency > 0.7) parts.push('recent');
  if (taggedHit) parts.push('tag hit');
  return parts.length ? parts.join(', ') : 'weak match';
}

/**
 * Format recalled memories as the block injected into the system prompt.
 *
 * Grouped by entity when a store is available: a model reads "Rookery: three
 * things" far better than twelve unrelated bullets, and the grouping is the
 * only place the graph becomes visible to the model at all. Without a store
 * it falls back to the flat list, which is what the tests and the CLI use.
 */
export function renderMemoryBlock(
  memories: ScoredMemory[],
  budget = 2000,
  subject = 'this user',
  store?: Store,
): string {
  if (!memories.length) return '';
  const lines: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    if (used + line.length > budget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  const groups = store ? groupByEntity(store, memories) : null;
  if (groups && groups.grouped.length) {
    for (const group of groups.grouped) {
      if (!push(group.entity.name + ':')) break;
      let full = false;
      for (const memory of group.memories) {
        if (!push('  - (' + memory.kind + ') ' + memory.content)) {
          full = true;
          break;
        }
      }
      if (full) break;
    }
    for (const memory of groups.loose) {
      if (!push('- (' + memory.kind + ') ' + memory.content)) break;
    }
  } else {
    for (const memory of memories) {
      if (!push('- (' + memory.kind + ') ' + memory.content)) break;
    }
  }

  if (!lines.length) return '';
  return (
    'What you already know about ' + subject + ' (from earlier work):\n' +
    lines.join('\n') +
    '\nUse this naturally. Do not announce that you are reading from memory.'
  );
}

/**
 * Bucket memories under the entity that best explains them. Each memory
 * appears once, under its rarest entity - the rarest one is the most
 * informative, since an entity half the bank mentions groups nothing.
 */
function groupByEntity(
  store: Store,
  memories: ScoredMemory[],
): { grouped: { entity: MemoryEntity; memories: ScoredMemory[] }[]; loose: ScoredMemory[] } {
  const buckets = new Map<string, { entity: MemoryEntity; memories: ScoredMemory[] }>();
  const loose: ScoredMemory[] = [];

  for (const memory of memories) {
    const entities = store.entitiesFor(memory.id).filter((entity) => entity.mentions > 1);
    if (!entities.length) {
      loose.push(memory);
      continue;
    }
    const best = entities.reduce((a, b) => (a.mentions <= b.mentions ? a : b));
    const bucket = buckets.get(best.id);
    if (bucket) bucket.memories.push(memory);
    else buckets.set(best.id, { entity: best, memories: [memory] });
  }

  // A group of one is not a group; it reads better as a plain line.
  const grouped: { entity: MemoryEntity; memories: ScoredMemory[] }[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.memories.length > 1) grouped.push(bucket);
    else loose.push(...bucket.memories);
  }
  grouped.sort((a, b) => b.memories.length - a.memories.length || (a.entity.id < b.entity.id ? -1 : 1));
  loose.sort(byScoreThenId);
  return { grouped, loose };
}

export const MEMORY_KINDS: MemoryKind[] = [
  'fact',
  'preference',
  'project',
  'event',
  'summary',
  'insight',
];
