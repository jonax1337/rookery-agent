import type { EntityKind, MemoryKind, MemoryRecord, MemoryRelation } from '../types.js';
import { skillSlug } from '../skills/store.js';
import { normalizeTokens, similarity } from './gate.js';
import { MEMORY_KINDS } from './recall.js';
import { entitySlug } from './store.js';
import { clamp01 } from './sleep-limits.js';
import { objectRows, trimmed } from './sleep-model.js';

/**
 * What a model said, read back into things the night may act on. Every
 * reader here is pure and distrustful: a reply is a claim to check against
 * the memories it was shown, never an instruction to follow, so anything
 * out of range, out of vocabulary or out of proportion reads as nothing.
 */

/** Shortest and longest sentence the night accepts as a condensation. */
const MIN_CONDENSED_CHARS = 8;
const MAX_CONDENSED_CHARS = 500;

/** Shorter than this is a note, not a procedure worth opening. */
export const MIN_SKILL_BODY_CHARS = 120;

/** A procedure standing on fewer memories than this is one anecdote with ambitions. */
const MIN_SKILL_EVIDENCE = 3;

/** An insight standing on fewer memories than this is a guess. */
const MIN_INSIGHT_EVIDENCE = 2;
const MIN_INSIGHT_CHARS = 12;
const MAX_INSIGHT_CHARS = 400;
const DEFAULT_INSIGHT_IMPORTANCE = 0.75;

/** A correction shorter than this is a mood, not something said. */
const MIN_CORRECTION_CHARS = 8;

/** Edges and aliases one reply may carry; the rest is noise. */
const MAX_EDGES_PER_REPLY = 12;
const MAX_ALIASES_PER_REPLY = 8;
const DEFAULT_EDGE_WEIGHT = 0.6;

/** Two sentences this alike are one: replacing one with the other gains nothing. */
const SAME_SENTENCE = 0.9;

/** Tags a condensed or merged memory may carry. */
export const MAX_MERGED_TAGS = 8;

const EDGE_RELATIONS: readonly MemoryRelation[] = ['refines', 'contradicts', 'caused_by'];
const ENTITY_KINDS: readonly EntityKind[] = ['person', 'project', 'tool', 'place', 'org', 'topic'];

/** What the night may never touch. */
export function isProtected(memory: MemoryRecord): boolean {
  return memory.origin === 'user' || memory.pinned;
}

/** Distinct tags, first occurrences first, cut to what a record may carry. */
export function unionTags(tags: readonly string[], limit: number): string[] {
  return [...new Set(tags)].slice(0, limit);
}

/**
 * The 1-based numbers a reply named, as the distinct integers inside
 * `1..max`, in the order they first appeared. Pure reading of a list of
 * "which of the numbered items" answers.
 */
export function namedIndices(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => Number(entry)))].filter(
    (index) => Number.isInteger(index) && index >= 1 && index <= max,
  );
}

/** A condensed sentence of an acceptable length, or null. */
export function readCondensed(value: unknown): string | null {
  const content = typeof value === 'string' ? value.trim() : '';
  return content.length < MIN_CONDENSED_CHARS || content.length > MAX_CONDENSED_CHARS ? null : content;
}

/* -------------------------------- condense -------------------------------- */

/** One sentence that replaces several memories, and the memories it replaces. */
export interface MergeVerdict {
  content: string;
  kind: MemoryKind;
  importance: number;
  tags: string[];
  victims: MemoryRecord[];
}

export function readMergeVerdict(
  parsed: Record<string, unknown> | null,
  members: readonly MemoryRecord[],
): MergeVerdict | null {
  if (!parsed || parsed.merge !== true) return null;
  const content = readCondensed(parsed.content);
  if (!content) return null;

  const victims = namedIndices(parsed.supersedes, members.length)
    .map((index) => members[index - 1]!)
    // Protected memories are named in the prompt so the model sees the
    // whole picture, but it may not retire them. This is the enforcement.
    .filter((memory) => !isProtected(memory));
  if (!victims.length) return null;

  // Replacing one memory with a near-identical one gains nothing and
  // costs its history.
  if (
    victims.length < 2 &&
    similarity(normalizeTokens(content), normalizeTokens(victims[0]!.content)) > SAME_SENTENCE
  ) {
    return null;
  }

  const kind = MEMORY_KINDS.includes(parsed.kind as MemoryKind) ? (parsed.kind as MemoryKind) : 'summary';
  const importance = clamp01(
    typeof parsed.importance === 'number'
      ? parsed.importance
      : Math.max(...victims.map((memory) => memory.importance)),
  );
  const named = Array.isArray(parsed.tags)
    ? parsed.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const tags = unionTags([...victims.flatMap((memory) => memory.tags), ...named], MAX_MERGED_TAGS);
  return { content, kind, importance, tags, victims };
}

/* ---------------------------------- link ---------------------------------- */

export interface ProposedEdge {
  from: MemoryRecord;
  to: MemoryRecord;
  relation: MemoryRelation;
  weight: number;
}

