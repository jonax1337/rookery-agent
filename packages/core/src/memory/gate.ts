import type { MemoryConfig, MemoryEdge, MemoryRecord } from '../types.js';
import { entitySlug, mapMemory, type Store } from './store.js';
import { toMatchQuery, tokenize } from './recall.js';
import type { MemoryCandidate } from './extractor.js';

/**
 * The gate in front of the write path.
 *
 * Extraction proposes; this decides. Without it the bank grows for three
 * reasons that have nothing to do with learning anything new:
 *
 *   1. the extractor runs after every turn and defaults to importance 0.5,
 *   2. the duplicate guard is a unique index on the exact sentence, so one
 *      changed word makes a second record,
 *   3. nothing ever dies, so both records stay forever.
 *
 * The gate closes the first two. Near-duplicates reinforce the memory that
 * is already there instead of joining it, weak candidates are dropped, and
 * pairs that are similar but not the same are queued for the night with a
 * `co_occurs` edge, which is where condensation picks them up.
 *
 * Similarity is lexical on purpose. The provider CLIs return text, not
 * embeddings, and a local embedding model would mean a native build step -
 * exactly what `memory/db.ts` avoids by using `node:sqlite`. For sentences
 * the same small model wrote from the same instructions, the Dice
 * coefficient over normalised token sets is a good enough judge.
 */

export interface GateResult {
  /** Newly written memories. */
  stored: MemoryRecord[];
  /** Existing memories a candidate reinforced instead of duplicating. */
  reinforced: MemoryRecord[];
  /** Candidates thrown away, with the reason, for the log and for tests. */
  rejected: { content: string; reason: 'weak' | 'short' | 'duplicate-in-batch' | 'over-budget' }[];
  /** `co_occurs` edges queued for the nightly condensation. */
  queued: MemoryEdge[];
}

export interface GateInput {
  candidates: MemoryCandidate[];
  owner: string;
  config: MemoryConfig;
  sourceSessionId?: string;
}

/**
 * Normalise a sentence to the token set similarity is measured on:
 * lower case, no diacritics, no punctuation, no stop words.
 */
export function normalizeTokens(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Dice coefficient over two token sets: twice the overlap divided by the
 * combined size. 1 is the same sentence, 0 shares nothing.
 *
 * Dice rather than Jaccard because it is kinder to a longer sentence that
 * contains a shorter one - "works with TypeScript" against "works mainly
 * with TypeScript on Windows" should read as the same fact, not half of one.
 */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Of two sentences saying the same thing, keep the one that says more. */
function richer(a: string, b: string): string {
  return b.trim().length > a.trim().length + 8 ? b : a;
}

/**
 * Run the candidates of one turn through the gate and store what survives.
 *
 * Everything here is synchronous and local: no model call, no network. The
 * expensive judgement already happened during extraction.
 */
export function admitCandidates(store: Store, input: GateInput): GateResult {
  const { owner, config } = input;
  const gate = config.gate;
  const result: GateResult = { stored: [], reinforced: [], rejected: [], queued: [] };
  const seenThisTurn: { tokens: Set<string>; content: string }[] = [];

  for (const candidate of input.candidates) {
    if (result.stored.length + result.reinforced.length >= gate.maxPerTurn) {
      result.rejected.push({ content: candidate.content, reason: 'over-budget' });
      continue;
    }

    const content = candidate.content.trim();
    if (content.length < 8) {
      result.rejected.push({ content, reason: 'short' });
      continue;
    }

    const tokens = normalizeTokens(content);
    // Two near-identical candidates inside one batch: keep the first.
    if (seenThisTurn.some((seen) => similarity(seen.tokens, tokens) >= gate.duplicateThreshold)) {
      result.rejected.push({ content, reason: 'duplicate-in-batch' });
      continue;
    }

    const knownEntity = candidate.tags.some((tag) => Boolean(store.findEntity(owner, tag)));
    // A weak candidate still gets in when it talks about something the bank
    // already knows: that is context accumulating, not noise.
    if (candidate.importance < gate.minImportance && !knownEntity) {
      result.rejected.push({ content, reason: 'weak' });
      continue;
    }

    const neighbours = similarMemories(store, owner, content, tokens);
    const twin = neighbours.find((entry) => entry.score >= gate.duplicateThreshold);

    if (twin) {
      // Same fact, different words. Reinforce what is there; keep whichever
      // sentence carries more, and let the tags merge.
      const kept = richer(twin.memory.content, content);
      const reinforced = store.upsertMemory({
        kind: twin.memory.kind,
        content: twin.memory.content,
        tags: [...new Set([...twin.memory.tags, ...candidate.tags])],
        importance: Math.max(twin.memory.importance, candidate.importance),
        owner,
      });
      const final =
        kept === twin.memory.content ? reinforced : store.updateMemory(reinforced.id, { content: kept }) ?? reinforced;
      result.reinforced.push(final);
      linkEntities(store, owner, final.id, candidate.tags);
      seenThisTurn.push({ tokens, content });
      continue;
    }

    const record = store.upsertMemory({
      kind: candidate.kind,
      content,
      tags: candidate.tags,
      importance: candidate.importance,
      owner,
      sourceSessionId: input.sourceSessionId,
      origin: 'extract',
    });
    result.stored.push(record);
    linkEntities(store, owner, record.id, candidate.tags);
    seenThisTurn.push({ tokens, content });

    // Related but not the same: leave a marker for the night rather than
    // deciding now. Condensation is a judgement call and needs a model.
    for (const neighbour of neighbours) {
      if (neighbour.score < gate.clusterThreshold) continue;
      const edge = store.addEdge({
        owner,
        srcId: record.id,
        dstId: neighbour.memory.id,
        relation: 'co_occurs',
        weight: neighbour.score,
        origin: 'gate',
      });
      if (edge) result.queued.push(edge);
    }
  }

  return result;
}

/**
 * Candidates for "we may already know this", pulled through the same FTS
 * index recall uses. Scanning the whole bank would be correct too, and far
 * slower; anything genuinely near-identical shares enough words to be found.
 */
function similarMemories(
  store: Store,
  owner: string,
  content: string,
  tokens: Set<string>,
): { memory: MemoryRecord; score: number }[] {
  const match = toMatchQuery(content);
  if (!match) return [];
  let rows: Record<string, unknown>[];
  try {
    rows = store.db
      .prepare(
        `SELECT m.* FROM memories_fts
           JOIN memories m ON m.rowid = memories_fts.rowid
          WHERE memories_fts MATCH ?
            AND m.owner = ?
            AND m.forgotten = 0
            AND m.dormant_at IS NULL
          LIMIT 15`,
      )
      .all(match, owner) as Record<string, unknown>[];
  } catch {
    // A malformed MATCH must never cost the turn its memory.
    return [];
  }
  return rows
    .map((row) => {
      const memory = mapMemory(row);
      return { memory, score: similarity(tokens, normalizeTokens(memory.content)) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Tags become entities: the cheapest possible seed for the graph. */
export function linkEntities(store: Store, owner: string, memoryId: string, tags: string[]): void {
  for (const tag of tags.slice(0, 6)) {
    const name = tag.trim();
    if (name.length < 2 || !entitySlug(name)) continue;
    try {
      const entity = store.upsertEntity({ owner, name });
      store.linkEntity(memoryId, entity.id);
    } catch {
      // An entity that will not normalise is not worth failing a turn over.
    }
  }
}
