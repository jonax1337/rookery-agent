import type {
  EffortLevel,
  MemoryRecordSnapshot,
  Provider,
  RecallBox,
  RecallFrame,
  RecallPolicy,
  RecallWeights,
  ScoredMemory,
} from '../../types.js';
import { byScoreThenId, recencyOf } from '../recall.js';
import type { GainFunction } from './measure.js';
import {
  dropContradictedFromFrame,
  mergeProfile,
  pipelineAgent,
  pipelineAssistant,
  scoreFrame,
  type FrameScoringPolicy,
} from './score.js';

/**
 * The candidate writer (dream stage 2, AP6; concept 6.2).
 *
 * One model call per candidate, on `dream.model`, proposing one parameter
 * point inside the frame's declared box. Two rules carry this module:
 *
 * - **The writer never sees raw text (S15/E13).** Its whole input is
 *   `CandidateAggregates`, a typed structure that has no string field at all,
 *   recursively: no question, no memory content, no holdout trace, not even a
 *   memory id. The test for that is a construction test over a real instance
 *   of the structure, not a substring test over the prompt - a prompt built
 *   from numbers cannot fail a substring test, so such a test proves nothing.
 * - **The writer does not run at `ask`'s effort (S16/E14).** `ask`
 *   (memory/sleep.ts) wires `effort: 'low'`, which is right for the
 *   housekeeping phases it serves and wrong here: designing a parameter set
 *   from failure cases is judgement, not extraction. The dream therefore gets
 *   its own narrow caller below, with the effort the request carries. Like
 *   `ask` it never throws - a model error must not break the night - and an
 *   empty answer is a counted failure, never a candidate.
 *
 * Output is strict JSON, then box validation: a candidate outside the box is
 * a generation error counted here at parse time, not an abstention at
 * evaluation time (concept 6.2). The anti-gaming predicates (H1, H3, H9) run
 * after this, in dream/admission.ts (AP5).
 */

/** Weight of the flat tag bonus one row can earn (`scoreFrame`). */
const TAG_BONUS = 0.1;

/** The usage term's saturation: `log2(accessCount + 1) / 5`, capped at 1. */
const USAGE_SATURATION = 5;

/**
 * Effort the writer falls back to when the request names none. Never `'low'`
 * (S16): the default has to be honest on its own, not only when a caller
 * remembers to raise it.
 */
const DEFAULT_EFFORT: EffortLevel = 'medium';

/** How many decimals the prompt prints a share or a weight with. */
const DIGITS = 4;

/**
 * The five scoring components of one row, averaged over a set of rows, on
 * exactly the scale `scoreFrame` computes them: `relevance` divided by the
 * frame's clamped normaliser, `recency` against the frame's own clock,
 * `usage` saturated, `tagHit` as the flat bonus - so a mean of 0.04 reads as
 * "four rows in ten carried a tag the question used".
 */
export interface ComponentMeans {
  relevance: number;
  importance: number;
  recency: number;
  usage: number;
  tagHit: number;
}

/**
 * Everything the candidate writer is allowed to know about a night's bad
 * cases (concept 6.2). Numbers only, recursively - no string field anywhere,
 * which is the whole point of the type (S15/E13).
 *
 * A "case" is a scored frame that left at least one proven, still
 * deliverable memory out of the block the model read. Frames the pipeline
 * abstained on are counted and then dropped: an abstention is not a
 * diagnosis.
 */
export interface CandidateAggregates {
  /** Frames offered. */
  frames: number;
  /** Frames the pipeline closed; the denominator of `coverage` and `chars`. */
  scored: number;
  /** Frames the pipeline abstained on. */
  abstained: number;
  /** Scored frames that missed at least one proven memory. */
  cases: number;
  /** Mean components of the rows that should have been on top. */
  missed: ComponentMeans;
  /** Mean components of the rows that were on top instead. */
  delivered: ComponentMeans;
  /** Mean number of proven rows one case missed. */
  missedRows: number;
  /** Mean number of rows one case rendered at all. */
  renderedRows: number;
  /**
   * Per case, the 1-based rank of the first proven row in prompt order;
   * `0` where the block rendered no proven row at all. One entry per case,
   * in frame order.
   */
  firstHitRanks: number[];
  /**
   * Share of cases where the character budget ripped before the first proven
   * row: the ranking had it, the renderer never got to it.
   */
  budgetCutShare: number;
  /**
   * Share of cases where the second hop, at the box's widest hop weights,
   * would have delivered a missed row the first hop never reached.
   */
  hop2Share: number;
  /** Mean share of rendered rows carrying a proven label, over scored frames. */
  coverage: number;
  /** Mean used share of the character budget, over scored frames. */
  chars: number;
}

