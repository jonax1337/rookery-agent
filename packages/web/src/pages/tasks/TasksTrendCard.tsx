import { useMemo } from 'react';

import { cappedBadge } from '@/components/blocks/stat-cards';
import { TrendChartCard } from '@/components/blocks/trend-chart-card';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EmptyState } from '@/components/common/empty-state';
import { bucketByDay, daysAgo, formatNumber, type DayPoint } from '@/lib/stats';
import type { Task } from '@/lib/types';
import { ClipboardEmptyIcon } from '@/pages/tasks/empty-state-icons';

const TREND_WINDOW_DAYS = 90;

type FinishedOutcome = 'done' | 'failed';

const FINISHED_OUTCOMES: readonly FinishedOutcome[] = ['done', 'failed'];

interface TasksTrendCardProps {
  /** Every loaded task, subtasks included. */
  tasks: readonly Task[];
  capped: boolean;
}

export function TasksTrendCard({ tasks, capped }: TasksTrendCardProps) {
  const trend = useFinishedTrend(tasks);
  const loaded = formatNumber(tasks.length);

  return (
    <TrendChartCard
      title="Completed tasks per day"
      description={
        'By completion date; cancelled tasks are excluded. Based on the ' +
        loaded +
        ' loaded tasks, including subtasks'
      }
      descriptionShort={loaded + ' loaded tasks'}
      data={trend}
      series={[
        { key: 'done', label: 'Done', color: 'var(--chart-2)' },
        { key: 'failed', label: 'Failed', color: 'var(--destructive)' },
      ]}
      {...cappedBadge(capped)}
      empty={
        <Fade>
          <EmptyState
            icon={ClipboardEmptyIcon}
            title="Nothing completed yet"
            description="This chart records each task when it completes or fails."
            variant="plain"
            size="sm"
          />
        </Fade>
      }
    />
  );
}

/** Finished tasks per local calendar day over the last 90 days, by outcome. */
function useFinishedTrend(tasks: readonly Task[]): DayPoint<FinishedOutcome>[] {
  return useMemo(() => {
    if (!tasks.some((task) => (task.finishedAt ?? 0) > 0)) return [];
    const until = Date.now();
    return bucketByDay<Task, FinishedOutcome>(tasks, (task) => task.finishedAt, {
      since: daysAgo(TREND_WINDOW_DAYS - 1, until),
      until,
      keys: FINISHED_OUTCOMES,
      // Only the two outcomes the chart claims: a cancelled task was stopped,
      // not attempted and failed, and folding it in would overstate failures.
      seriesOf: (task) =>
        task.status === 'done' || task.status === 'failed' ? task.status : null,
    });
  }, [tasks]);
}
