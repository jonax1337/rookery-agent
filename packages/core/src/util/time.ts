/**
 * Time as a model must read it: the machine's own wall clock, never UTC.
 *
 * Every timestamp in the database is epoch milliseconds, so arithmetic is
 * already timezone-proof. What was not proof was the rendering: the schedule
 * prompt printed a local "now" while `list_runs` printed UTC start times, and
 * a model asked to judge "has this been running too long" subtracted one from
 * the other. In any zone east or west of Greenwich that is a phantom age -
 * two hours in CEST - and the board watcher acted on it, restarting healthy
 * runs it believed had hung.
 *
 * Hence one rule, in one place: a model is told the zone it is in, reads wall
 * clocks in that zone, and gets an elapsed span wherever the question is
 * "how long", because a span needs no zone at all.
 */

/** The machine's timezone, e.g. `Europe/Berlin`. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The machine's current offset from UTC, e.g. `UTC+2` or `UTC-05:30`. */
export function localOffset(at: number = Date.now()): string {
  const minutes = -new Date(at).getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return 'UTC' + sign + hours + (rest ? ':' + String(rest).padStart(2, '0') : '');
}

/** A local calendar date, `18 Sept 2026`. Never the UTC date. */
export function formatDay(at: number): string {
  return new Date(at).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/** A local wall clock, `18 Sept 2026, 04:12`. */
export function formatWhen(at: number): string {
  return new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * How long ago, compactly: `42s`, `12m`, `3h`, `2d`. The answer to "has this
 * been running too long" that no timezone can spoil.
 *
 * `minUnit` is where the reader's patience starts. A live run is worth
 * counting in seconds; a card that has been waiting for an answer is not, and
 * "waiting 0s" on a board is noise dressed as precision.
 */
export function formatAge(at: number, now: number = Date.now(), minUnit: 'second' | 'minute' = 'second'): string {
  const ms = Math.max(0, now - at);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return days + 'd';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return hours + 'h';
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 1 || minUnit === 'minute') return minutes + 'm';
  return Math.floor(ms / 1000) + 's';
}

/**
 * The anchor a prompt opens with: which day it is, what time it is, and in
 * which zone - so that every other stamp in the same prompt has something
 * true to be compared against.
 */
export function formatNow(now: number = Date.now()): string {
  return formatWhen(now) + ' (' + localZone() + ', ' + localOffset(now) + ')';
}
