import { ASSISTANT_MEMORY_OWNER, type MemoryKind, type MemoryQuery, type ScoredMemory } from '../types.js';
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
        AND m.importance >= ?` +
    kindFilter +
    ` ORDER BY relevance DESC LIMIT ?`;

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

    return { ...record, score, reason: describe(relevance, record.importance, recency, tagHit > 0) };
  });

  const top = scored
    .filter((memory) => memory.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (options.touch !== false && top.length) {
    store.touchMemories(top.map((memory) => memory.id));
  }
  return top;
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

  const rows = store.db
    .prepare(
      `SELECT * FROM memories
        WHERE owner = ? AND forgotten = 0 AND importance >= ?
        ORDER BY importance DESC, updated_at DESC
        LIMIT ?`,
    )
    .all(owner, minImportance, limit) as Record<string, unknown>[];

  return rows.map((row) => ({
    ...mapMemory(row),
    score: 1,
    reason: 'core profile',
  }));
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

/** Format recalled memories as the block injected into the system prompt. */
export function renderMemoryBlock(memories: ScoredMemory[], budget = 2000, subject = 'this user'): string {
  if (!memories.length) return '';
  const lines: string[] = [];
  let used = 0;
  for (const memory of memories) {
    const line = '- (' + memory.kind + ') ' + memory.content;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return '';
  return (
    'What you already know about ' + subject + ' (from earlier work):\n' +
    lines.join('\n') +
    '\nUse this naturally. Do not announce that you are reading from memory.'
  );
}

export const MEMORY_KINDS: MemoryKind[] = ['fact', 'preference', 'project', 'event', 'summary'];
