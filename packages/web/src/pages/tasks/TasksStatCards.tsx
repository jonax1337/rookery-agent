import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { StatCards } from '@/components/blocks/stat-cards';
import { RunningBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { formatNumber } from '@/lib/stats';
import type { StatusTally } from '@/pages/tasks/task-list';

interface TasksStatCardsProps {
  board: StatusTally;
  doneThisWeek: number;
  /** What the numbers rest on: top-level tasks, and how many of them are loaded. */
  basis: string;
}

export function TasksStatCards({ board, doneThisWeek, basis }: TasksStatCardsProps) {
  const notDone = board.failed + board.cancelled;

  return (
    <StatCards
      items={[
        {
          label: 'Open',
          value: <CountingNumber number={board.open + board.planned} />,
          badge: <Badge variant="outline">{formatNumber(board.planned)} planned</Badge>,
          headline: 'Waiting to run',
          footnote: basis,
        },
        {
          label: 'Running',
          value: <CountingNumber number={board.running} />,
          // `RunningBadge` renders nothing at 0, and the card must not reserve
          // an empty action slot for it.
          badge: board.running > 0 ? <RunningBadge count={board.running} /> : undefined,
          headline: board.running > 0 ? 'Agents are working' : 'No one is working right now',
          footnote: basis,
        },
        {
          label: 'Done',
          value: <CountingNumber number={board.done} />,
          headline: formatNumber(doneThisWeek) + ' this week',
          footnote: basis,
        },
        {
          label: 'Not done',
          value: <CountingNumber number={notDone} />,
          badge:
            board.failed > 0 ? (
              <Badge variant="destructive">{formatNumber(board.failed)} failed</Badge>
            ) : undefined,
          headline: 'Failed or cancelled',
          footnote: basis,
        },
      ]}
    />
  );
}
