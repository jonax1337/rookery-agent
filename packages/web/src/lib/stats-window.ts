import { dayKey } from './stats';
import type { StatsDay } from './types';

/**
 * First day of a range, as the `YYYY-MM-DD` key the series is keyed by.
 *
 * Stepping with `setDate` instead of subtracting milliseconds is what keeps
 * the window right across a DST change.
 */
function windowStartKey(days: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return dayKey(start);
}

/** Sums one field of the series over the last `days` days. */
export function sumSince(
  series: readonly StatsDay[],
  days: number,
  pick: (day: StatsDay) => number,
): number {
  const from = windowStartKey(days);
  let total = 0;
  // Day keys sort lexicographically because they are zero-padded, so the
  // comparison needs no date parsing.
  for (const day of series) if (day.day >= from) total += pick(day);
  return total;
}
