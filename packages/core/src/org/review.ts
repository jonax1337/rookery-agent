import type { Provider } from '../types.js';

/**
 * Model calls behind agent performance management
 * (docs/concepts/agent-performance-management.md).
 *
 * Every call here is a judgment, not extraction: is this work good, does a
 * pattern of weak work justify rewriting somebody's role, is a replacement
 * warranted. None of them run on the small/cheap model - the same reasoning
 * that keeps the nightly memory sleep off it (memory/sleep.ts, decision E6
 * in docs/concepts/memory-graph-and-sleep.md) applies even more directly
 * here, since a reconfig call can rewrite another agent's standing
 * instructions. Callers pass `model` explicitly when they want to override
 * the provider's own default; the functions here never pick a cheap one on
 * their own.
 */

export interface AssignmentJudgment {
  overall: number;
  quality?: number;
  completeness?: number;
  reliability?: number;
  communication?: number;
  efficiency?: number;
  comment?: string;
  tags: string[];
}

const JUDGMENT_PROMPT = `You are reviewing one completed assignment done by a member of staff at this
company - the judgment a good manager makes reading a report, not an extraction task. Read the role,
the task and the report below and judge how well IT WAS DONE, measured against what this role is
for - never against other staff.

Scale, integer 1 to 5, fixed anchors so this stays comparable across reviews:
5 - Delivered exactly as a good colleague in this role would. Nothing to redo.
4 - Usable, small rework or a follow-up question needed.
3 - Met the core of the task, with noticeable gaps.
2 - Off the mark or partly unusable; real rework needed.
1 - Unusable, misleading, or contains invented results.

Dimensions, same scale, or null when the report gives you nothing to judge it by:
- quality: is the result factually right and usable?
- completeness: was the task fulfilled in full, nothing silently dropped?
- reliability: are claims backed up, is verified separated from assumed, nothing invented?
- communication: is the report concise, decision-oriented, in the format the task asked for?
- efficiency: judge only if the report itself shows obvious over-scoping or wasted effort.

"overall" is your own judgment, not an average of the dimensions below it - do not let one strong
dimension wash out a real problem in another. "comment" is one to three sentences on what was good
or bad, written for a manager reading a personnel file, not for the agent. "tags" are zero to four
short lowercase-with-dashes labels for what stood out, e.g. "scope-miss", "unverified-claim",
"clean-report".

Reply with a JSON object ONLY, no prose, no code fence:
{"overall":4,"quality":4,"completeness":5,"reliability":4,"communication":3,"efficiency":null,"comment":"...","tags":["thorough"]}`;

export interface JudgeAssignmentInput {
  role: string;
  instructions: string;
  task: string;
  report: string;
  model?: string;
  signal?: AbortSignal;
}

/** Never throws: a review is a background step and must not fail the run it judges. */
export async function judgeAssignment(
  provider: Provider,
  input: JudgeAssignmentInput,
): Promise<AssignmentJudgment | null> {
  const prompt =
    JUDGMENT_PROMPT +
    '\n\nROLE: ' + input.role +
    '\nSTANDING INSTRUCTIONS: ' + clip(input.instructions, 1000) +
    '\n\nTASK:\n' + clip(input.task, 4000) +
    '\n\nREPORT:\n' + clip(input.report, 6000);
  const output = await runForJson(provider, prompt, input.model, input.signal);
  return output ? parseJudgment(output) : null;
}

export function parseJudgment(raw: string): AssignmentJudgment | null {
  const record = parseJsonObject(raw);
  if (!record) return null;
  const overall = score(record.overall);
  if (overall === undefined) return null;
  return {
    overall,
    quality: score(record.quality),
    completeness: score(record.completeness),
    reliability: score(record.reliability),
    communication: score(record.communication),
    efficiency: score(record.efficiency),
    comment: text(record.comment, 800),
    tags: stringArray(record.tags, 4),
  };
}

/* --------------------------------- escalation -------------------------------- */

export interface WeakReview {
  overall: number;
  source: string;
  comment?: string;
  tags: string[];
  createdAt: number;
}

function reviewLines(reviews: WeakReview[]): string {
  return reviews
    .map((review) => {
      const when = new Date(review.createdAt).toISOString().slice(0, 10);
      return (
        '- ' + when + ' [' + review.source + '] overall ' + review.overall +
        (review.tags.length ? ' (' + review.tags.join(', ') + ')' : '') +
        (review.comment ? ': ' + review.comment : '')
      );
    })
    .join('\n');
}

