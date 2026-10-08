import type { Provider } from '../types.js';
import type { Logger } from '../logger.js';

/** Which model a phase speaks to, and until when it may keep talking. */
export interface Voice {
  provider: Provider;
  model: string | undefined;
  signal: AbortSignal;
  log: Logger;
}

/** One phase's footing: whose bank, which run, and the model it speaks to. */
export interface PhaseScope {
  owner: string;
  runId: string;
  voice: Voice;
}

/**
 * One small-model call. Never throws; an empty string means "nothing usable".
 * A failure is said out loud in the log - the night goes on without the
 * answer, but "nothing usable" and "the provider is down" must not look alike.
 * A cancelled night is the one failure that is expected, and stays quiet.
 */
export async function ask(voice: Voice, prompt: string): Promise<string> {
  const { provider, model, signal, log } = voice;
  let output = '';
  try {
    for await (const event of provider.run({
      prompt,
      model,
      // Housekeeping must never out-think the work it is tidying up after.
      effort: 'low',
      permission: 'chat',
      signal,
    })) {
      if (event.type === 'done') output = event.text || output;
      else if (event.type === 'text') output += event.delta;
      else if (event.type === 'error' && event.fatal) {
        log.warn('A sleep model call ended in a fatal error', { error: event.message });
        return output;
      }
    }
  } catch (cause) {
    if (!signal.aborted) log.warn('A sleep model call failed', { error: (cause as Error).message });
    return '';
  }
  return output;
}

/** Pull one JSON object out of a reply that may carry prose or a fence. */
export function parseObject(raw: string): Record<string, unknown> | null {
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

/**
 * The first `limit` entries of a reply's list that are objects. Anything
 * else - a missing list, a string, a null among the rows - reads as nothing:
 * a model's list is evidence to check, never structure to trust. The limit
 * applies BEFORE the object filter, so a junk row still uses up its slot.
 */
export function objectRows(
  value: unknown,
  limit = Number.POSITIVE_INFINITY,
): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, limit)
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object');
}

/** A string field, trimmed; empty when the field is absent or not a string. */
export function trimmed(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** A task or an error trimmed to the part that still says something. */
export function clipText(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  return flat.length <= max ? flat : flat.slice(0, max) + ' [...]';
}
