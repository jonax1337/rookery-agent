import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { EMPTY_CELL } from '@/components/blocks/data-table/table-columns';
import { StatCards, cappedBadge } from '@/components/blocks/stat-cards';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import { Badge } from '@/components/ui/badge';
import { formatDuration } from '@/lib/format';
import { average } from '@/lib/stats';
import type { Assignment, MemoryRecord } from '@/lib/types';

import { ASSIGNMENT_LIMIT, MEMORY_LIMIT, isAtLimit } from './agentLimits';

/** Runs, failures, average duration and memories - all counted over what the server returned. */
export function AgentStatCards({
  assignments,
  memories,
}: {
  assignments: Assignment[];
  memories: MemoryRecord[];
}) {
  const failedCount = assignments.filter((entry) => entry.status === 'failed').length;
  const cancelledCount = assignments.filter((entry) => entry.status === 'cancelled').length;
  const doneDurations = assignments
    .filter((entry) => entry.status === 'done' && (entry.durationMs ?? 0) > 0)
    .map((entry) => entry.durationMs ?? 0);
  const meanDuration = formatDuration(Math.round(average(doneDurations)));

  const cards: StatCardProps[] = [
    {
      label: 'Runs',
      value: <CountingNumber number={assignments.length} />,
      ...cappedBadge(isAtLimit(assignments, ASSIGNMENT_LIMIT)),
      headline: assignments.length === 0 ? 'Nothing assigned yet' : 'Runs handed to this agent',
      footnote: 'The server returns the latest ' + ASSIGNMENT_LIMIT,
    },
    {
      label: 'Failed',
      value: <CountingNumber number={failedCount} />,
      ...(cancelledCount > 0
        ? { badge: <Badge variant="outline">{cancelledCount} cancelled</Badge> }
        : {}),
      headline: failedCount === 0 ? 'Nothing has failed' : 'Failures with error messages',
      footnote: 'Among the ' + assignments.length + ' loaded assignments',
    },
    {
      label: 'Average duration',
      value: meanDuration || EMPTY_CELL,
      headline: doneDurations.length === 0 ? 'Nothing completed yet' : 'From start to response',
      footnote: 'Across ' + doneDurations.length + ' finished runs',
    },
    {
      label: 'Memories',
      value: <CountingNumber number={memories.length} />,
      ...cappedBadge(isAtLimit(memories, MEMORY_LIMIT)),
      headline: memories.length === 0 ? 'Nothing learned yet' : 'Own memory',
      footnote: 'The server returns the latest ' + MEMORY_LIMIT,
    },
  ];

  return <StatCards items={cards} />;
}
