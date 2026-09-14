import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  ActivityIcon,
  BotIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  PlusIcon,
  SendIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import { PROVIDER_LABEL, shorten } from '@/lib/format';
import { dayKey, fillDayGaps, formatDateTime, formatNumber } from '@/lib/stats';
import type {
  Assignment,
  ProviderId,
  ProviderQuota,
  ProviderStatus,
  Session,
  StatsDay,
  StatsSnapshot,
  Task,
} from '@/lib/types';
import { useAllSessions } from '@/hooks/useAllSessions';
import {
  useChatSession,
  useConfig,
  useConnection,
  useMemoryState,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { SectionHeading } from '@/components/blocks/section-heading';
import { StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import {
  TREND_RANGE_DAYS,
  TREND_RANGE_SUFFIX,
  TrendChartCard,
  type TrendRange,
  type TrendSeries,
} from '@/components/blocks/trend-chart-card';
import { DataTable, type DataTableTab } from '@/components/blocks/data-table/data-table';
import { relativeTimeCell } from '@/components/blocks/data-table/table-columns';
import {
  createRookeryColumnHelper,
  type RookeryColumnDef,
} from '@/components/blocks/data-table/table-features';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { ProviderCell } from '@/components/common/provider-cell';
import { buildSessionColumns } from '@/components/common/session-columns';
import { RunningBadge, StatusBadge } from '@/components/common/status-badge';
import { buildTaskColumns } from '@/components/common/task-columns';
import { ProviderIcon } from '@/components/provider-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The one page that answers "what is going on" - and the reference
 * composition of the whole rebuild: `dashboard-01` in its intended order,
 * headline numbers, then the curve, then the recent rows, then the machine
 * underneath.
 *
 * Every figure here comes from `GET /api/stats`, which counts in the
 * database. That matters more than it sounds: before it existed, each total
 * was summed over a list the server had already cut off at 500, so the
 * dashboard quietly stopped being true the moment the system got busy. The
 * only numbers that still rest on a loaded list are the ones that are live by
 * nature - running tasks and assignments - and those say where they come
 * from.
 *
 * The trend badge of the original block is still missing, and still on
 * purpose: nothing in the API returns a previous-period value, and
 * "+12,5 % gegenüber Vormonat" invented on the client would be the most
 * convincing lie on the page.
 */

/** How many rows the "Recent" table shows per facet. A preview, not a list. */
const RECENT_ROWS = 10;

/** The window the chart fetches. The range switch narrows it client-side. */
const CHART_DAYS = 90;

/** Org broadcasts arrive in bursts while work runs; one refetch per burst. */
const REFETCH_DEBOUNCE_MS = 400;

type RecentTab = 'tasks' | 'assignments' | 'sessions';

/** Where "Show all" goes, per facet. */
const TAB_TARGET: Record<RecentTab, string> = {
  tasks: '/tasks',
  assignments: '/assignments',
  sessions: '/chats',
};

/**
 * The three bands of the activity curve.
 *
 * The keys are the field names `StatsDay` already carries, so the server's
 * series is the chart's data with no mapping in between; the German is in
 * `label`, which is what the axis, the legend and the tooltip print.
 *
 * The three bands are not one population, and the card description says so:
 * the server counts sessions and messages over the whole database (archived
 * conversations included), assignments only within the active organisation.
 * With one company installed that is invisible; with a second one it would
 * be a chart quietly comparing different worlds.
 */
const ACTIVITY_SERIES: TrendSeries[] = [
  { key: 'messages', label: 'Messages', color: 'var(--chart-1)' },
  { key: 'sessions', label: 'Conversations', color: 'var(--chart-2)' },
  { key: 'assignments', label: 'Assignments', color: 'var(--chart-3)' },
];

const assignmentColumn = createRookeryColumnHelper<Assignment>();

/**
 * First day of a range, as the `YYYY-MM-DD` key the series is keyed by.
 *
 * Stepping with `setDate` instead of subtracting milliseconds is what keeps
 * the window right across a DST change - and it is exactly what
 * `TrendChartCard` does internally, so the tokens counted here cover the same
 * days the curve draws.
 */
function windowStartKey(days: number): string {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return dayKey(start);
}

/** Sums one field of the series over the last `days` days. */
function sumSince(series: readonly StatsDay[], days: number, pick: (day: StatsDay) => number) {
  const from = windowStartKey(days);
  let total = 0;
  // Day keys sort lexicographically because they are zero-padded, so the
  // comparison needs no date parsing.
  for (const day of series) if (day.day >= from) total += pick(day);
  return total;
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { socket, offline, reload } = useConnection();
  const { config, providers, assistantName } = useConfig();
  const { newConversation, openConversation } = useChatSession();
  const org = useOrgState();
  const tasks = useTasksState();
  const { memories } = useMemoryState();
  const sessions = useAllSessions(socket, { limit: RECENT_ROWS });

  // No breadcrumb of its own: `ROUTE_META` calls this page „Übersicht“, and the
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

  /* ------------------------------ the numbers ----------------------------- */

  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [statsFailed, setStatsFailed] = useState(false);
  const [recentRuns, setRecentRuns] = useState<Assignment[] | null>(null);
  const [runsFailed, setRunsFailed] = useState(false);

  // Sequence guard: the debounced socket refetch can overtake a load that is
  // still in flight; only the newest run may write state.
  const loadSeq = useRef(0);

  // Two requests, one refresh: the counts and the newest runs are the only
  // things on this page that have no hook of their own yet.
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    const [snapshot, runs] = await Promise.allSettled([
      api.stats({ days: CHART_DAYS }),
      api.assignments({ limit: RECENT_ROWS }),
    ]);
    if (seq !== loadSeq.current) return;
    if (snapshot.status === 'fulfilled') {
      setStats(snapshot.value);
      setStatsFailed(false);
    } else {
      setStatsFailed(true);
    }
    if (runs.status === 'fulfilled') {
      setRecentRuns(runs.value);
      setRunsFailed(false);
    } else {
      setRunsFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Anything the company does moves at least one of these counts, and a
  // dashboard that needs a reload to be current is a screenshot.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      socket.onChanged(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void load(), REFETCH_DEBOUNCE_MS);
      }),
    [socket, load],
  );
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const totals = stats?.totals ?? null;
  const memoryStats = memories.stats;

  /* -------------------------------- the curve ------------------------------ */

  const [range, setRange] = useState<TrendRange>('90d');

  // The server leaves days with nothing on them out of the series; an area
  // chart over that would draw a straight line from Monday to Friday as if
  // Wednesday had been busy.
  const chartData = useMemo(
    () => (stats ? fillDayGaps(stats.series, stats.since, stats.until) : []),
    [stats],
  );

  const newMemories = useMemo(
    () => sumSince(chartData, 7, (day) => day.memories),
    [chartData],
  );

  /**
   * Tokens over the days the curve currently shows.
   *
   * Two guards, and both of them are about the same lie. `tokensAvailable`
   * says whether the database holds usage data at all over the whole ninety
   * days; a zero sum says this particular window holds none of it - because
   * the range switch narrowed past the last measured day, or because a
   * provider wrote a usage object without token fields. Either way "0 Tokens"
   * would be a lie with a number on it, so the badge disappears instead.
   */
  const windowTokens = useMemo(() => {
    if (!stats?.tokensAvailable) return null;
    const sum = sumSince(
      chartData,
      TREND_RANGE_DAYS[range],
      (day) => day.inputTokens + day.outputTokens,
    );
    return sum > 0 ? sum : null;
  }, [chartData, range, stats]);

  /* ------------------------------- the cards ------------------------------- */

  const teams = org.teams.length;
  const runningTasks = tasks.countByStatus.running;
  const waiting = <Skeleton className="h-7 w-20" />;

  const cards: StatCardProps[] = [
    {
      label: 'Memories',
      value: totals ? formatNumber(totals.memories) : waiting,
      // "gelernt", not "dazugekommen": the day series counts every memory
      // the assistant wrote, the number above counts the ones still awake.
      // A night that compacts or puts to sleep what was learned this week
      // lowers the number without touching the badge, and the footnote below
      // says so rather than letting the two look like the same quantity.
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
    },
    {
      label: 'Agents',
      value: totals ? formatNumber(totals.agents) : waiting,
      ...(totals && totals.runningAssignments > 0
        ? { badge: <RunningBadge count={totals.runningAssignments} /> }
        : {}),
      headline: teams === 1 ? 'In a team' : 'In ' + formatNumber(teams) + ' teams',
      footnote: 'Excluding archived agents',
      to: '/org/agents',
    },
    {
      label: 'Open tasks',
      value: totals ? formatNumber(totals.openTasks) : waiting,
      ...(runningTasks > 0 ? { badge: <RunningBadge count={runningTasks} /> } : {}),
      headline: totals ? 'Of ' + formatNumber(totals.tasks) + ' tasks total' : ' ',
      footnote:
        'Open, planned, or running, including subtasks. The running badge counts top-level tasks only.',
      to: '/tasks',
    },
    {
      label: 'Conversations',
      value: totals ? formatNumber(totals.sessions) : waiting,
      ...(totals && totals.archivedSessions > 0
        ? {
            badge: (
              <Badge variant="outline">
                {formatNumber(totals.archivedSessions)} archived
              </Badge>
            ),
          }
        : {}),
      headline: totals ? formatNumber(totals.messages) + ' messages total' : ' ',
      footnote:
        'Conversations excluding archive. Messages including archive.',
      to: '/chats',
    },
  ];

  /* ------------------------------- the table ------------------------------- */

  const [selectedTab, setTab] = useState<RecentTab | null>(null);
  const tab: RecentTab = selectedTab ?? (
    totals && totals.tasks === 0
      ? (totals.assignments > 0 ? 'assignments' : 'sessions')
      : 'tasks'
  );

  const agentName = useCallback(
    (id: string | undefined) => org.agentById(id)?.name ?? 'Unknown',
    [org],
  );

  const recentTasks = useMemo(
    () => [...tasks.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_ROWS),
    [tasks.tasks],
  );

  // The same table `/tasks` draws, in its short form. The dashboard used to
  // define it a third time and lost the sortable heads, the rank-based
  // priority order and the link to the agent along the way.
  const taskColumns = useMemo<RookeryColumnDef<Task>[]>(
    () => buildTaskColumns({ agentById: org.agentById, showParentHint: true }),
    [org],
  );

  const assignmentColumns = useMemo<RookeryColumnDef<Assignment>[]>(
    () =>
      assignmentColumn.columns([
        assignmentColumn.accessor('task', {
          header: 'Assignment',
          cell: ({ row }) => (
            <div className="max-w-[42ch] truncate font-medium">
              {shorten(row.original.task, 90)}
            </div>
          ),
        }),
        assignmentColumn.accessor('agentId', {
          header: 'Agent',
          cell: ({ row }) => <span className="text-sm">{agentName(row.original.agentId)}</span>,
        }),
        assignmentColumn.accessor('status', {
          header: 'Status',
          cell: ({ row }) => <StatusBadge kind="assignment" status={row.original.status} />,
        }),
        assignmentColumn.accessor('provider', {
          header: 'Model',
          cell: ({ row }) => (
            <ProviderCell
              {...(row.original.provider ? { provider: row.original.provider } : {})}
              {...(row.original.model ? { model: row.original.model } : {})}
            />
          ),
        }),
        assignmentColumn.accessor('createdAt', {
          header: () => <div className="w-full text-right">Started</div>,
          cell: ({ row }) => relativeTimeCell(row.original.createdAt, { align: 'end' }),
        }),
      ]),
    [agentName],
  );

  // The same table `/chats` draws. Both used to write it out, and disagreed
  // about the words: „Gesprochen“/„Getippt“ here, „Voice“/„Chat“ there, and a
  // deleted agent was „Unknown“ on one page and „Unbekannter Agent“ on the
  // other.
  const sessionColumns = useMemo<RookeryColumnDef<Session>[]>(() => buildSessionColumns({}), []);

  // The counts on the tabs are the database's, not the preview's: the table
  // shows ten rows, but "Tasks 128" is the honest answer to how many there
  // are - and the reason "Show all" is worth clicking.
  const tabs: DataTableTab[] = [
    { value: 'tasks', label: 'Tasks', ...(totals ? { count: totals.tasks } : {}) },
    { value: 'assignments', label: 'Assignments', ...(totals ? { count: totals.assignments } : {}) },
    { value: 'sessions', label: 'Conversations', ...(totals ? { count: totals.sessions } : {}) },
  ];

  const shared = {
    tabs,
    tab,
    onTabChange: (value: string) => setTab(value as RecentTab),
    tabLabel: 'Section',
    paginate: false,
    showColumnMenu: false,
    idPrefix: 'zuletzt',
    skeletonRows: 5,
    actions: (
      <Button variant="outline" size="sm" asChild>
        <NavLink to={TAB_TARGET[tab]}>Show all</NavLink>
      </Button>
    ),
  };

  /* ------------------------------ the machine ------------------------------ */

  const [quotas, setQuotas] = useState<Partial<Record<ProviderId, ProviderQuota>>>({});

  // Only a provider that is actually signed in has a quota to report, and the
  // server caches each answer for a minute, so this runs once per status list.
  useEffect(() => {
    const ready = providers.filter((entry) => entry.available && entry.authenticated);
    if (ready.length === 0) return;
    let cancelled = false;
    for (const entry of ready) {
      void api
        .providerUsage(entry.id)
        .then((quota) => {
          if (!cancelled) setQuotas((current) => ({ ...current, [entry.id]: quota }));
        })
        // A provider without a usage endpoint simply gets no bars. It is not
        // an error worth putting on the page.
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [providers]);

  /* -------------------------------- render -------------------------------- */

  // "Nothing at all" is a different page from "nothing loaded yet": only a
  // snapshot that came back with zeroes everywhere means a fresh install.
  const untouched =
    totals !== null &&
    totals.sessions === 0 &&
    totals.messages === 0 &&
    totals.tasks === 0 &&
    totals.assignments === 0 &&
    totals.memories === 0;

  if (statsFailed && !stats) {
    return (
      <PageBody width="3xl">
        <ServerOffline onRetry={() => void Promise.all([reload(), load()])} />
      </PageBody>
    );
  }

  if (untouched) {
    return (
      <PageBody>
        <div className="px-4 lg:px-6">
          <EmptyState
            icon={ActivityIcon}
            title="Get started"
            description={
              assistantName +
              ' has nothing to show yet. One conversation, task, or agent is enough to bring this page to life.'
            }
            actionLabel="New conversation"
            onAction={newConversation}
            action={
              <>
                <Button variant="outline" asChild>
                  <NavLink to="/tasks/new">Create task</NavLink>
                </Button>
                <Button variant="outline" asChild>
                  <NavLink to="/org/agents/new">Hire agent</NavLink>
                </Button>
              </>
            }
          />
        </div>
        {/* The providers stay visible: on a fresh install the first question
            is usually whether the CLIs are signed in at all. */}
        <div className="px-4 lg:px-6">
          <ProviderPanel
            providers={providers}
            quotas={quotas}
            defaultProvider={config?.defaultProvider}
          />
        </div>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <StatCards items={cards} />

      <div className="px-4 lg:px-6">
        <TrendChartCard
          title="Activity"
          description="Per day: conversations and messages including archive; assignments from the active organization."
          descriptionShort="Created per day"
          data={chartData}
          series={ACTIVITY_SERIES}
          range={range}
          onRangeChange={setRange}
          {...(windowTokens !== null
            ? {
                badge: (
                  <Badge variant="outline" className="hidden @[540px]/card:inline-flex">
                    {formatNumber(windowTokens)} Tokens {TREND_RANGE_SUFFIX[range]}
                  </Badge>
                ),
              }
            : {})}
          empty={
            <EmptyState
              icon={ActivityIcon}
              title="Nothing happened during this period"
              description="A longer period may show more."
              variant="plain"
              size="sm"
            />
          }
        />
      </div>

      <SectionHeading
        title="Recent"
        hint={'The ' + RECENT_ROWS + ' most recent entries in each section.'}
      >

        {/*
          One table per facet instead of one table with three filters: the
          three rows are different records with different columns, so they
          cannot share a column set. Only the active one is mounted, which is
          also what keeps the tab switch instant.
        */}
        {tab === 'tasks' ? (
          <DataTable
            {...shared}
            data={recentTasks}
            columns={taskColumns}
            loading={tasks.loading && recentTasks.length === 0}
            onRowClick={(task) => void navigate('/tasks/' + task.id)}
            rowClickIgnoreColumns={['title', 'assignee']}
            {...(tasks.error ? { error: <ServerOffline onRetry={() => void tasks.refresh()} size="sm" /> } : {})}
            empty={
              <EmptyState
                icon={ListTodoIcon}
                title="No tasks yet"
                description="A task is planned, broken down, and assigned to agents."
                actionLabel="Create task"
                actionTo="/tasks/new"
                variant="plain"
                size="sm"
              />
            }
          />
        ) : null}

        {tab === 'assignments' ? (
          <DataTable
            {...shared}
            data={recentRuns ?? []}
            columns={assignmentColumns}
            loading={recentRuns === null && !runsFailed}
            onRowClick={(assignment) => void navigate('/assignments/' + assignment.id)}
            {...(runsFailed
              ? { error: <ServerOffline onRetry={() => void load()} size="sm" /> }
              : {})}
            empty={
              <EmptyState
                icon={SendIcon}
                title="No assignments yet"
                description="Assignments appear when work is delegated to an agent."
                actionLabel="View agents"
                actionTo="/org/agents"
                variant="plain"
                size="sm"
              />
            }
          />
        ) : null}

        {tab === 'sessions' ? (
          <DataTable
            {...shared}
            data={sessions.sessions}
            columns={sessionColumns}
            loading={sessions.loading}
            onRowClick={(session) => openConversation(session.id)}
            {...(sessions.error
              ? { error: <ServerOffline onRetry={() => void sessions.refresh()} size="sm" /> }
              : {})}
            empty={
              <EmptyState
                icon={MessagesSquareIcon}
                title="No conversations yet"
                description={'The first conversation with ' + assistantName + ' starts here.'}
                actionLabel="New conversation"
                onAction={newConversation}
                variant="plain"
                size="sm"
              />
            }
          />
        ) : null}
      </SectionHeading>

      <div className="px-4 lg:px-6">
        <ProviderPanel
          providers={providers}
          quotas={quotas}
          defaultProvider={config?.defaultProvider}
          offline={offline}
        />
      </div>
    </PageBody>
  );
}

/* ------------------------------- providers -------------------------------- */

function providerBadge(status: ProviderStatus) {
  if (!status.available) return <Badge variant="destructive">Not found</Badge>;
  if (!status.authenticated) return <Badge variant="secondary">Not signed in</Badge>;
  return <Badge>Ready</Badge>;
}

/**
 * The CLIs the whole app runs on, and how much of the subscription is left.
 *
 * The quota windows come from `GET /api/providers/:id/usage`, which is the
 * only place they exist - the socket has no quota event outside a running
 * turn. A provider that reports none simply shows its status and nothing
 * else, rather than an empty bar that would read as "zero used".
 *
 * Which of them a new turn takes unless the composer says otherwise is the
 * first thing anyone wants to know here, so the preset one is marked. The
 * setting itself stays where it is changed, under Settings.
 */
function ProviderPanel({
  providers,
  quotas,
  defaultProvider,
  offline = false,
}: {
  providers: ProviderStatus[];
  quotas: Partial<Record<ProviderId, ProviderQuota>>;
  defaultProvider?: ProviderId | undefined;
  offline?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider</CardTitle>
        <CardDescription>
          Rookery signs in through existing CLI sessions on this computer.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          offline ? (
            <ServerOffline size="sm" />
          ) : (
            <EmptyState
              icon={BotIcon}
              title="No status data yet"
              description="The server has not reported which CLIs it found yet."
              variant="plain"
              size="sm"
            />
          )
        ) : (
          <ItemGroup className="gap-2">
            {providers.map((status) => {
              const quota = quotas[status.id];
              const detail = [status.version, status.detail].filter(Boolean).join(' · ');
              return (
                <Item key={status.id} variant="outline" size="sm" className="flex-wrap">
                  <ItemMedia variant="icon">
                    <ProviderIcon provider={status.id} label={status.displayName} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{PROVIDER_LABEL[status.id] ?? status.displayName}</ItemTitle>
                    <ItemDescription>{detail || status.binary}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {status.id === defaultProvider ? (
                      <Badge variant="outline">Default</Badge>
                    ) : null}
                    {providerBadge(status)}
                  </ItemActions>
                  {quota && quota.windows.length > 0 ? (
                    <ItemFooter className="mt-1 flex-col items-stretch gap-2 border-t pt-3">
                      {quota.plan ? (
                        <div className="text-xs text-muted-foreground">{quota.plan}</div>
                      ) : null}
                      {quota.windows.map((window) => (
                        <div key={window.kind} className="flex flex-col gap-1">
                          <div className="flex items-baseline justify-between gap-2 text-xs">
                            <span className="text-muted-foreground">{window.label}</span>
                            <span className="tabular-nums">
                              {formatNumber(Math.round(window.percent))} % used
                            </span>
                          </div>
                          <Progress value={Math.min(100, Math.max(0, window.percent))} />
                          {window.resetsAt ? (
                            <div className="text-xs text-muted-foreground">
                              Reset on {formatDateTime(window.resetsAt)}
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </ItemFooter>
                  ) : null}
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  );
}