/** The relations a reply drew between the numbered memories of one portion. */
export function readProposedEdges(
  parsed: Record<string, unknown>,
  portion: readonly MemoryRecord[],
): ProposedEdge[] {
  const edges: ProposedEdge[] = [];
  for (const row of objectRows(parsed.edges, MAX_EDGES_PER_REPLY)) {
    const from = Number(row.from);
    const to = Number(row.to);
    const relation = row.relation as MemoryRelation;
    if (!EDGE_RELATIONS.includes(relation)) continue;
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    if (from < 1 || to < 1 || from > portion.length || to > portion.length || from === to) continue;
    edges.push({
      from: portion[from - 1]!,
      to: portion[to - 1]!,
      relation,
      weight: clamp01(typeof row.weight === 'number' ? row.weight : DEFAULT_EDGE_WEIGHT),
    });
  }
  return edges;
}

/** Names the reply says are really a person or a tool, in a kind the graph knows. */
export function readEntityKinds(parsed: Record<string, unknown>): { name: string; kind: EntityKind }[] {
  const named: { name: string; kind: EntityKind }[] = [];
  for (const row of objectRows(parsed.entities)) {
    const name = trimmed(row, 'name');
    const kind = row.kind as EntityKind;
    if (!name || !entitySlug(name) || !ENTITY_KINDS.includes(kind)) continue;
    named.push({ name, kind });
  }
  return named;
}

/** Pairs of names the reply says mean one thing. */
export function readAliases(parsed: Record<string, unknown>): { from: string; into: string }[] {
  const aliases: { from: string; into: string }[] = [];
  for (const row of objectRows(parsed.aliases, MAX_ALIASES_PER_REPLY)) {
    const from = trimmed(row, 'from');
    const into = trimmed(row, 'into');
    if (!from || !into || from === into) continue;
    aliases.push({ from, into });
  }
  return aliases;
}

/* -------------------------------- reflect -------------------------------- */

/** An insight with the memories it says it stands on. */
export interface InsightDraft {
  content: string;
  importance: number;
  evidence: MemoryRecord[];
}

/**
 * The first `limit` insights a reply offers that have the right length and
 * stand on at least two of the numbered memories. The limit counts rows read,
 * not rows kept: a reply may not talk its way past the night's cap.
 */
export function readInsightDrafts(
  parsed: Record<string, unknown> | null,
  recent: readonly MemoryRecord[],
  limit: number,
): InsightDraft[] {
  const drafts: InsightDraft[] = [];
  for (const row of objectRows(parsed?.insights, limit)) {
    const content = trimmed(row, 'content');
    if (content.length < MIN_INSIGHT_CHARS || content.length > MAX_INSIGHT_CHARS) continue;
    const evidence = namedIndices(row.evidence, recent.length).map((index) => recent[index - 1]!);
    if (evidence.length < MIN_INSIGHT_EVIDENCE) continue;
    drafts.push({
      content,
      importance: clamp01(
        typeof row.importance === 'number' ? row.importance : DEFAULT_INSIGHT_IMPORTANCE,
      ),
      evidence,
    });
  }
  return drafts;
}

/* --------------------------------- skills --------------------------------- */

/** A procedure the reply proposes, with the 1-based numbers of the memories it stands on. */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  evidence: number[];
}

export function readSkillDrafts(
  parsed: Record<string, unknown> | null,
  memoryCount: number,
  limit: number,
): SkillDraft[] {
  const drafts: SkillDraft[] = [];
  for (const row of objectRows(parsed?.skills, limit)) {
    const name = typeof row.name === 'string' ? skillSlug(row.name) : '';
    const description = trimmed(row, 'description');
    const body = trimmed(row, 'body');
    if (!name || !description) continue;
    if (body.length < MIN_SKILL_BODY_CHARS) continue;
    const evidence = namedIndices(row.evidence, memoryCount);
    if (evidence.length < MIN_SKILL_EVIDENCE) continue;
    drafts.push({ name, description, body, evidence });
  }
  return drafts;
}

/** The rewrite a reply asks for, or null when the skill is to be left alone. */
export function readRevision(
  parsed: Record<string, unknown> | null,
  current: { description: string },
): { description: string; body: string } | null {
  if (parsed?.revise !== true) return null;
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  if (body.length < MIN_SKILL_BODY_CHARS) return null;
  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : current.description;
  return { description, body };
}

/* --------------------------------- replay --------------------------------- */

/** What the user said that was a correction, in the model's words and in theirs. */
export function readCorrectionClaims(
  parsed: Record<string, unknown> | null,
): { text: string; quote: string }[] {
  const claims: { text: string; quote: string }[] = [];
  for (const row of objectRows(parsed?.corrections)) {
    const text = trimmed(row, 'text');
    if (text.length < MIN_CORRECTION_CHARS) continue;
    claims.push({ text, quote: trimmed(row, 'quote') });
  }
  return claims;
}
