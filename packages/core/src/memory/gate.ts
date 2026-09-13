import type { MemoryConfig, MemoryEdge, MemoryRecord } from '../types.js';
import { entitySlug, mapMemory, type Store } from './store.js';
import { toMatchQuery, tokenize } from './recall.js';
import type { MemoryCandidate } from './extractor.js';

/**
 * The gate in front of the write path.
 *
 * Extraction proposes; this decides. Without it the bank grows for four
 * reasons that have nothing to do with learning anything new:
 *
 *   1. the extractor runs after every turn and defaults to importance 0.5,
 *   2. the duplicate guard is a unique index on the exact sentence, so one
 *      changed word makes a second record,
 *   3. nothing ever dies, so both records stay forever,
 *   4. a model asked for facts will find facts - it reads the assistant's own
 *      answer, or the question itself, and writes down a conclusion nobody
 *      ever stated.
 *
 * The gate closes all four, and the first thing it does is the strictest: a
 * candidate has to quote the words it stands on, and those words have to
 * appear in what the user actually wrote. Everything else is dropped
 * unstored - see `confirmedBy`. What survives is then deduplicated:
 * near-duplicates reinforce the memory that is already there instead of
 * joining it, weak candidates are dropped, and pairs that are similar but not
 * the same are queued for the night with a `co_occurs` edge, which is where
 * condensation picks them up.
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
  rejected: {
    content: string;
    reason: 'unconfirmed' | 'weak' | 'short' | 'duplicate-in-batch' | 'over-budget';
  }[];
  /** `co_occurs` edges queued for the nightly condensation. */
  queued: MemoryEdge[];
}

export interface GateInput {
  candidates: MemoryCandidate[];
  owner: string;
  config: MemoryConfig;
  /**
   * The texts a candidate's evidence has to be quotable from. For the
   * assistant that is the user's message and nothing else - not the
   * assistant's own answer, or the bank fills up with things the assistant
   * told itself. For an agent it is the assignment and the report.
   */
  sources: string[];
  sourceSessionId?: string;
  /**
   * Set when the night's replay phase is the one admitting these, so what it
   * harvested hangs off that run and a "undo this night" takes it back with
   * everything else the night did.
   */
  sleepRunId?: string;
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

/* --------------------------- the evidence check --------------------------- */

/**
 * Words as a quote is compared in: lower case, no diacritics, no punctuation.
 *
 * Deliberately *not* `tokenize` from recall. That one drops stop words, which
 * is right for searching and wrong here - "I do not use Docker" and "I use
 * Docker" collapse to the same token list once "not" is gone, and a check
 * that cannot tell those apart is worse than no check at all.
 */
function quoteWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    // The combining marks NFKD just split off. They have to go before the
    // next line runs, which would otherwise turn "ü" into two words.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** Does `needle` appear in `haystack` as an unbroken run of words? */
function runOf(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    let hit = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Is this quote really in one of these texts?
 *
 * This is the whole of "only store what was confirmed". A model asked to
 * quote will usually quote, but it will also tidy the punctuation, fix the
 * capitalisation, or join two halves of a sentence with an ellipsis - so the
 * comparison runs on normalised words and each ellipsis-separated fragment is
 * matched on its own. What it will NOT tolerate is a quote assembled from
 * words that never stood next to each other: every fragment has to appear as
 * an unbroken run, which is what stops a paraphrase from passing as a
 * quotation.
 *
 * A single word is never enough. "TypeScript" appears in plenty of messages
 * that claim nothing about the user.
 */
export function confirmedBy(evidence: string, sources: string[]): boolean {
  const quote = evidence.trim();
  if (!quote) return false;

  const haystacks = sources.map(quoteWords).filter((words) => words.length > 0);
  if (!haystacks.length) return false;

  const fragments = quote
    .split(/\s*(?:\.{3}|…|\[\s*\.{3}\s*\]|\[\s*…\s*\])\s*/)
    .map(quoteWords)
    .filter((words) => words.length > 0);
  if (!fragments.length) return false;

  // Two words of substance at the very least, however they are distributed
  // over the fragments.
  if (fragments.reduce((total, words) => total + words.length, 0) < 2) return false;

  return fragments.every((fragment) => haystacks.some((haystack) => runOf(haystack, fragment)));
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

    // Before anything else: was this actually said? A candidate that cannot
    // point at the words it came from is not a weak memory to be weighed
    // against the others, it is a claim with nothing behind it, and it leaves
    // here without ever reaching the bank.
    const evidence = candidate.evidence.trim();
    if (!confirmedBy(evidence, input.sources)) {
      result.rejected.push({ content, reason: 'unconfirmed' });
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
        evidence,
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
      evidence,
      sourceSessionId: input.sourceSessionId,
      sleepRunId: input.sleepRunId,
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
