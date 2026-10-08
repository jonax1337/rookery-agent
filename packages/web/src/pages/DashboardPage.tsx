import { useMemo } from 'react';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards } from '@/components/blocks/stat-cards';
import { ActivityHeatmapCard } from '@/components/blocks/activity-heatmap-card';
import { ServerOffline } from '@/components/common/empty-state';
import { PlusIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { useDashboardStats } from '@/hooks/useDashboardStats';
import { usePerformanceAlerts } from '@/hooks/usePerformanceAlerts';
import { useProviderQuotas } from '@/hooks/useProviderQuotas';
import { fillDayGaps } from '@/lib/stats';
import { sumSince } from '@/lib/stats-window';
import type { StatsTotals } from '@/lib/types';
import {
  useChatSession,
  useConfig,
  useConnection,
  useMemoryState,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
import { buildDashboardCards } from './dashboard/dashboard-cards';
import { GetStarted } from './dashboard/GetStarted';
import { ProviderPanel } from './dashboard/ProviderPanel';
import { RecentActivity } from './dashboard/RecentActivity';
import { RECENT_ROWS } from './dashboard/recent-tabs';

/**
 * The one page that answers "what is going on" - and the reference
 * composition of the whole rebuild: `dashboard-01` in its intended order,
 * headline numbers, then the activity calendar, then the recent rows, then
 * the machine underneath. The area curve the original block puts here made
 * way for the calendar - one activity view that shows a quiet stretch as a
 * pale band beats a second axis to parse, and the curve still lives on the
 * tasks, assignments and memory pages where a range switch is wanted.
 *
 * Every figure here comes from `GET /api/stats`, which counts in the
 * database. That matters more than it sounds: before it existed, each total
 * was summed over a list the server had already cut off at 500, so the
 * dashboard quietly stopped being true the moment the system got busy. The
 * only numbers that still rest on a loaded list are the ones that are live by
 * nature - running tasks and assignments - and those say where they come
 * from.
 *
 * Growth is stated only where the API can prove it: nothing returns a
 * previous-period value, and "+12.5 % vs. last month" invented on the
 * client would be the most convincing lie on the page - so every badge here
 * counts forward ("learned · 7 days"), never against a fictive baseline.
 */

/** Days that count as "learned this week" for the memories badge. */
const NEW_MEMORY_DAYS = 7;

export function DashboardPage() {
  const { socket, offline, reload: reloadConnection } = useConnection();
  const { config, providers, assistantName } = useConfig();
  const { newConversation } = useChatSession();
  const org = useOrgState();
  const tasks = useTasksState();
  const { memories } = useMemoryState();
  const { stats, statsFailed, recentRuns, runsFailed, reload } = useDashboardStats(
    socket,
    RECENT_ROWS,
  );
  const { flagged, proposals } = usePerformanceAlerts();
  const quotas = useProviderQuotas(providers);

  // No breadcrumb of its own: `ROUTE_META` calls this page "Overview", and the
  // sidebar entry, the browser tab and the crumb have to agree on that name.
  usePageMeta(
    {
      // One primary action per page header. "Create task" used to sit
      // glued to this one in a ButtonGroup, which reads as a segmented control
      // for two unrelated things; the tabs below already lead to the tasks,
      // and /tasks carries that action as its own primary.
      actions: (
        <Button size="sm" onClick={newConversation}>
          <PlusIcon data-icon="inline-start" />
          New conversation
        </Button>
      ),
    },
    [newConversation],
  );

  const totals = stats?.totals ?? null;

  // The server leaves days with nothing on them out of the series; a
  // calendar drawn over that would show only the days that carried
  // something, and the empty ones - the quiet stretches, the story's pauses
  // - would vanish from the grid entirely.
  const chartData = useMemo(
    () => (stats ? fillDayGaps(stats.series, stats.since, stats.until) : []),
    [stats],
  );

  const cards = buildDashboardCards({
    totals,
    memoryStats: memories.stats,
    newMemories: sumSince(chartData, NEW_MEMORY_DAYS, (day) => day.memories),
    proposals,
    flagged,
    teams: org.teams.length,
    runningTasks: tasks.countByStatus.running,
  });

  if (statsFailed && !stats) {
    return (
      <PageBody width="3xl">
        <Fade>
          <ServerOffline onRetry={() => void Promise.all([reloadConnection(), reload()])} />
        </Fade>
      </PageBody>
    );
  }

  if (isFreshInstall(totals)) {
    return (
      <GetStarted
        assistantName={assistantName}
        onNewConversation={newConversation}
        providers={providers}
        quotas={quotas}
        defaultProvider={config?.defaultProvider}
      />
    );
  }

  return (
    <PageBody>
      <Fade>
        <StatCards items={cards} />
      </Fade>

      {/*
        The activity view: the same window the headline numbers rest on,
        drawn as a calendar. A three-week drought reads as a pale stretch
        here - a curve would average it into a gentle dip.
      */}
      <Fade delay={50}>
        <div className="px-4 lg:px-6">
          <ActivityHeatmapCard data={chartData} tokensAvailable={stats?.tokensAvailable ?? false} />
        </div>
      </Fade>

      <RecentActivity
        totals={totals}
        recentRuns={recentRuns}
        runsFailed={runsFailed}
        onRetryRuns={() => void reload()}
      />

      <Fade delay={150}>
        <div className="px-4 lg:px-6">
          <ProviderPanel
            providers={providers}
            quotas={quotas}
            defaultProvider={config?.defaultProvider}
            offline={offline}
          />
        </div>
      </Fade>
    </PageBody>
  );
}

/**
 * "Nothing at all" is a different page from "nothing loaded yet": only a
 * snapshot that came back with zeroes everywhere means a fresh install.
 */
function isFreshInstall(totals: StatsTotals | null): boolean {
  return (
    totals !== null &&
    totals.sessions === 0 &&
    totals.messages === 0 &&
    totals.tasks === 0 &&
    totals.assignments === 0 &&
    totals.memories === 0
  );
}
