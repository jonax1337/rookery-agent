import {
  ASSISTANT_MEMORY_OWNER,
  type MemoryEntity,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRecord,
  type ScoredMemory,
} from '../types.js';
import { mapMemory, type Store } from './store.js';

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

const WEIGHTS = { relevance: 0.55, importance: 0.2, recency: 0.15, usage: 0.1 };
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Total order for every in-JS sort of scored memories: score descending,
 * then id ascending. Sorting on score alone leaves ties to insertion order,
 * which is whatever SQLite happened to return first (R11).
 */
const byScoreThenId = (a: ScoredMemory, b: ScoredMemory): number =>
  b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

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
}

/**
 * Find the memories worth putting in front of the model for this turn.
 * Returns an empty array for an unsearchable query rather than dumping
 * everything, so a greeting does not drag in the whole memory bank.
 */
export function recall(store: Store, options: RecallOptions): ScoredMemory[] {
  const limit = options.limit ?? 8;
  const threshold = options.threshold ?? 0.12;
  const owner = options.owner ?? ASSISTANT_MEMORY_OWNER;
  const match = toMatchQuery(options.text);
  if (!match) return [];

  const kinds = options.kinds ?? [];
  const kindFilter = kinds.length ? ' AND m.kind IN (' + kinds.map(() => '?').join(', ') + ')' : '';

  // bm25() returns a negative number where lower is better; negate it so the
  // scale runs the same direction as every other signal.
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

  let rows: Record<string, unknown>[];
  try {
    rows = store.db
      .prepare(sql)
      .all(match, owner, options.minImportance ?? 0, ...kinds, limit * 4) as Record<string, unknown>[];
  } catch {
    // A malformed MATCH should degrade to "no memories", never break the turn.
    return [];
  }

  const now = Date.now();
  const maxRelevance = Math.max(...rows.map((row) => Number(row.relevance) || 0), 1);
  const queryTokens = new Set(tokenize(options.text));

  const scored: ScoredMemory[] = rows.map((row) => {
    const record = mapMemory(row);
    const relevance = (Number(row.relevance) || 0) / maxRelevance;
    const recency = Math.pow(0.5, (now - record.updatedAt) / RECENCY_HALF_LIFE_MS);
    const usage = Math.min(1, Math.log2(record.accessCount + 1) / 5);
    // A memory whose tag the user just said is almost certainly on topic.
    const tagHit = record.tags.some((tag) => queryTokens.has(tag.toLowerCase())) ? 0.1 : 0;

    const score =
      WEIGHTS.relevance * relevance +
      WEIGHTS.importance * record.importance +
      WEIGHTS.recency * recency +
      WEIGHTS.usage * usage +
      tagHit;

    return {
      ...record,
      score,
      hop: 'direct' as const,
      reason: describe(relevance, record.importance, recency, tagHit > 0),
    };
  });

  const direct = scored.filter((memory) => memory.score >= threshold).sort(byScoreThenId);

  // The second hop: what the question could not say in words. Only the best
  // few direct hits get to pull neighbours in, so a vague question does not
  // drag the whole bank along behind it.
  const expanded =
    options.expand === false ? [] : expand(store, owner, direct.slice(0, 3), options);

  const byId = new Map<string, ScoredMemory>();
  for (const memory of [...direct, ...expanded]) {
    const existing = byId.get(memory.id);
    // Maximum, never a sum: reaching the same memory two ways is one memory.
    if (!existing || memory.score > existing.score) byId.set(memory.id, memory);
  }

  const top = [...byId.values()].sort(byScoreThenId).slice(0, limit);

  if (options.touch !== false && top.length) {
    store.touchMemories(top.map((memory) => memory.id));
  }
  return top;
}

/**
 * Pull in what the direct hits are connected to.
 *
 * This is what closes the gap lexical search cannot: "which language do I
 * prefer?" shares no word with "works mainly with TypeScript", but both hang
 * off the entity `typescript`. Common entities are damped - one that half the
 * bank mentions says nothing about this question in particular.
 */
function expand(
  store: Store,
  owner: string,
  seeds: ScoredMemory[],
  options: RecallOptions,
): ScoredMemory[] {
  if (!seeds.length) return [];
  const hopEntity = options.hopEntity ?? 0.45;
  const hopEdge = options.hopEdge ?? 0.6;
  const seedIds = seeds.map((memory) => memory.id);
  const out = new Map<string, ScoredMemory>();

  const offer = (record: MemoryRecord, score: number, hop: 'entity' | 'edge', reason: string): void => {
    if (seedIds.includes(record.id)) return;
    // One bank only. The link table has no owner column, so a stray
    // cross-owner link must not turn the second hop into a cross-owner read.
    if (record.owner !== owner) return;
    if (record.forgotten || record.dormantAt || record.supersededBy || record.archivedAt) return;
    const existing = out.get(record.id);
    if (existing && existing.score >= score) return;
    out.set(record.id, { ...record, score, hop, reason });
  };

  for (const seed of seeds) {
    const entities = store.entitiesFor(seed.id);
    for (const entity of entities) {
      if (entity.mentions <= 1) continue;
      const damping = Math.min(1, 3 / Math.max(1, entity.mentions));
      const inherited = hopEntity * seed.score * damping;
      if (inherited < (options.threshold ?? 0.12) * 0.5) continue;
      for (const record of store.memoriesForEntities([entity.id], { owner, exclude: seedIds, limit: 8 })) {
        offer(record, inherited * (0.6 + 0.4 * record.importance), 'entity', 'connected through ' + entity.name);
      }
    }
  }

  const edges = store.edgesFrom(seedIds, ['refines', 'caused_by']);
  for (const edge of edges) {
    const seed = seeds.find((memory) => memory.id === edge.srcId);
    if (!seed) continue;
    const record = store.getMemory(edge.dstId);
    if (!record || record.owner !== owner) continue;
    offer(
      record,
      hopEdge * seed.score * edge.weight,
      'edge',
      edge.relation === 'refines' ? 'refines a match' : 'explains a match',
    );
  }

  return [...out.values()].sort(byScoreThenId);
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
      score: 1,
      hop: 'direct' as const,
      reason: record.pinned ? 'pinned' : record.kind === 'insight' ? 'insight' : 'core profile',
    };
  });
}

function describe(relevance: number, importance: number, recency: number, taggedHit: boolean): string {
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