/** What one night asks the candidate writer for. */
export interface CandidateRequest {
  aggregates: CandidateAggregates;
  /** The box every proposed value must lie inside. */
  box: RecallBox;
  /** The parameter set in force, and the baseline the aggregates describe. */
  incumbent: RecallPolicy;
  /** How many candidates to propose: `dream.candidates`, one model call each. */
  count: number;
  /** `dream.model`. Unset leaves the provider's own default. */
  model?: string;
  /** How hard the writer may think. Unset means `'medium'`, never `'low'` (S16). */
  effort?: EffortLevel;
}

/** What the writer brought back, with what it cost and what it got wrong. */
export interface CandidateProposal {
  /** The accepted points, in the order the model proposed them. */
  candidates: RecallPolicy[];
  /** Model calls spent; the night counts these against `dream.maxCallsPerNight`. */
  calls: number;
  /** Calls that came back empty or unreadable. A failure, never a candidate. */
  failures: number;
  /** Parsed points that left the box: generation errors (concept 6.2). */
  rejected: number;
}

/** What `parseCandidate` answers: a point inside the box, or why there is none. */
export type CandidateParse =
  | { ok: true; policy: RecallPolicy }
  | { ok: false; reason: 'empty' | 'malformed' | 'out-of-box' };

/* ------------------------------ aggregates ------------------------------ */

function emptyMeans(): ComponentMeans {
  return { relevance: 0, importance: 0, recency: 0, usage: 0, tagHit: 0 };
}

function addMeans(target: ComponentMeans, source: ComponentMeans): void {
  target.relevance += source.relevance;
  target.importance += source.importance;
  target.recency += source.recency;
  target.usage += source.usage;
  target.tagHit += source.tagHit;
}

function divideMeans(target: ComponentMeans, count: number): ComponentMeans {
  if (count <= 0) return target;
  return {
    relevance: target.relevance / count,
    importance: target.importance / count,
    recency: target.recency / count,
    usage: target.usage / count,
    tagHit: target.tagHit / count,
  };
}

/**
 * The components of one row as `scoreFrame` reads them. A row hop 1 never
 * returned - a profile row, a second-hop neighbour - has no bm25 of its own
 * and scores `relevance` 0, which is exactly how the live path treats it.
 */
function componentsOf(
  record: MemoryRecordSnapshot,
  frame: RecallFrame,
  relevanceById: Map<string, number>,
  queryTokens: Set<string>,
): ComponentMeans {
  return {
    relevance: relevanceById.get(record.id) ?? 0,
    importance: record.importance,
    recency: recencyOf(record.updatedAt, frame.now),
    usage: Math.min(1, Math.log2(record.accessCount + 1) / USAGE_SATURATION),
    tagHit: record.tags.some((tag) => queryTokens.has(tag.toLowerCase())) ? TAG_BONUS : 0,
  };
}

/**
 * Whether any policy inside the box could still deliver this frozen row.
 * Same predicate `measure` applies to the ideal (dream/measure.ts): a
 * labelled row the SQL hard-filters is unreachable for every candidate
 * alike, so missing it is not a failure the writer can fix.
 */
function reachable(record: MemoryRecordSnapshot, owner: string): boolean {
  return (
    record.owner === owner &&
    !record.forgotten &&
    !record.dormantAt &&
    !record.supersededBy &&
    !record.archivedAt
  );
}

/**
 * The post-processed ranking behind one block: what the pipeline would have
 * rendered if the character budget had been infinite. Built from the same
 * pieces the pipelines use (dream/score.ts), so the only difference against
 * the rendered list is the budget - which is precisely the question
 * `budgetCutShare` asks.
 */
function orderedRanking(
  frame: RecallFrame,
  policy: FrameScoringPolicy,
  ranked: ScoredMemory[],
): ScoredMemory[] {
  if (frame.pipeline === 'agent') return [...mergeProfile(frame, ranked, 3)].sort(byScoreThenId);
  const merged = mergeProfile(frame, ranked, policy.limit ?? 8);
  return [...dropContradictedFromFrame(frame, merged)].sort(byScoreThenId);
}

