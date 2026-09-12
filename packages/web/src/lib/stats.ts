import type { StatsDay } from './types';

/**
 * Numbers and time series for the dashboard-shaped pages.
 *
 * Two jobs live here. The first is arithmetic the UI kept re-deriving by
 * hand: day buckets, share-of-total, means, "how many since". The second is
 * formatting, always `en-GB`, so every page uses the same English number and
 * date conventions.
 *
 * Gap filling is deliberately the client's job. `GET /api/stats` leaves days
 * with nothing on them out of its series, because only the caller knows which
 * window it means to draw; `fillDayGaps` closes them for that window.
 */

const DAY_IN_MS = 86_400_000;

/**
 * Ceiling on how many days one bucket run may emit. A single bad timestamp
 * (a seconds-based epoch, say) would otherwise spin a loop for decades.
 */
const MAX_DAYS = 1000;

/* ------------------------------- day keys -------------------------------- */

/**
 * Local midnight of the day a timestamp falls in.
 *
 * Local, not UTC, on purpose: the server groups by `localtime` too, and it
 * runs on the same machine as the reader. Tuesday has to mean their Tuesday,
 * or the whole curve slides a day.
 */
export function startOfDay(value: number | Date = Date.now()): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Epoch milliseconds `days` whole days back, for "in den letzten 7 Tagen". */
export function daysAgo(days: number, now: number = Date.now()): number {
  return now - days * DAY_IN_MS;
}

/** `YYYY-MM-DD` of the local calendar day - the same key the server sends. */
export function dayKey(value: number | Date): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A `YYYY-MM-DD` key back to a Date at local midnight.
 *
 * `new Date('2026-09-11')` would parse as UTC midnight, which is the previous
 * day west of Greenwich - a bug that only shows up on someone else's machine.
 */
function dayDate(key: string): Date {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
}

/** Accepts what the API hands out: epoch ms, an ISO string, a `YYYY-MM-DD` key. */
function toDate(value: number | string | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? dayDate(value) : new Date(value);
}

/* ------------------------------- bucketing ------------------------------- */

/**
 * One day of a chart series: the day key, its local midnight, and one count
 * per series name. Flat on purpose - recharts reads `dataKey="<series>"`
 * straight off the row.
 */
export type DayPoint<K extends string = 'count'> = { day: string; at: number } & Record<K, number>;

export interface BucketOptions<T, K extends string> {
  /** First day of the window. Defaults to the earliest dated item. */
  since?: number;
  /** Last day of the window. Defaults to today. */
  until?: number;
  /**
   * Which series an item counts towards. Returning `null` drops it, which is
   * how "only the finished ones" is expressed without pre-filtering.
   */
  seriesOf?: (item: T) => K | null | undefined;
  /**
   * Every series the result must carry, even the ones nothing landed in - a
   * chart legend should not appear and disappear with the data.
   */
  keys?: readonly K[];
  /** Count something other than rows, e.g. a message count per conversation. */
  weight?: (item: T) => number;
}

/**
 * Buckets items into local calendar days, gaps filled with zeroes.
 *
 * Undated items are skipped rather than lumped onto today: a task without a
 * `finishedAt` has not finished, and drawing it as if it had would be an
 * invented number.
 */
export function bucketByDay<T, K extends string = 'count'>(
  items: readonly T[],
  getTime: (item: T) => number | null | undefined,
  options: BucketOptions<T, K> = {},
): DayPoint<K>[] {
  const { seriesOf, weight } = options;

  const tally = new Map<string, Map<string, number>>();
  const collected: string[] = [];
  let earliest = Number.POSITIVE_INFINITY;

  const until = options.until ?? Date.now();
  const lowerBound = options.since;

  for (const item of items) {
    const at = getTime(item);
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    if (at > until) continue;
    if (lowerBound !== undefined && at < startOfDay(lowerBound)) continue;

    const series = seriesOf ? seriesOf(item) : ('count' as K);
    if (series === null || series === undefined) continue;

    if (at < earliest) earliest = at;
    const key = dayKey(at);
    let row = tally.get(key);
    if (!row) {
      row = new Map();
      tally.set(key, row);
    }
    row.set(series, (row.get(series) ?? 0) + (weight ? weight(item) : 1));
    if (!collected.includes(series)) collected.push(series);
  }

  // An explicit key list wins; otherwise the keys the data actually produced,
  // in first-seen order, so a single-series call still gets `count`.
  const keys: readonly K[] =
    options.keys ??
    (collected.length ? (collected as K[]) : seriesOf ? [] : (['count'] as unknown as K[]));

  const since = options.since ?? (Number.isFinite(earliest) ? earliest : until);
  return walkDays(since, until, (key, at) => {
    const row = tally.get(key);
    const point: Record<string, number | string> = { day: key, at };
    for (const series of keys) point[series] = row?.get(series) ?? 0;
    return point as unknown as DayPoint<K>;
  });
}

