/** One day in milliseconds: the unit the night counts every age and window in. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A hundred years: beyond that a retention span means "never sweep". */
const MAX_RETENTION_DAYS = 36_500;

/** An hour: past that the night is no longer a night. */
const MAX_WALL_CLOCK_MS = 3_600_000;

const MAX_COUNT = 1_000_000;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/**
 * A retention span in days, clamped for a config that bypassed the patch
 * schema (E21): `rookery config set` writes anything, so the night clamps
 * what it reads rather than trusting what was written. A negative span
 * would sweep everything, every night.
 */
export function clampDays(value: number): number {
  const days = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(MAX_RETENTION_DAYS, Math.max(0, days));
}

/**
 * A wall-clock span in milliseconds, clamped for a config that bypassed the
 * patch schema (E21), like `clampDays`.
 */
export function clampMs(value: number): number {
  const ms = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.min(MAX_WALL_CLOCK_MS, Math.max(0, ms));
}

/** A count of things, clamped, and never below one: zero would mean "always". */
export function clampCount(value: number): number {
  const count = Number.isFinite(value) ? Math.round(value) : 0;
  return Math.max(1, Math.min(MAX_COUNT, count));
}
