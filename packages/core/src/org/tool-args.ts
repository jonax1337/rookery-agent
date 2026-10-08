import type { MemoryKind, PermissionLevel, QuestionOption, TaskPriority } from '../types.js';
import type { ToolCallResult } from './bridge.js';

export function toolError(message: string): ToolCallResult {
  return { text: message, isError: true };
}

/**
 * The arguments of one tool call, read defensively: they come from a model's
 * JSON, which is never trusted to have the shape the schema promises.
 */
export class ToolArgs {
  readonly #values: Record<string, unknown>;

  constructor(values: Record<string, unknown>) {
    this.#values = values;
  }

  /** A string argument, trimmed; empty when missing or not a string. */
  text(key: string): string {
    const value = this.#values[key];
    return typeof value === 'string' ? value.trim() : '';
  }

  /** A boolean argument; undefined when missing or not a boolean. */
  flag(key: string): boolean | undefined {
    const value = this.#values[key];
    return typeof value === 'boolean' ? value : undefined;
  }

  /** A comma-separated string argument as its non-empty, trimmed parts. */
  list(key: string): string[] {
    return this.text(key)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }

  /** A number argument within bounds; the fallback when it is missing or not a number. */
  number(key: string, min: number, max: number, fallback: number): number {
    const value = this.#values[key];
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  /** Whether the caller passed the argument at all, whatever its value. */
  has(key: string): boolean {
    return this.#values[key] !== undefined;
  }

  /** The argument exactly as it came in, for the few callers that read it themselves. */
  raw(key: string): unknown {
    return this.#values[key];
  }
}

export function asMemoryKind(value: string): MemoryKind {
  return value === 'preference' || value === 'project' || value === 'event' ? value : 'fact';
}

export function asPriority(value: string): TaskPriority | undefined {
  return value === 'low' || value === 'normal' || value === 'high' ? value : undefined;
}

export function asPermission(value: string): PermissionLevel | undefined {
  return value === 'chat' || value === 'read' || value === 'write' || value === 'full' ? value : undefined;
}

/**
 * The `ask_user` options, read defensively. The schema says objects with a
 * label, but a model that answers a list of strings is asking the same
 * question and should not be sent back round for a formality; anything
 * without readable text is dropped rather than shown as an empty button.
 */
export function asQuestionOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: QuestionOption[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const label = entry.trim();
      if (label) options.push({ label });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (!label) continue;
    const description = typeof record.description === 'string' ? record.description.trim() : '';
    options.push(description ? { label, description } : { label });
  }
  return options;
}

/** A lookup that either found something (or was not asked for), or already carries the failure to return. */
export type Resolved<T> = { ok: true; value: T } | { ok: false; error: ToolCallResult };

/**
 * An optional reference argument: nothing named is `null`, a name that
 * matches nothing is the failure to hand back.
 */
export function resolveOptional<T>(
  ref: string,
  find: (ref: string) => T | null,
  notFound: (ref: string) => string,
): Resolved<T | null> {
  if (!ref) return { ok: true, value: null };
  const found = find(ref);
  return found ? { ok: true, value: found } : { ok: false, error: toolError(notFound(ref)) };
}

/**
 * A reference field of an update tool: one of `clearWords` clears it (`null`),
 * anything else names the entry whose id is wanted.
 */
export function resolveClearable<T extends { id: string }>(
  ref: string,
  clearWords: readonly string[],
  find: (ref: string) => T | null,
  notFound: (ref: string) => string,
): Resolved<string | null> {
  if (clearWords.includes(ref.toLowerCase())) return { ok: true, value: null };
  const found = find(ref);
  return found ? { ok: true, value: found.id } : { ok: false, error: toolError(notFound(ref)) };
}