/**
 * Closes the holes in `StatsSnapshot.series`.
 *
 * The server leaves a day out when nothing happened on it, and says so in its
 * contract. An area chart over that raw array would draw a straight line from
 * Monday to Friday as if Wednesday had been busy; this puts the zeroes back.
 */
export function fillDayGaps(
  series: readonly StatsDay[],
  since: number,
  until: number = Date.now(),
): StatsDay[] {
  const byDay = new Map(series.map((entry) => [entry.day, entry]));
  return walkDays(since, until, (key) => byDay.get(key) ?? emptyDay(key));
}

function emptyDay(day: string): StatsDay {
  return {
    day,
    sessions: 0,
    messages: 0,
    assignments: 0,
    tasks: 0,
    cronRuns: 0,
    memories: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/**
 * Every local calendar day from `since` to `until`, both inclusive.
 *
 * Stepping with `setDate(+1)` rather than adding 86 400 000 ms is what keeps
 * the axis honest across a DST change, where one day is 23 or 25 hours long.
 */
function walkDays<T>(since: number, until: number, make: (day: string, at: number) => T): T[] {
  const cursor = new Date(startOfDay(since));
  const last = startOfDay(until);
  const out: T[] = [];
  while (cursor.getTime() <= last && out.length < MAX_DAYS) {
    out.push(make(dayKey(cursor), cursor.getTime()));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/* -------------------------------- counting ------------------------------- */

/**
 * How many items happened at or after `since`. The basis of every
 * "+N in 7 Tagen" badge, which is the only growth figure the API can prove.
 */
export function countSince<T>(
  items: readonly T[],
  getTime: (item: T) => number | null | undefined,
  since: number,
): number {
  let count = 0;
  for (const item of items) {
    const at = getTime(item);
    if (typeof at === 'number' && Number.isFinite(at) && at >= since) count += 1;
  }
  return count;
}

/** Arithmetic mean; 0 for an empty list, so a card never renders `NaN`. */
export function average(values: readonly number[]): number {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += Number.isFinite(value) ? value : 0;
  return sum / values.length;
}

/**
 * `part` as a share of `total`, 0..100. A total of zero is 0 %, not a
 * division by zero - "none of nothing" is the answer a card should show.
 */
export function ratePercent(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return (part / total) * 100;
}

/* ------------------------------- formatting ------------------------------- */

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options ?? {});
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat('en-GB', options);
    numberFormats.set(key, format);
  }
  return format;
}

/** A plain count with German thousands separators: `12.345`. */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return '–';
  return numberFormat(options).format(value);
}

/**
 * A share, given as 0..100 the way `ratePercent` returns it. German puts a
 * non-breaking space before the sign, which `Intl` does for us.
 */
export function formatPercent(percent: number, fractionDigits = 0): string {
  if (!Number.isFinite(percent)) return '–';
  return numberFormat({
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(percent / 100);
}

/** `11. Sep. 2026`. Takes epoch ms, an ISO string or a `YYYY-MM-DD` day key. */
export function formatDate(value: number | string | Date | undefined): string {
  if (!value) return '–';
  return toDate(value).toLocaleDateString('en-GB', { dateStyle: 'medium' });
}

/**
 * `11. Sep. 2026, 14:03`.
 *
 * The one implementation in the app: `lib/format.ts` and `lib/cron.ts`
 * re-export this so the existing imports keep working and no second copy
 * drifts away from it.
 */
export function formatDateTime(value: number | string | Date | undefined): string {
  if (!value) return '–';
  return toDate(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Short enough for a chart axis: `11. Sep`. */
export function formatDayAxis(value: number | string | Date): string {
  return toDate(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