export interface DevelopmentNote {
  /** Internal diagnosis with evidence; the agent never sees this. */
  reason: string;
  /** Addressed to the agent itself - no numbers, no dimension names. */
  agentNote: string;
}

const NOTE_PROMPT = `An AI agent's recent work has been judged weak enough to flag. You write two
things from the reviews below:

"reason": one or two sentences, internal, naming the actual pattern with evidence from the
reviews - this is read by whoever manages the agent, never by the agent itself.

"agentNote": two to four sentences addressed DIRECTLY to the agent, describing the observable
behaviour and what is expected instead - concrete, like a manager's note, not a summary. It must
NEVER contain a number, a star count, a score, a dimension name (quality/completeness/reliability/
communication/efficiency) or any reference to being reviewed or rated. Talk about the work, not
about the judging of it.

Reply with a JSON object ONLY, no prose, no code fence:
{"reason":"...","agentNote":"..."}`;

export interface DraftNoteInput {
  roleTitle: string;
  instructions: string;
  reviews: WeakReview[];
  model?: string;
  signal?: AbortSignal;
}

export async function draftNote(provider: Provider, input: DraftNoteInput): Promise<DevelopmentNote | null> {
  const prompt =
    NOTE_PROMPT +
    '\n\nROLE: ' + input.roleTitle +
    '\nSTANDING INSTRUCTIONS: ' + clip(input.instructions, 1000) +
    '\n\nRECENT REVIEWS:\n' + reviewLines(input.reviews);
  const output = await runForJson(provider, prompt, input.model, input.signal);
  const record = output ? parseJsonObject(output) : null;
  if (!record) return null;
  const reason = text(record.reason, 600);
  const agentNote = sanitizeAgentNote(text(record.agentNote, 800));
  if (!reason || !agentNote) return null;
  return { reason, agentNote };
}

export interface DevelopmentReconfig extends DevelopmentNote {
  /** The rewritten standing instructions, replacing the agent's current ones in full. */
  newInstructions: string;
}

const RECONFIG_PROMPT = `An AI agent keeps producing weak work even after being flagged once. Its role
is described by its current standing instructions below; that description is evidently not steering
it well enough. Rewrite the standing instructions so they close the actual gaps shown in the reviews -
sharper, more specific, adding a constraint or an emphasis that was missing, never a vague exhortation
to "be better". Keep the parts that are not the problem. Write the FULL replacement text, not a diff.

Also write "reason" (internal, one or two sentences on what changed and why, with evidence) and
"agentNote" (two to four sentences addressed directly to the agent, describing the observable
behaviour and the new expectation - no numbers, no scores, no dimension names, no mention of being
reviewed).

Reply with a JSON object ONLY, no prose, no code fence:
{"reason":"...","agentNote":"...","newInstructions":"..."}`;

export interface DraftReconfigInput {
  roleTitle: string;
  instructions: string;
  reviews: WeakReview[];
  model?: string;
  signal?: AbortSignal;
}

export async function draftReconfig(
  provider: Provider,
  input: DraftReconfigInput,
): Promise<DevelopmentReconfig | null> {
  const prompt =
    RECONFIG_PROMPT +
    '\n\nROLE: ' + input.roleTitle +
    '\nCURRENT STANDING INSTRUCTIONS:\n' + clip(input.instructions, 2000) +
    '\n\nRECENT REVIEWS:\n' + reviewLines(input.reviews);
  const output = await runForJson(provider, prompt, input.model, input.signal);
  const record = output ? parseJsonObject(output) : null;
  if (!record) return null;
  const reason = text(record.reason, 600);
  const agentNote = sanitizeAgentNote(text(record.agentNote, 800));
  const newInstructions = text(record.newInstructions, 4000);
  if (!reason || !agentNote || !newInstructions) return null;
  return { reason, agentNote, newInstructions };
}

export interface ReplacementProposal {
  reason: string;
  successorName: string;
  successorSlug: string;
  successorTitle: string;
  successorInstructions: string;
}

const REPLACEMENT_PROMPT = `An AI agent has been reconfigured twice and is still performing weakly.
Propose parting ways and hiring a successor for the same role. Write:

"reason": two to four sentences, for the user, on what was tried twice and why it did not hold -
concrete, with evidence from the reviews.
"successorName": a new first name, different from the outgoing agent's.
"successorSlug": lowercase-with-dashes handle derived from that name.
"successorTitle": job title, normally unchanged from the current one unless the reviews suggest the
role itself was misdefined.
"successorInstructions": a full draft of standing instructions for the successor - learn from what
went wrong, do not just repeat the last reconfig.

Reply with a JSON object ONLY, no prose, no code fence:
{"reason":"...","successorName":"...","successorSlug":"...","successorTitle":"...","successorInstructions":"..."}`;

