/**
 * Query strings are not schema-validated in this server; they arrive as loose
 * text, so every route that reads a number or a switch from one goes through
 * these two instead of trusting it.
 */

/** A positive whole number from `raw`, `fallback` when it is missing or nonsense, never above `max`. */
export function clampPositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** `?flag=1`, `?flag=true` and `?flag=yes` switch something on; anything else leaves it off. */
export function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