/**
 * Aggregate one night's bad cases into the only thing the writer gets to see
 * (concept 6.2).
 *
 * `gain` is the caller's label function, exactly as `measure` and the grid
 * probe take it: this module stays pure and asks no store. Every frame is
 * replayed at `policy` - the incumbent point - through its own pipeline, and
 * a frame whose pipeline abstains is counted and dropped.
 */
export function buildAggregates(
  frames: readonly RecallFrame[],
  gain: GainFunction,
  policy: FrameScoringPolicy,
): CandidateAggregates {
  const missed = emptyMeans();
  const delivered = emptyMeans();
  const firstHitRanks: number[] = [];
  let scored = 0;
  let abstained = 0;
  let cases = 0;
  let missedCount = 0;
  let deliveredCount = 0;
  let renderedCount = 0;
  let budgetCut = 0;
  let hop2 = 0;
  let coverage = 0;
  let chars = 0;

  for (const frame of frames) {
    const run =
      frame.pipeline === 'agent' ? pipelineAgent(frame, policy) : pipelineAssistant(frame, policy);
    if (!run.ok) {
      abstained += 1;
      continue;
    }
    scored += 1;
    renderedCount += run.lines.length;
    coverage += run.lines.length
      ? run.lines.filter((memory) => gain(memory.id) > 0).length / run.lines.length
      : 0;
    chars += Math.min(1, run.block.length / frame.budgetChars);

    const renderedIds = new Set(run.lines.map((memory) => memory.id));
    const missedRecords = Object.values(frame.records).filter(
      (record) =>
        gain(record.id) > 0 && reachable(record, frame.owner) && !renderedIds.has(record.id),
    );
    if (!missedRecords.length) continue;

    cases += 1;
    missedCount += missedRecords.length;
    const relevanceById = new Map(
      frame.hop1.map((row) => [row.id, row.relevance / frame.maxRelevanceClamped] as const),
    );
    const queryTokens = new Set(frame.query.tokens);
    for (const record of missedRecords) {
      addMeans(missed, componentsOf(record, frame, relevanceById, queryTokens));
    }

    // What stood on top instead: the head of the block, as long as the list
    // of rows that should have been there.
    const head = run.lines.slice(0, Math.max(1, missedRecords.length));
    for (const memory of head) {
      addMeans(delivered, componentsOf(memory, frame, relevanceById, queryTokens));
    }
    deliveredCount += head.length;

    const hitIndex = run.lines.findIndex((memory) => gain(memory.id) > 0);
    firstHitRanks.push(hitIndex === -1 ? 0 : hitIndex + 1);

    const ranked = scoreFrame(frame, policy);
    if (ranked.ok) {
      // The budget ripped before the first proven row exactly when the
      // ranking had it and the renderer never reached it.
      const first = orderedRanking(frame, policy, ranked.ranked).find(
        (memory) => gain(memory.id) > 0,
      );
      if (first && !renderedIds.has(first.id)) budgetCut += 1;
    }

    // Would the second hop have found one of them? Asked at the box's widest
    // hop weights, with expansion forced on, because that is the question -
    // not what this policy point happened to do.
    const missedIds = new Set(missedRecords.map((record) => record.id));
    const widest = scoreFrame(frame, {
      ...policy,
      hopEntity: frame.box.hopEntity[1],
      hopEdge: frame.box.hopEdge[1],
      expand: true,
    });
    if (
      widest.ok &&
      widest.ranked.some((memory) => memory.hop !== 'direct' && missedIds.has(memory.id))
    ) {
      hop2 += 1;
    }
  }

  return {
    frames: frames.length,
    scored,
    abstained,
    cases,
    missed: divideMeans(missed, missedCount),
    delivered: divideMeans(delivered, deliveredCount),
    missedRows: cases ? missedCount / cases : 0,
    renderedRows: scored ? renderedCount / scored : 0,
    firstHitRanks,
    budgetCutShare: cases ? budgetCut / cases : 0,
    hop2Share: cases ? hop2 / cases : 0,
    coverage: scored ? coverage / scored : 0,
    chars: scored ? chars / scored : 0,
  };
}

/* -------------------------------- prompt -------------------------------- */

function round(value: number, digits = DIGITS): string {
  return Number.isFinite(value) ? value.toFixed(digits) : (0).toFixed(digits);
}

