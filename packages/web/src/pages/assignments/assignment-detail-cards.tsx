import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { RotatingText, RotatingTextContainer } from '@/components/animate-ui/primitives/texts/rotating';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import { RunningBadge } from '@/components/common/status-badge';
import { ASSIGNMENT_STATUS_LABEL, formatDuration, relativeTime, timeAgo } from '@/lib/format';
import { formatDateTime } from '@/lib/stats';
import type { Agent, Assignment, AssignmentStatus } from '@/lib/types';

import { isOpenStatus } from './assignment-row';

interface DetailCardsInput {
  assignment: Assignment;
  /** The live status where the socket has one. */
  status: AssignmentStatus;
  agent: Agent | null;
  /** The live view wins where it has something to say: newer than the stored row. */
  chars: number;
  durationMs: number | undefined;
  delegatedCount: number;
}

/** The four numbers under the facts: status, duration, characters, delegation. */
export function buildDetailCards(input: DetailCardsInput): StatCardProps[] {
  return [
    statusCard(input),
    durationCard(input),
    charactersCard(input.chars),
    delegatedCard(input.delegatedCount),
  ];
}

function statusCard({ assignment, status, agent }: DetailCardsInput): StatCardProps {
  return {
    label: 'Status',
    // The one label on the page that changes on its own (pending → running →
    // done), so it gets the rotating treatment.
    value: (
      <RotatingTextContainer text={ASSIGNMENT_STATUS_LABEL[status]}>
        <RotatingText />
      </RotatingTextContainer>
    ),
    ...(isOpenStatus(status) ? { badge: <RunningBadge count={1} /> } : {}),
    headline: agent ? agent.name + ' is handling it' : 'Agent unknown',
    footnote: 'Created ' + timeAgo(assignment.createdAt),
  };
}

function durationCard({ assignment, status, durationMs }: DetailCardsInput): StatCardProps {
  return {
    label: 'Duration',
    value: formatDuration(durationMs) || '–',
    headline:
      isOpenStatus(status) && assignment.startedAt
        ? 'Running since ' + relativeTime(assignment.startedAt)
        : durationMs
          ? 'From start to response'
          : 'Not started yet',
    footnote: assignment.startedAt
      ? 'Started ' + formatDateTime(assignment.startedAt)
      : 'No start time',
  };
}

function charactersCard(chars: number): StatCardProps {
  return {
    label: 'Characters',
    // Sliding, not counting: `live.chars` keeps moving while the run streams,
    // and the rollers follow. `formatNumber` groups with commas (en-GB), so
    // the separator is passed through to keep the resting digits identical.
    value: chars > 0 ? <SlidingNumber number={chars} thousandSeparator="," /> : '–',
    headline: chars > 0 ? 'Response length' : 'Nothing written yet',
    // Not a hedge but the plain truth: the run's row carries `chars`
    // and nothing else - no tokens, no cost (see serverGaps).
    footnote: 'The server counts characters, not tokens',
  };
}

function delegatedCard(delegatedCount: number): StatCardProps {
  return {
    label: 'Delegated',
    value: <CountingNumber number={delegatedCount} />,
    headline: delegatedCount === 0 ? 'Completed without delegation' : 'Handed on to other agents',
    footnote: 'Directly from this run',
  };
}
