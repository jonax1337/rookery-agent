import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { TASK_STATUS_LABEL, timeAgo } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Agent, Task } from '@/lib/types';
import { runtimeOf } from '@/pages/tasks/task-detail';

interface TaskStatsProps {
  task: Task;
  assignee: Agent | null;
  subtasks: readonly Task[];
  runCount: number;
  /** Runs that are pending or running. */
  openRunCount: number;
}

export function TaskStats({ task, assignee, subtasks, runCount, openRunCount }: TaskStatsProps) {
  const cards: StatCardProps[] = [
    statusCard(task, assignee),
    subtasksCard(subtasks),
    runsCard(runCount, openRunCount),
    durationCard(task),
  ];
  return <StatCards items={cards} />;
}

function statusCard(task: Task, assignee: Agent | null): StatCardProps {
  return {
    label: 'Status',
    value: TASK_STATUS_LABEL[task.status],
    badge: <StatusBadge kind="priority" status={task.priority} />,
    headline: assignee ? assignee.name + ' is assigned' : 'No assignee yet',
    footnote: 'Last updated ' + timeAgo(task.updatedAt),
  };
}

function subtasksCard(subtasks: readonly Task[]): StatCardProps {
  const done = subtasks.filter((child) => child.status === 'done').length;
  const total = subtasks.length;

  return {
    label: 'Subtasks',
    value:
      total > 0 ? (
        <>
          <CountingNumber number={done} />
          {'/'}
          {total}
        </>
      ) : (
        '–'
      ),
    headline:
      total === 0
        ? 'Not split into subtasks'
        : done === total
          ? 'All done'
          : formatNumber(total - done) + ' still open',
    footnote: total === 0 ? 'Planning defines the subtasks' : 'From the loaded task list',
  };
}

function runsCard(runCount: number, openRunCount: number): StatCardProps {
  return {
    label: 'Runs',
    value: <CountingNumber number={runCount} />,
    // Not `RunningBadge`: this counts pending *and* running, which is a
    // different state than "running". It borrows the look, not the word.
    ...(openRunCount > 0
      ? {
          badge: (
            <Badge variant="secondary" className="animate-pulse tabular-nums">
              {openRunCount} open
            </Badge>
          ),
        }
      : {}),
    headline: runCount === 0 ? 'No runs yet' : 'Assignments for this task',
    footnote: 'This task and its subtasks',
  };
}

function durationCard(task: Task): StatCardProps {
  const { startedAt, finishedAt } = task;
  return {
    label: 'Duration',
    value: runtimeOf(task),
    headline:
      finishedAt && startedAt
        ? 'From start to finish'
        : startedAt
          ? 'Since the start'
          : 'Not started yet',
    footnote: startedAt ? 'Started ' + formatDateTime(startedAt) : 'No start time',
  };
}