function interval(range: readonly [number, number]): string {
  return round(range[0]) + '..' + round(range[1]);
}

function meansLine(means: ComponentMeans): string {
  return (
    'relevance ' +
    round(means.relevance) +
    ', importance ' +
    round(means.importance) +
    ', recency ' +
    round(means.recency) +
    ', usage ' +
    round(means.usage) +
    ', tag hit ' +
    round(means.tagHit)
  );
}

/** The rank distribution in four buckets, so the prompt stays short. */
function rankBuckets(ranks: readonly number[]): string {
  let none = 0;
  let top = 0;
  let middle = 0;
  let deep = 0;
  for (const rank of ranks) {
    if (rank === 0) none += 1;
    else if (rank <= 3) top += 1;
    else if (rank <= 8) middle += 1;
    else deep += 1;
  }
  return (
    'rank 1-3: ' + top + ', rank 4-8: ' + middle + ', rank 9+: ' + deep + ', none rendered: ' + none
  );
}

function weightsLine(w: RecallWeights): string {
  return (
    'relevance ' +
    round(w.relevance) +
    ', importance ' +
    round(w.importance) +
    ', recency ' +
    round(w.recency) +
    ', usage ' +
    round(w.usage)
  );
}

const CANDIDATE_PROMPT_HEAD = `You are tuning the memory retrieval of a personal assistant overnight.

You never see a question, a memory or a conversation - only numbers about the cases where
the current parameter set left out a memory that later turned out to have been relevant.
Propose ONE new parameter set that would have put those memories into the prompt.

How the numbers work:
- Every row is scored as relevance*w.relevance + importance*w.importance + recency*w.recency
  + usage*w.usage, plus a flat 0.1 when the question used one of its tags. Rows at or above
  "threshold" are kept, the best three of them pull in neighbours through entities
  ("hopEntity") and through edges ("hopEdge"), and "limit" cuts the list.
- What the model actually read is then cut again by a character budget, from the top.
  A long line near the top costs the lines behind it.`;

const CANDIDATE_PROMPT_RULES = `Rules:
- Every value must lie inside its interval above. A value outside it is discarded.
- "limit" is a whole number.
- Do not return the current weight vector multiplied by a constant - that changes the
  numbers and nothing else, and it is rejected.
- Move what the evidence points at. If the missed rows scored well on a term the current
  weights hold low, raise that term. If the budget kept ripping first, a smaller "limit"
  or a higher "threshold" buys the room.

Reply ONLY with JSON, no prose or code fence:
{"limit":8,"threshold":0.12,"w":{"relevance":0.55,"importance":0.2,"recency":0.15,"usage":0.1},"hopEntity":0.45,"hopEdge":0.6}`;

/**
 * Build the writer's whole prompt out of the aggregates, the box and the
 * incumbent point (concept 6.2). No query text, no memory content, no
 * holdout trace - and nothing in `aggregates` could carry any, because the
 * type has no string field.
 *
 * `taken` are the points already accepted this night; they ride along as
 * numbers so the writer does not spend its next call proposing a point it
 * has already proposed.
 */
