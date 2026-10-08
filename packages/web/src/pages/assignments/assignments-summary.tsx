import { useMemo } from 'react';

import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { RunningBadge } from '@/components/common/status-badge';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import type { TrendSeries } from '@/components/blocks/trend-chart-card';
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/format';
import {
  average,
  bucketByDay,
  daysAgo,
  formatNumber,
  formatPercent,
  ratePercent,
  startOfDay,
  type DayPoint,
} from '@/lib/stats';
import type { Assignment, AssignmentStatus, AssignmentView, StatsTotals } from '@/lib/types';

import { ASSIGNMENT_LIMIT } from './use-assignments-data';

/** How many days the curve spans, today included. */
const CHART_DAYS = 90;

/**
 * Chart bands: the outcomes an assignment can stand in today.
 *
 * The curve is dated by `createdAt`, so a band says "this many of the
 * assignments created that day ended like this" - not "this many finished
 * that day". Assignments still pending or running carry no outcome yet and
 * are left out rather than guessed at; the card description spells both
 * halves out, because "stacked by completion" read as a completion curve
 * and was the wrong sentence for this data.
 */
type ChartKey = 'done' | 'failed' | 'cancelled';

export const CHART_SERIES: TrendSeries[] = [
  { key: 'done', label: 'Done', color: 'var(--chart-1)' },
  { key: 'failed', label: 'Failed', color: 'var(--chart-5)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--chart-3)' },
];

const CHART_KEYS: ChartKey[] = ['done', 'failed', 'cancelled'];

type StatusCounts = Record<AssignmentStatus, number>;

/** The live status wins over the loaded record, as in every table row. */
function currentStatus(
  assignment: Assignment,
  live: Record<string, AssignmentView>,
): AssignmentStatus {
  return live[assignment.id]?.status ?? assignment.status;
}

function tallyStatuses(
  assignments: readonly Assignment[],
  live: Record<string, AssignmentView>,
): StatusCounts {
  const tally: StatusCounts = { pending: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
  for (const assignment of assignments) tally[currentStatus(assignment, live)] += 1;
  return tally;
}

function meanDoneDuration(assignments: readonly Assignment[]): number {
  return average(
    assignments.flatMap((assignment) =>
      assignment.status === 'done' && assignment.durationMs && assignment.durationMs > 0
        ? [assignment.durationMs]
        : [],
    ),
  );
}

function describeBasis(loaded: number, totals: StatsTotals | null): string {
  const latest = 'Based on the latest ' + formatNumber(loaded);
  return totals
    ? latest + ' of ' + formatNumber(totals.assignments) + ' assignments'
    : latest + ' Assignments';
}

/**
 * The number cards roll their digits rather than count: the counts keep
 * changing with the socket, and only SlidingNumber holds formatNumber's
 * en-GB grouping ("1,234") once it settles - CountingNumber would drop the
 * separator and change the resting pose.
 */
function rollingNumber(value: number) {
  return <SlidingNumber number={value} thousandSeparator="," />;
}

function runningCard(running: number): StatCardProps {
  return {
    label: 'Running now',
    value: rollingNumber(running),
    ...(running > 0 ? { badge: <RunningBadge count={running} /> } : {}),
    headline: running > 0 ? 'The organization is working' : 'No work in progress',
    // The one card that is not an estimate at all: the socket knows every
    // run that is open right now, capped list or not.
    footnote: 'From the current organization state',
  };
}

function completedCard(counts: StatusCounts, loaded: number, basis: string): StatCardProps {
  return {
    label: 'Completed',
    value: rollingNumber(counts.done),
    headline:
      loaded > 0
        ? formatPercent(ratePercent(counts.done, loaded)) + ' of loaded assignments'
        : 'Nothing completed yet',
    footnote: basis,
  };
}

function failedCard(counts: StatusCounts, loaded: number, basis: string): StatCardProps {
  return {
    label: 'Failed',
    value: rollingNumber(counts.failed),
    ...(counts.cancelled > 0
      ? {
          badge: (
            <Badge variant="destructive">{formatNumber(counts.cancelled)} cancelled</Badge>
          ),
        }
      : {}),
    headline:
      loaded > 0
        ? formatPercent(ratePercent(counts.failed, loaded)) + ' of loaded assignments'
        : 'No failures yet',
    footnote: basis,
  };
}

function durationCard(meanDuration: number, doneCount: number, basis: string): StatCardProps {
  return {
    label: 'Average duration',
    value: meanDuration > 0 ? formatDuration(meanDuration) : '–',
    headline: 'Across ' + formatNumber(doneCount) + ' completed assignments',
    footnote: basis,
  };
}

export interface AssignmentsSummary {
  /** Per-status counts over the unfiltered window, live status applied. */
  counts: StatusCounts;
  /** True once the window hangs exactly at the server's cap: counts are then a floor. */
  capped: boolean;
  /** The footnote every estimate carries: how much it is based on. */
  basis: string;
  cards: StatCardProps[];
  chartData: DayPoint<ChartKey>[];
}

/**
 * Everything above the table, derived from the unfiltered window.
 *
 * The cards that count states count over that window, never over whatever the
 * status tab narrowed the request to - otherwise "Completed" would read 500 on
 * the "Done" tab. Nothing claims a total the API cannot prove: only
 * `totals` (from `GET /api/stats`) is real, everything else names the loaded
 * window in its footnote.
 */
export function useAssignmentsSummary({
  base,
  live,
  running,
  totals,
}: {
  base: Assignment[];
  live: Record<string, AssignmentView>;
  running: number;
  totals: StatsTotals | null;
}): AssignmentsSummary {
  const counts = useMemo(() => tallyStatuses(base, live), [base, live]);
  const meanDuration = useMemo(() => meanDoneDuration(base), [base]);

  const chartData = useMemo(
    () =>
      bucketByDay<Assignment, ChartKey>(base, (assignment) => assignment.createdAt, {
        since: startOfDay(daysAgo(CHART_DAYS - 1)),
        keys: CHART_KEYS,
        seriesOf: (assignment) => {
          const status = currentStatus(assignment, live);
          return status === 'done' || status === 'failed' || status === 'cancelled'
            ? status
            : null;
        },
      }),
    [base, live],
  );

  const basis = describeBasis(base.length, totals);
  const cards = [
    runningCard(running),
    completedCard(counts, base.length, basis),
    failedCard(counts, base.length, basis),
    durationCard(meanDuration, counts.done, basis),
  ];

  return { counts, capped: base.length >= ASSIGNMENT_LIMIT, basis, cards, chartData };
}