export interface DraftReplacementInput {
  currentName: string;
  roleTitle: string;
  instructions: string;
  reviews: WeakReview[];
  model?: string;
  signal?: AbortSignal;
}

export async function draftReplacementProposal(
  provider: Provider,
  input: DraftReplacementInput,
): Promise<ReplacementProposal | null> {
  const prompt =
    REPLACEMENT_PROMPT +
    '\n\nOUTGOING AGENT: ' + input.currentName +
    '\nROLE: ' + input.roleTitle +
    '\nCURRENT STANDING INSTRUCTIONS:\n' + clip(input.instructions, 2000) +
    '\n\nRECENT REVIEWS:\n' + reviewLines(input.reviews);
  const output = await runForJson(provider, prompt, input.model, input.signal);
  const record = output ? parseJsonObject(output) : null;
  if (!record) return null;
  const reason = text(record.reason, 1000);
  const successorName = text(record.successorName, 60);
  const successorSlug = text(record.successorSlug, 60);
  const successorTitle = text(record.successorTitle, 100);
  const successorInstructions = text(record.successorInstructions, 4000);
  if (!reason || !successorName || !successorTitle || !successorInstructions) return null;
  return { reason, successorName, successorSlug: successorSlug || successorName, successorTitle, successorInstructions };
}

export interface HandoverInput {
  predecessorName: string;
  roleTitle: string;
  instructions: string;
  /** Content plus date/importance of the predecessor's live, non-archived memories. */
  memories: { content: string; importance: number; createdAt: number }[];
  model?: string;
  signal?: AbortSignal;
}

const HANDOVER_PROMPT = `An AI agent is being replaced by a successor in the same role. Condense the
outgoing agent's working memory below into a handover document for the successor, at most around
2000 characters, in four short sections:

1. Ongoing work - what is currently in flight.
2. Decisions made and why - so the successor does not relitigate them blind.
3. Project-specific facts and conventions.
4. Open points and known traps.

Write plainly, as one colleague briefing another. Never mention reviews, scores, ratings or why the
predecessor was replaced - this document is working knowledge, not a performance record.

Reply with a JSON object ONLY, no prose, no code fence:
{"handover":"..."}`;

export async function draftHandover(provider: Provider, input: HandoverInput): Promise<string | null> {
  if (!input.memories.length) return null;
  const lines = input.memories
    .slice(0, 200)
    .map((memory) => '- (' + new Date(memory.createdAt).toISOString().slice(0, 10) + ') ' + memory.content)
    .join('\n');
  const prompt =
    HANDOVER_PROMPT +
    '\n\nOUTGOING AGENT: ' + input.predecessorName +
    '\nROLE: ' + input.roleTitle +
    '\n\nMEMORIES:\n' + clip(lines, 12000);
  const output = await runForJson(provider, prompt, input.model, input.signal);
  const record = output ? parseJsonObject(output) : null;
  const handover = record ? text(record.handover, 2400) : undefined;
  return handover || null;
}

/* ---------------------------------- shared ---------------------------------- */

async function runForJson(
  provider: Provider,
  prompt: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  let output = '';
  try {
    for await (const event of provider.run({ prompt, model, permission: 'chat', signal })) {
      if (event.type === 'done') output = event.text || output;
      else if (event.type === 'text') output += event.delta;
      else if (event.type === 'error' && event.fatal) return '';
    }
  } catch {
    return '';
  }
  return output;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function score(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : undefined;
  if (num === undefined || !Number.isFinite(num)) return undefined;
  return Math.min(5, Math.max(1, Math.round(num)));
}

function text(value: unknown, max: number): string | undefined {
  const str = typeof value === 'string' ? value.trim() : '';
  return str ? str.slice(0, max) : undefined;
}

function stringArray(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').slice(0, max) : [];
}

/**
 * The agent-facing text must never leak a number, a dimension name or the
 * word "review"/"rating" - decision E2. A model that slips is corrected here
 * rather than trusted, since this text goes straight into another agent's
 * prompt unreviewed by a person.
 */
function sanitizeAgentNote(note: string | undefined): string | undefined {
  if (!note) return undefined;
  if (/\d/.test(note)) return undefined;
  if (/\b(quality|completeness|reliability|communication|efficiency|review|rating|rated|score|stars?)\b/i.test(note)) {
    return undefined;
  }
  return note;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n[...clipped]';
}
