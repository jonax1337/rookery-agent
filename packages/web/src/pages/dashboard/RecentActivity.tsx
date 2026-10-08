import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  DataTable,
  type DataTableProps,
  type DataTableTab,
} from '@/components/blocks/data-table/data-table';
import { SectionHeading } from '@/components/blocks/section-heading';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { buildSessionColumns } from '@/components/common/session-columns';
import { buildTaskColumns } from '@/components/common/task-columns';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { Button } from '@/components/ui/button';
import { ClipboardCheckIcon, MessageSquareIcon } from '@/components/icons';
import { useAllSessions, type AllSessionsState } from '@/hooks/useAllSessions';
import type { Assignment, StatsTotals } from '@/lib/types';
import {
  useChatSession,
  useConfig,
  useConnection,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
import { AnimatedSendIcon } from './animated-icons';
import { buildRecentRunColumns } from './recent-run-columns';
import { defaultRecentTab, RECENT_ROWS, TAB_TARGET, type RecentTab } from './recent-tabs';

const SKELETON_ROWS = 5;

/** What the three tables share: the facet tabs, "Show all", and the preview look. */
type TableChrome = Pick<
  DataTableProps<object>,
  | 'tabs'
  | 'tab'
  | 'onTabChange'
  | 'tabLabel'
  | 'paginate'
  | 'showColumnMenu'
  | 'idPrefix'
  | 'skeletonRows'
  | 'actions'
>;

interface RecentActivityProps {
  totals: StatsTotals | null;
  recentRuns: Assignment[] | null;
  runsFailed: boolean;
  onRetryRuns(): void;
}

/**
 * The newest rows of tasks, runs and conversations behind one set of tabs.
 *
 * One table per facet instead of one table with three filters: the three rows
 * are different records with different columns, so they cannot share a column
 * set. Only the active one is mounted, which is also what keeps the tab
 * switch instant.
 */
export function RecentActivity({ totals, recentRuns, runsFailed, onRetryRuns }: RecentActivityProps) {
  const { socket } = useConnection();
  const sessions = useAllSessions(socket, { limit: RECENT_ROWS });
  const [selectedTab, setTab] = useState<RecentTab | null>(null);
  const tab = selectedTab ?? defaultRecentTab(totals);

  const chrome: TableChrome = {
    tabs: recentTabs(totals),
    tab,
    onTabChange: (value) => setTab(value as RecentTab),
    tabLabel: 'Section',
    paginate: false,
    showColumnMenu: false,
    idPrefix: 'zuletzt',
    skeletonRows: SKELETON_ROWS,
    actions: (
      <Button variant="outline" size="sm" asChild>
        <NavLink to={TAB_TARGET[tab]}>Show all</NavLink>
      </Button>
    ),
  };

  return (
    <SectionHeading
      title="Recent"
      hint={'The ' + RECENT_ROWS + ' most recent entries in each section.'}
    >
      {tab === 'tasks' ? <RecentTasksTable chrome={chrome} /> : null}
      {tab === 'assignments' ? (
        <RecentRunsTable
          chrome={chrome}
          runs={recentRuns}
          failed={runsFailed}
          onRetry={onRetryRuns}
        />
      ) : null}
      {tab === 'sessions' ? <RecentSessionsTable chrome={chrome} sessions={sessions} /> : null}
    </SectionHeading>
  );
}

/**
 * The counts on the tabs are the database's, not the preview's: the table
 * shows ten rows, but "Tasks 128" is the honest answer to how many there
 * are - and the reason "Show all" is worth clicking.
 */
function recentTabs(totals: StatsTotals | null): DataTableTab[] {
  return [
    { value: 'tasks', label: 'Tasks', ...(totals ? { count: totals.tasks } : {}) },
    { value: 'assignments', label: 'Runs', ...(totals ? { count: totals.assignments } : {}) },
    { value: 'sessions', label: 'Conversations', ...(totals ? { count: totals.sessions } : {}) },
  ];
}

function RecentTasksTable({ chrome }: { chrome: TableChrome }) {
  const navigate = useNavigate();
  const org = useOrgState();
  const tasks = useTasksState();

  const recentTasks = useMemo(
    () => [...tasks.tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_ROWS),
    [tasks.tasks],
  );

  // The same table `/tasks` draws, in its short form.
  const columns = useMemo(
    () => buildTaskColumns({ agentById: org.agentById, showParentHint: true }),
    [org],
  );

  return (
    <Fade delay={100}>
      <DataTable
        {...chrome}
        data={recentTasks}
        columns={columns}
        loading={tasks.loading && recentTasks.length === 0}
        onRowClick={(task) => void navigate('/tasks/' + task.id)}
        rowClickIgnoreColumns={['title', 'assignee']}
        {...(tasks.error ? { error: <ServerOffline onRetry={() => void tasks.refresh()} size="sm" /> } : {})}
        empty={
          <EmptyState
            icon={ClipboardCheckIcon}
            title="No tasks yet"
            description="A task is planned, broken down, and assigned to agents."
            actionLabel="Create task"
            actionTo="/tasks/new"
            variant="plain"
            size="sm"
          />
        }
      />
    </Fade>
  );
}

interface RecentRunsTableProps {
  chrome: TableChrome;
  /** `null` until the first answer arrives. */
  runs: Assignment[] | null;
  failed: boolean;
  onRetry(): void;
}

function RecentRunsTable({ chrome, runs, failed, onRetry }: RecentRunsTableProps) {
  const navigate = useNavigate();
  const org = useOrgState();

  const columns = useMemo(
    () => buildRecentRunColumns((id) => org.agentById(id)?.name ?? 'Unknown'),
    [org],
  );

  return (
    <Fade delay={100}>
      <DataTable
        {...chrome}
        data={runs ?? []}
        columns={columns}
        loading={runs === null && !failed}
        onRowClick={(assignment) => void navigate('/assignments/' + assignment.id)}
        {...(failed ? { error: <ServerOffline onRetry={onRetry} size="sm" /> } : {})}
        empty={
          <EmptyState
            icon={AnimatedSendIcon}
            title="Nothing has run yet"
            description="Runs appear when work is handed to an agent."
            actionLabel="View agents"
            actionTo="/org/agents"
            variant="plain"
            size="sm"
          />
        }
      />
    </Fade>
  );
}

function RecentSessionsTable({ chrome, sessions }: { chrome: TableChrome; sessions: AllSessionsState }) {
  const { assistantName } = useConfig();
  const { newConversation, openConversation } = useChatSession();

  // The same table `/chats` draws.
  const columns = useMemo(() => buildSessionColumns({}), []);

  return (
    <Fade delay={100}>
      <DataTable
        {...chrome}
        data={sessions.sessions}
        columns={columns}
        loading={sessions.loading}
        onRowClick={(session) => openConversation(session.id)}
        {...(sessions.error
          ? { error: <ServerOffline onRetry={() => void sessions.refresh()} size="sm" /> }
          : {})}
        empty={
          <EmptyState
            icon={MessageSquareIcon}
            title="No conversations yet"
            description={'The first conversation with ' + assistantName + ' starts here.'}
            actionLabel="New conversation"
            onAction={newConversation}
            variant="plain"
            size="sm"
          />
        }
      />
    </Fade>
  );
}