export function renderCandidatePrompt(
  aggregates: CandidateAggregates,
  box: RecallBox,
  incumbent: RecallPolicy,
  taken: readonly RecallPolicy[] = [],
): string {
  const lines: string[] = [CANDIDATE_PROMPT_HEAD, ''];

  lines.push('Current parameter set:');
  lines.push(
    '  limit ' +
      incumbent.limit +
      ', threshold ' +
      round(incumbent.threshold) +
      ', hopEntity ' +
      round(incumbent.hopEntity) +
      ', hopEdge ' +
      round(incumbent.hopEdge),
  );
  lines.push('  weights ' + weightsLine(incumbent.w));
  lines.push('');

  lines.push('The box, every value has to stay inside it:');
  lines.push('  limit 0..' + box.limitMax + ' (whole number)');
  lines.push('  threshold ' + interval(box.threshold));
  lines.push('  hopEntity ' + interval(box.hopEntity));
  lines.push('  hopEdge ' + interval(box.hopEdge));
  lines.push('  w.relevance ' + interval(box.w.relevance));
  lines.push('  w.importance ' + interval(box.w.importance));
  lines.push('  w.recency ' + interval(box.w.recency));
  lines.push('  w.usage ' + interval(box.w.usage));
  lines.push('');

  lines.push(
    'What happened: ' +
      aggregates.frames +
      ' recorded turns, ' +
      aggregates.scored +
      ' of them replayable, ' +
      aggregates.cases +
      ' of those missed at least one memory that was proven relevant.',
  );
  lines.push('  rows that should have been on top: ' + meansLine(aggregates.missed));
  lines.push('  rows that were on top instead:     ' + meansLine(aggregates.delivered));
  lines.push('  missed rows per case: ' + round(aggregates.missedRows, 2));
  lines.push('  rows rendered per turn: ' + round(aggregates.renderedRows, 2));
  lines.push('  first proven row in the prompt - ' + rankBuckets(aggregates.firstHitRanks));
  lines.push(
    '  character budget ripped before the first proven row in ' +
      round(aggregates.budgetCutShare) +
      ' of the cases',
  );
  lines.push(
    '  the second hop would have delivered a missed row in ' +
      round(aggregates.hop2Share) +
      ' of the cases',
  );
  lines.push('  proven share of the rendered rows: ' + round(aggregates.coverage));
  lines.push('  used share of the character budget: ' + round(aggregates.chars));
  lines.push('');

  if (taken.length) {
    lines.push('Already proposed tonight, do not repeat one of them:');
    for (const policy of taken) {
      lines.push(
        '  limit ' +
          policy.limit +
          ', threshold ' +
          round(policy.threshold) +
          ', hopEntity ' +
          round(policy.hopEntity) +
          ', hopEdge ' +
          round(policy.hopEdge) +
          ', weights ' +
          weightsLine(policy.w),
      );
    }
    lines.push('');
  }

  lines.push(CANDIDATE_PROMPT_RULES);
  return lines.join('\n');
}

/* -------------------------------- parsing ------------------------------- */

/**
 * Pull one JSON object out of a reply that may carry prose or a fence. The
 * same extraction `parseObject` does (memory/sleep.ts), kept local so that
 * the night's entry point can import this module without importing itself
 * back through it.
 */
function extractObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed: unknown = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function numberAt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inside(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

/**
 * Read one proposed parameter set and decide whether it is a candidate at
 * all (concept 6.2).
 *
 * `kinds` and `minImportance` ride along from the box: they are SQL filters
 * the frame was recorded with, not part of the policy space, so the writer
 * neither sees nor sets them. Every field the writer does set is checked
 * against the box here - a box violation is a generation error, counted at
 * parse time, never carried into an evaluation as an abstention. The scalar
 * multiple check (H9) is not here: it belongs to the admission predicate
 * (dream/admission.ts), which compares against the incumbent.
 */
export function parseCandidate(raw: string, box: RecallBox): CandidateParse {
  if (!raw.trim()) return { ok: false, reason: 'empty' };
  const parsed = extractObject(raw);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const weights = parsed.w;
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    return { ok: false, reason: 'malformed' };
  }
  const w = weights as Record<string, unknown>;
  const limit = numberAt(parsed, 'limit');
  const threshold = numberAt(parsed, 'threshold');
  const hopEntity = numberAt(parsed, 'hopEntity');
  const hopEdge = numberAt(parsed, 'hopEdge');
  const relevance = numberAt(w, 'relevance');
  const importance = numberAt(w, 'importance');
  const recency = numberAt(w, 'recency');
  const usage = numberAt(w, 'usage');
  if (
    limit === null ||
    threshold === null ||
    hopEntity === null ||
    hopEdge === null ||
    relevance === null ||
    importance === null ||
    recency === null ||
    usage === null
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // A fractional limit is not a rounding job: the writer was told it is a
  // whole number, and guessing what it meant invents a point nobody proposed.
  if (!Number.isInteger(limit)) return { ok: false, reason: 'out-of-box' };
  if (limit < 0 || limit > box.limitMax) return { ok: false, reason: 'out-of-box' };
  if (!inside(threshold, box.threshold)) return { ok: false, reason: 'out-of-box' };
  if (!inside(hopEntity, box.hopEntity)) return { ok: false, reason: 'out-of-box' };
  if (!inside(hopEdge, box.hopEdge)) return { ok: false, reason: 'out-of-box' };
  if (!inside(relevance, box.w.relevance)) return { ok: false, reason: 'out-of-box' };
  if (!inside(importance, box.w.importance)) return { ok: false, reason: 'out-of-box' };
  if (!inside(recency, box.w.recency)) return { ok: false, reason: 'out-of-box' };
  if (!inside(usage, box.w.usage)) return { ok: false, reason: 'out-of-box' };

  return {
    ok: true,
    policy: {
      limit,
      threshold,
      w: { relevance, importance, recency, usage },
      hopEntity,
      hopEdge,
      kinds: [...box.kinds],
      minImportance: box.minImportance,
      // Every field of a proposed set comes from the dream; whether it ever
      // becomes the effective policy is the promotion gate's business.
      origin: {
        limit: 'dream',
        threshold: 'dream',
        hopEntity: 'dream',
        hopEdge: 'dream',
        relevance: 'dream',
        importance: 'dream',
        recency: 'dream',
        usage: 'dream',
      },
    },
  };
}

/* ------------------------------- the caller ------------------------------ */

/**
 * One candidate call. The dream's own narrow caller (S16/E14): same shape as
 * `ask` (memory/sleep.ts), but the effort comes from the request instead of
 * being wired to `'low'` - housekeeping may not out-think its work, a
 * parameter proposal has to think. Never throws; an empty string means
 * "nothing usable", and the caller counts that as a failure.
 */
async function askForCandidate(
  provider: Provider,
  prompt: string,
  model: string | undefined,
  effort: EffortLevel,
  signal: AbortSignal,
): Promise<string> {
  let output = '';
  try {
    for await (const event of provider.run({
      prompt,
      model,
      effort,
      permission: 'chat',
      signal,
    })) {
      if (event.type === 'done') output = event.text || output;
      else if (event.type === 'text') output += event.delta;
      else if (event.type === 'error' && event.fatal) return output;
    }
  } catch {
    return '';
  }
  return output;
}

/**
 * Propose candidates for one slot, one model call each (concept 6.2).
 *
 * Never throws: a model that errors, times out or answers nothing costs the
 * night a counted failure and no more. The result is what came back inside
 * the box - the incumbent is added by `withIncumbent`, not here, so a night
 * with zero usable answers still has something to evaluate.
 */
export async function proposeCandidates(
  provider: Provider,
  input: CandidateRequest,
  signal: AbortSignal,
): Promise<CandidateProposal> {
  const wanted = Number.isFinite(input.count) ? Math.max(0, Math.round(input.count)) : 0;
  const proposal: CandidateProposal = { candidates: [], calls: 0, failures: 0, rejected: 0 };

  for (let index = 0; index < wanted; index += 1) {
    if (signal.aborted) break;
    const prompt = renderCandidatePrompt(
      input.aggregates,
      input.box,
      input.incumbent,
      proposal.candidates,
    );
    proposal.calls += 1;
    const raw = await askForCandidate(
      provider,
      prompt,
      input.model,
      input.effort ?? DEFAULT_EFFORT,
      signal,
    );
    const parsed = parseCandidate(raw, input.box);
    if (parsed.ok) proposal.candidates.push(parsed.policy);
    else if (parsed.reason === 'out-of-box') proposal.rejected += 1;
    else proposal.failures += 1;
  }

  return proposal;
}

/** Whether two points are the same point; exact, because a point is numbers. */
function samePoint(a: RecallPolicy, b: RecallPolicy): boolean {
  return (
    a.limit === b.limit &&
    a.threshold === b.threshold &&
    a.hopEntity === b.hopEntity &&
    a.hopEdge === b.hopEdge &&
    a.w.relevance === b.w.relevance &&
    a.w.importance === b.w.importance &&
    a.w.recency === b.w.recency &&
    a.w.usage === b.w.usage
  );
}

/**
 * The incumbent is always a candidate, and it runs in the same pass (E2).
 *
 * It goes first, the way the grid's first placement is the incumbent
 * (dream/probe.ts): every delta is then paired against a number measured
 * tonight, on tonight's frames, never against a number from yesterday. A
 * proposal that reproduces a point already in the list is dropped - it would
 * buy a second evaluation of the same policy and pay for it twice.
 */
export function withIncumbent(
  candidates: readonly RecallPolicy[],
  incumbent: RecallPolicy,
): RecallPolicy[] {
  const out: RecallPolicy[] = [incumbent];
  for (const candidate of candidates) {
    if (out.some((existing) => samePoint(existing, candidate))) continue;
    out.push(candidate);
  }
  return out;
}
