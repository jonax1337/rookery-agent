import type { StatsTotals } from '@/lib/types';

/** How many rows the "Recent" table shows per facet. A preview, not a list. */
export const RECENT_ROWS = 10;

export type RecentTab = 'tasks' | 'assignments' | 'sessions';

/** Where "Show all" goes, per facet. */
export const TAB_TARGET: Record<RecentTab, string> = {
  tasks: '/tasks',
  assignments: '/assignments',
  sessions: '/chats',
};

/** The facet shown until someone picks one: the first that has anything in it. */
export function defaultRecentTab(totals: StatsTotals | null): RecentTab {
  if (!totals || totals.tasks > 0) return 'tasks';
  return totals.assignments > 0 ? 'assignments' : 'sessions';
}
