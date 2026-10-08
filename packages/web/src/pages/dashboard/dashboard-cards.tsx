import { LiveNumber } from '@/components/common/live-number';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import { RunningBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatNumber } from '@/lib/stats';
import type { MemoryStats, StatsTotals } from '@/lib/types';

export interface DashboardCardInput {
  totals: StatsTotals | null;
  memoryStats: MemoryStats | null;
  /** Memories learned in the last seven days. */
  newMemories: number;
  /** Agents with a replacement proposal waiting. */
  proposals: number;
  /** Agents flagged by the performance ladder. */
  flagged: number;
  teams: number;
  runningTasks: number;
}

const WAITING = <Skeleton className="h-7 w-20" />;

/** The four headline cards, in reading order. */
export function buildDashboardCards(input: DashboardCardInput): StatCardProps[] {
  return [memoriesCard(input), agentsCard(input), openTasksCard(input), conversationsCard(input)];
}

function liveTotal(totals: StatsTotals | null, key: keyof StatsTotals) {
  return totals ? <LiveNumber value={totals[key]} /> : WAITING;
}

function memoriesCard({ totals, memoryStats, newMemories }: DashboardCardInput): StatCardProps {
  return {
    label: 'Memories',
    value: liveTotal(totals, 'memories'),
    // "Learned", not "added": the day series counts every memory the assistant
    // wrote, the number above counts the ones still awake. A night that
    // compacts or puts to sleep what was learned this week lowers the number
    // without touching the badge, and the footnote below says so rather than
    // letting the two look like the same quantity.
    ...(newMemories > 0
      ? { badge: <Badge variant="outline">+{formatNumber(newMemories)} learned · 7 days</Badge> }
      : {}),
    ...(memoryStats
      ? {
          headline:
            formatNumber(memoryStats.pinned) +
            ' pinned · ' +
            formatNumber(memoryStats.dormant) +
            ' sleeping',
        }
      : {}),
    footnote:
      'Active, excluding sleeping and forgotten. Newly learned also includes memories consolidated since.',
    to: '/memory',
  };
}

function agentsCard({ totals, proposals, flagged, teams }: DashboardCardInput): StatCardProps {
  return {
    label: 'Agents',
    value: liveTotal(totals, 'agents'),
    ...agentsBadge(totals, proposals),
    headline: agentsHeadline(flagged, teams),
    footnote: 'Excluding archived agents',
    to: flagged > 0 ? '/org/performance' : '/org/agents',
  };
}

function agentsBadge(totals: StatsTotals | null, proposals: number): Pick<StatCardProps, 'badge'> {
  if (proposals > 0) {
    return { badge: <Badge variant="destructive">{formatNumber(proposals)} replacement proposed</Badge> };
  }
  if (totals && totals.runningAssignments > 0) {
    return { badge: <RunningBadge count={totals.runningAssignments} /> };
  }
  return {};
}

function agentsHeadline(flagged: number, teams: number): string {
  if (flagged > 0) {
    return formatNumber(flagged) + (flagged === 1 ? ' agent needs attention' : ' agents need attention');
  }
  return teams === 1 ? 'In a team' : 'In ' + formatNumber(teams) + ' teams';
}

function openTasksCard({ totals, runningTasks }: DashboardCardInput): StatCardProps {
  return {
    label: 'Open tasks',
    value: liveTotal(totals, 'openTasks'),
    ...(runningTasks > 0 ? { badge: <RunningBadge count={runningTasks} /> } : {}),
    headline: totals ? 'Of ' + formatNumber(totals.tasks) + ' tasks total' : ' ',
    footnote:
      'Open, planned, or running, including subtasks. The running badge counts top-level tasks only.',
    to: '/tasks',
  };
}

function conversationsCard({ totals }: DashboardCardInput): StatCardProps {
  return {
    label: 'Conversations',
    value: liveTotal(totals, 'sessions'),
    ...(totals && totals.archivedSessions > 0
      ? { badge: <Badge variant="outline">{formatNumber(totals.archivedSessions)} archived</Badge> }
      : {}),
    headline: totals ? formatNumber(totals.messages) + ' messages total' : ' ',
    footnote: 'Conversations excluding archive. Messages including archive.',
    to: '/chats',
  };
}
