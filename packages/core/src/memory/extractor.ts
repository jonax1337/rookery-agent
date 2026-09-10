import type { MemoryKind, Provider } from '../types.js';

/**
 * Post-turn memory extraction.
 *
 * After a turn finishes, a cheap model reads the exchange and proposes
 * durable memories. This runs on the same subscription-authenticated CLI as
 * everything else, on a small model, with tools switched off.
 */

export interface MemoryCandidate {
  kind: MemoryKind;
  content: string;
  tags: string[];
  importance: number;
}

const EXTRACTION_PROMPT = `You maintain the long-term memory of a personal assistant.

Read the exchange below and extract ONLY durable facts worth remembering weeks from now.

Extract:
- fact: stable truths about the user, their setup, their people, their machine
- preference: how the user wants things done (tone, language, tools, formatting)
- project: ongoing work, goals, deadlines, constraints
- event: something that happened where the date matters

Do NOT extract:
- anything already listed under ALREADY KNOWN
- the content of the assistant answer, or general world knowledge
- one-off task details, pleasantries, or transient state
- anything you are inferring rather than being told

Rules:
- Each memory is ONE self-contained sentence, understandable with no other context.
- Write each memory in THE SAME LANGUAGE the user wrote in. Recall is lexical,
  so an English memory is invisible to a German question and vice versa.
- Write in the third person about the user ("The user ..." / "Der Nutzer ...").
- Keep the user's own wording for names, tools and terms, so a later question
  phrased the same way actually finds this memory.
- Resolve relative dates to absolute ones using the CURRENT DATE given below.
- importance: 0.9 identity and hard constraints, 0.7 preferences and active
  projects, 0.5 useful context, 0.3 minor detail.
- Extracting nothing is the correct answer most of the time.

Reply with a JSON array ONLY, no prose, no code fence:
[{"kind":"preference","content":"Der Nutzer arbeitet hauptsaechlich mit TypeScript.","tags":["typescript"],"importance":0.8}]
An empty array is []`;

/**
 * The same job for an agent's own memory. An agent does not learn about the
 * user; it learns about the project it works in and how its work went, so
 * the next assignment starts with what the last one found out.
 */
const AGENT_EXTRACTION_PROMPT = `You maintain the working memory of one AI agent employed in a company.

Read the assignment and the agent's report below and extract ONLY durable knowledge that will
help this agent on a future assignment.

Extract:
- project: how the codebase or project is structured, where things live, conventions, gotchas
- fact: stable truths about the tools, environment or people the agent works with
- preference: how the manager or assistant wants results delivered
- event: a decision or change that happened, with its date

Do NOT extract:
- anything already listed under ALREADY KNOWN
- the task's one-off details or the report's content itself
- anything inferred rather than observed

Rules:
- Each memory is ONE self-contained sentence, understandable with no other context.
- Write in THE SAME LANGUAGE the assignment is written in.
- Write in the first person plural about the work ("Das Projekt ..." / "The repository ...").
- Resolve relative dates to absolute ones using the CURRENT DATE given below.
- importance: 0.9 hard constraints, 0.7 structure and conventions, 0.5 useful context, 0.3 minor.
- Extracting nothing is the correct answer most of the time.

Reply with a JSON array ONLY, no prose, no code fence:
[{"kind":"project","content":"The API lives in packages/server and uses Fastify.","tags":["server"],"importance":0.7}]
An empty array is []`;

export interface ExtractionInput {
  userText: string;
  assistantText: string;
  /** Content of memories already stored, so the model does not repeat them. */
  known?: string[];
  sessionId?: string;
  /** Small, fast model for this provider. */
  model?: string;
  /** Whose memory is being written: the assistant's about the user, or an agent's about its work. */
  perspective?: 'user' | 'agent';
}

/**
 * Ask the provider for memory candidates. Never throws: extraction is a
 * best-effort background step and must not fail the turn the user waited for.
 */
export async function extractMemories(
  provider: Provider,
  input: ExtractionInput,
  signal?: AbortSignal,
): Promise<MemoryCandidate[]> {
  const known = (input.known ?? []).slice(0, 40);
  const agent = input.perspective === 'agent';
  const prompt =
    (agent ? AGENT_EXTRACTION_PROMPT : EXTRACTION_PROMPT) +
    '\n\nCURRENT DATE: ' +
    new Date().toISOString().slice(0, 10) +
    '\n\nALREADY KNOWN:\n' +
    (known.length ? known.map((item) => '- ' + item).join('\n') : '(nothing yet)') +
    (agent ? '\n\nASSIGNMENT:\n' : '\n\nEXCHANGE\nUser: ') +
    clip(input.userText, 4000) +
    (agent ? '\n\nREPORT:\n' : '\nAssistant: ') +
    clip(input.assistantText, 4000);

  let output = '';
  try {
    for await (const event of provider.run({
      prompt,
      model: input.model,
      // Extraction is a background chore; it must never out-think the turn.
      effort: 'low',
      permission: 'chat',
      signal,
    })) {
      if (event.type === 'done') output = event.text || output;
      else if (event.type === 'text') output += event.delta;
      else if (event.type === 'error' && event.fatal) return [];
    }
  } catch {
    return [];
  }

  return parseCandidates(output);
}

/** Pull the JSON array out of a reply that may be wrapped in prose or a fence. */
export function parseCandidates(raw: string): MemoryCandidate[] {
  const text = raw.trim();
  if (!text) return [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const valid: MemoryKind[] = ['fact', 'preference', 'project', 'event', 'summary'];
  const seen = new Set<string>();
  const out: MemoryCandidate[] = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (content.length < 8 || content.length > 500) continue;

    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = valid.includes(record.kind as MemoryKind) ? (record.kind as MemoryKind) : 'fact';
    const importance =
      typeof record.importance === 'number' && Number.isFinite(record.importance)
        ? Math.min(1, Math.max(0, record.importance))
        : 0.5;
    const tags = Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 6)
      : [];

    out.push({ kind, content, tags, importance });
    if (out.length >= 8) break;
  }

  return out;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '\n[...clipped]';
}

/** The cheapest capable model per provider, used for extraction and titles. */
export function smallModelFor(providerId: string): string | undefined {
  if (providerId === 'claude') return 'haiku';
  return undefined;
}
