import { forwardRef, useCallback, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  BanIcon,
  ClipboardCheckIcon as ClipboardListIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  LayoutGridIcon,
  MenuIcon as ListIcon,
  PenToolIcon as PencilIcon,
  PlayIcon,
  PlusIcon,
  SparklesIcon as WandSparklesIcon,
} from "@/components/icons";
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import {
  relativeTime,
  isSettableTaskStatus,
  type SettableTaskStatus,
  NO_PROJECT,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
} from '@/lib/format';
import { countSince, formatNumber } from '@/lib/stats';
import type { Task, TaskStatus } from '@/lib/types';
import { useConnection, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { useStatsTotals } from '@/hooks/useStatsTotals';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { cappedBadge, StatCards } from '@/components/blocks/stat-cards';
import { TrendChartCard } from '@/components/blocks/trend-chart-card';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { DataTable, type DataTableTab } from '@/components/blocks/data-table/data-table';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { FilterCombobox } from '@/components/common/filter-combobox';
import { MetaList } from '@/components/common/meta-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { RunningBadge, StatusBadge } from '@/components/common/status-badge';
import {
  buildTaskColumns,
  TASK_COLUMN_LABELS,
  TASK_SORTING,
  TASK_UNASSIGNED,
} from '@/components/common/task-columns';
import { TaskBoard } from '@/components/common/task-board';
import { ResultMarkdown } from '@/components/result-markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { IconComponent } from "@/components/icons";

/**
 * Everything the company has been asked to get done.
 *
 * The Kanban board this replaces looked like it could be reordered and could
 * not: there is no `sort_order` anywhere in the API (see serverGaps), so a
 * drag handle would only ever have reshuffled the current render. What the
 * board was actually good at - seeing the states side by side - is now the
 * facet tabs with their counts, and the state change it never really offered
 * lives in the row menu.
 *
 * Nothing polls: `useTasks` merges the `task` broadcast, so a task the
 * assistant files during a turn, or a subtask the runner moves, appears here
 * while it happens.
 *
 * The columns come from `buildTaskColumns`, shared with the subtask table on a
 * task's detail page and with the dashboard.
 */

/** The sentinel for "nobody assigned yet" in the Assignee filter. */
const UNASSIGNED = '__unassigned__';

/** Local midnight of this week's Monday - the base of "N this week". */
function startOfWeek(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

/**
 * The empty states swap their lucide clipboard for the animate-ui one: same
 * silhouette and stroke, the list lines draw themselves once when the state
 * enters the viewport. `EmptyState` types its `icon` as a `IconComponent` and
 * renders it without props, so the `animateOnView` trigger rides along in
 * this shell (same pattern as the plug in `empty-state.tsx`).
 */
const AnimatedClipboardListIcon = forwardRef<SVGSVGElement>(function AnimatedClipboardListIcon() {
  return <ClipboardListIcon size={24} />;
});

export function TasksPage() {
  const tasks = useTasksState();
  const org = useOrgState();
  const { socket } = useConnection();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  const [tab, setTab] = useState('alle');
  const [assignee, setAssignee] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  /** Table keeps the status tabs and bulk actions; board owns status via columns instead. */
  const [view, setView] = useState<'table' | 'board'>('table');
  /**
   * Status changes shown before the server has confirmed them. The row reads
   * through this map, and the entry is dropped again either when the refetch
   * lands or when the request came back 409 - which is the rollback.
   */
  const [pending, setPending] = useState<Record<string, TaskStatus>>({});

  // `view` has to be in the deps: without it the header keeps the action row
  // it was published with, the toggle stays stuck on `table`, and clicking
  // "Table" while the board is up only deselects an already-selected item -
  // Radix reports `''`, the guard drops it, and the board never gives way.
  usePageMeta({
    breadcrumb: [{ label: 'Tasks' }],
    actions: (
      <>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={view}
          onValueChange={(value) => {
            if (value === 'table' || value === 'board') setView(value);
          }}
        >
          <ToggleGroupItem value="table" aria-label="Table view">
            <ListIcon />
          </ToggleGroupItem>
          <ToggleGroupItem value="board" aria-label="Board view">
            <LayoutGridIcon />
          </ToggleGroupItem>
        </ToggleGroup>
        <Button asChild size="sm">
          <NavLink to="/tasks/new">
            <PlusIcon data-icon="inline-start" />
            Create task
          </NavLink>
        </Button>
      </>
    ),
  }, [view]);

  /*
   * The only real total in this API. `countByStatus` rests on a capped list,
   * so without this the page could not tell "12 open" from "12 open of the
   * 300 we happen to have loaded"; `totals.tasks` is a `COUNT(*)` and settles
   * it. The shared hook keeps the number in step with every other list.
   */
  const totals = useStatsTotals(socket);

  const loaded = tasks.tasks.length;
  const capped = totals !== null && totals.tasks > loaded;

  /* ------------------------------ the rows ------------------------------ */

  const rows = useMemo(
    () =>
      tasks.topLevel.map((task) => {
        const optimistic = pending[task.id];
        return optimistic ? { ...task, status: optimistic } : task;
      }),
    [tasks.topLevel, pending],
  );

  const filtered = useMemo(
    () =>
      rows.filter((task) => {
        if (assignee === UNASSIGNED && task.assigneeId) return false;
        if (assignee !== null && assignee !== UNASSIGNED && task.assigneeId !== assignee) {
          return false;
        }
        if (project === NO_PROJECT && task.projectId) return false;
        if (project !== null && project !== NO_PROJECT && task.projectId !== project) return false;
        return true;
      }),
    [rows, assignee, project],
  );

  // The counts belong to what the filters left standing, not to the whole
  // board: a tab reading "7" that shows three rows is worse than no count.
  const counts = useMemo(() => {
    const tally: Record<TaskStatus, number> = {
      open: 0,
      planned: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of filtered) tally[task.status] += 1;
    return tally;
  }, [filtered]);

  const tabs = useMemo<DataTableTab[]>(
    () => [
      { value: 'alle', label: 'All', count: filtered.length },
      { value: 'open', label: 'Open', count: counts.open },
      { value: 'planned', label: 'Planned', count: counts.planned },
      { value: 'running', label: 'Running', count: counts.running },
      { value: 'blocked', label: 'Blocked', count: counts.blocked },
      { value: 'done', label: 'Done', count: counts.done },
      { value: 'undone', label: 'Not done', count: counts.failed + counts.cancelled },
    ],
    [counts, filtered.length],
  );

  const visible = useMemo(() => {
    if (tab === 'alle') return filtered;
    if (tab === 'undone') {
      return filtered.filter((task) => task.status === 'failed' || task.status === 'cancelled');
    }
    return filtered.filter((task) => task.status === tab);
  }, [filtered, tab]);

  /* ------------------------------- actions ------------------------------ */

  const setStatus = useCallback(
    async (task: Task, status: SettableTaskStatus, force = false): Promise<void> => {
      setPending((current) => ({ ...current, [task.id]: status }));
      try {
        await api.updateTask(task.id, { status, ...(force ? { force: true } : {}) });
        await tasks.refresh();
        toast(
          status === 'done'
            ? 'Task completed'
            : status === 'cancelled'
              ? 'Task cancelled'
              : 'Task reopened',
        );
      } catch (caught) {
        // 409 comes in two shapes: the runner has the task (only "abbrechen"
        // gets through), or a manual "done" disagrees with a failed
        // assignment - the latter is a confirm-and-retry, not a hard stop.
        if (caught instanceof ApiError && caught.status === 409) {
          if (!force && status === 'done' && caught.message.toLowerCase().includes('assignment failed')) {
            const ok = await confirm({
              title: 'Assignment failed',
              description: 'The linked assignment failed. Mark the task done anyway?',
              confirmLabel: 'Mark done',
              cancelLabel: 'Keep open',
            });
            if (ok) await setStatus(task, status, true);
          } else {
            toast.error('The task is currently running', {
              description: 'While a run is active, the task can only be cancelled.',
            });
          }
        } else {
          reportFailure('Change status', caught);
        }
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      }
    },
    [confirm, tasks],
  );

  const reorderTask = useCallback(
    async (task: Task, sortOrder: number): Promise<void> => {
      try {
        await api.updateTask(task.id, { sortOrder });
      } catch (caught) {
        reportFailure('Reorder task', caught);
        await tasks.refresh();
      }
    },
    [tasks],
  );

  const cancelTask = useCallback(
    async (task: Task): Promise<void> => {
      const ok = await confirm({
        title: 'Cancel task?',
        description: 'Any running assignment will be stopped. This cannot be undone.',
        confirmLabel: 'Cancel',
        cancelLabel: 'Keep running',
        destructive: true,
        icon: BanIcon,
      });
      if (ok) await setStatus(task, 'cancelled');
    },
    [confirm, setStatus],
  );

  const planTask = useCallback(
    async (task: Task): Promise<void> => {
      toast('Planning…', { description: task.title });
      try {
        await api.planTask(task.id);
        await tasks.refresh();
        toast('Plan ready', { description: task.title });
      } catch (caught) {
        reportFailure('Plan', caught);
      }
    },
    [tasks],
  );

  const runTask = useCallback(
    (task: Task): void => {
      // The row does not follow the stream: the task broadcast moves the row
      // through planned → running → done on its own. The detail page is where
      // the text is worth watching.
      socket.sendRunTask(
        { taskId: task.id },
        {
          onEvent: () => {},
          onDone: () => {
            void tasks.refresh();
            void org.refresh();
            toast('Task completed', { description: task.title });
          },
          onError: (message) => toast.error('Run failed', { description: message }),
        },
      );
      toast('Task started', { description: task.title });
    },
    [org, socket, tasks],
  );

  /* ------------------------------- columns ------------------------------ */

  const columns = useMemo(
    () =>
      buildTaskColumns({
        agentById: org.agentById,
        selectable: true,
        onOpenDetail: (task) => setDrawerId(task.id),
        projectName: (task) =>
          org.projects.find((entry) => entry.id === task.projectId)?.name ?? '',
        childrenOf: tasks.childrenOf,
        showCreatedAt: true,
        rowActions: (task) => (
          <TaskRowMenu
            task={task}
            onOpen={() => void navigate('/tasks/' + task.id)}
            onEdit={() => void navigate('/tasks/' + task.id + '/edit')}
            onPlan={() => void planTask(task)}
            onRun={() => runTask(task)}
            onStatus={(next) => {
              if (next === task.status) return;
              if (next === 'cancelled') void cancelTask(task);
              else if (next === 'open' || next === 'done' || next === 'blocked') void setStatus(task, next);
            }}
            onCancel={() => void cancelTask(task)}
          />
        ),
      }),
    [cancelTask, navigate, org, planTask, runTask, setStatus, tasks],
  );

  /* ------------------------------- numbers ------------------------------ */

  const board = tasks.countByStatus;
  const doneThisWeek = countSince(tasks.topLevel, (task) => task.finishedAt, startOfWeek());
  const notDone = board.failed + board.cancelled;
  const base = capped
    ? 'counts top-level tasks only · ' +
      formatNumber(loaded) +
      ' of ' +
      formatNumber(totals?.tasks ?? loaded) +
      ' loaded'
    : 'counts top-level tasks only';

  /* -------------------------------- chart ------------------------------- */

  const finished = useMemo(
    () => tasks.tasks.filter((task) => typeof task.finishedAt === 'number' && task.finishedAt > 0),
    [tasks.tasks],
  );

  const trend = useMemo(() => {
    if (finished.length === 0) return [];
    const until = Date.now();
    const since = until - 89 * 86_400_000;
    return bucketFinished(finished, since, until);
  }, [finished]);

  /* -------------------------------- drawer ------------------------------ */

  const drawerTask = drawerId ? (rows.find((task) => task.id === drawerId) ?? null) : null;

  return (
    <PageBody>
      {dialog}
      {bulk.dialog}

      <Fade>
        <StatCards
          items={[
            {
              label: 'Open',
              value: <CountingNumber number={board.open + board.planned} />,
              badge: <Badge variant="outline">{formatNumber(board.planned)} planned</Badge>,
              headline: 'Waiting to run',
              footnote: base,
            },
            {
              label: 'Running',
              value: <CountingNumber number={board.running} />,
              // `RunningBadge` gibt bei 0 nichts zurueck; die Kachel darf dann
              // aber auch keinen leeren Aktionsplatz aufmachen.
              badge: board.running > 0 ? <RunningBadge count={board.running} /> : undefined,
              headline: board.running > 0 ? 'Agents are working' : 'No one is working right now',
              footnote: base,
            },
            {
              label: 'Done',
              value: <CountingNumber number={board.done} />,
              headline: formatNumber(doneThisWeek) + ' this week',
              footnote: base,
            },
            {
              label: 'Not done',
              value: <CountingNumber number={notDone} />,
              badge:
                board.failed > 0 ? (
                  <Badge variant="destructive">{formatNumber(board.failed)} failed</Badge>
                ) : undefined,
              headline: 'Failed or cancelled',
              footnote: base,
            },
          ]}
        />
      </Fade>

      <Fade delay={50}>
        <div className="px-4 lg:px-6">
          <TrendChartCard
            title="Completed tasks per day"
            description={
              'By completion date; cancelled tasks are excluded. Based on the ' +
              formatNumber(loaded) +
              ' loaded tasks, including subtasks'
            }
            descriptionShort={formatNumber(loaded) + ' loaded tasks'}
            data={trend}
            series={[
              { key: 'done', label: 'Done', color: 'var(--chart-2)' },
              { key: 'failed', label: 'Failed', color: 'var(--destructive)' },
            ]}
            {...cappedBadge(capped)}
            empty={
              <Fade>
                <EmptyState
                  icon={AnimatedClipboardListIcon}
                  title="Nothing completed yet"
                  description="This chart records each task when it completes or fails."
                  variant="plain"
                  size="sm"
                />
              </Fade>
            }
          />
        </div>
      </Fade>

      <Fade delay={100} key={view}>
        {view === 'board' ? (
          <div className="px-4 lg:px-6">
            <TaskBoard
              tasks={filtered}
              agentById={org.agentById}
              onOpenDetail={(task) => setDrawerId(task.id)}
              onStatusChange={(task, status) => {
                if (isSettableTaskStatus(status)) void setStatus(task, status);
              }}
              onReorder={reorderTask}
            />
          </div>
        ) : (
          <DataTable
            data={visible}
            columns={columns}
            getRowId={(task) => task.id}
            tabs={tabs}
            tab={tab}
            onTabChange={setTab}
            tabLabel="Status"
            searchable
            searchPlaceholder="Search tasks"
            searchText={(task) => task.title + ' ' + task.description}
            columnLabels={TASK_COLUMN_LABELS}
            rowLabel={{ singular: 'task', plural: 'tasks' }}
            capped={capped}
            loading={tasks.loading && tasks.topLevel.length === 0}
            error={tasks.error ? <ServerOffline onRetry={() => void tasks.refresh()} /> : undefined}
            initialSorting={TASK_SORTING}
            onRowClick={(task) => setDrawerId(task.id)}
            rowClickIgnoreColumns={['select', 'title', 'actions']}
            filters={
              <>
                <FilterCombobox
                  label="Assignee"
                  placeholder="Assignee"
                  value={assignee}
                  onChange={setAssignee}
                  options={[
                    { value: UNASSIGNED, label: TASK_UNASSIGNED },
                    ...org.agents.map((agent) => ({ value: agent.id, label: agent.name })),
                  ]}
                />
                <FilterCombobox
                  label="Project"
                  placeholder="Project"
                  value={project}
                  onChange={setProject}
                  options={[
                    { value: NO_PROJECT, label: 'No project' },
                    ...org.projects.map((entry) => ({ value: entry.id, label: entry.name })),
                  ]}
                />
              </>
            }
            /*
              Die Primaeraktion steht im Seitenkopf, nicht noch einmal hier - und
              die Auswahl-Spalten sind nicht mehr folgenlos: Cancel ist die
              einzige Sammelaktion, die dieses API kennt (es gibt kein DELETE fuer
              Tasks), und es ist dieselbe Tat wie unten im Zeilenmenue.
            */
            bulkActions={(selected, clear) => {
              const open = selected.filter(
                (task) => task.status !== 'done' && task.status !== 'cancelled',
              );
              return (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={open.length === 0}
                  onClick={() =>
                    void bulk.run({
                      rows: open,
                      noun: { singular: 'task', plural: 'tasks' },
                      nameOf: (task) => task.title,
                      verb: 'cancel',
                      done: 'cancelled',
                      confirmLabel: 'Cancel',
                      cancelLabel: 'Keep running',
                      icon: BanIcon,
                      description:
                        'Their running assignments will be stopped. This cannot be undone.',
                      run: (task) => api.updateTask(task.id, { status: 'cancelled' }),
                      after: tasks.refresh,
                      clear,
                    })
                  }
                >
                  <BanIcon data-icon="inline-start" />
                  Cancel {formatNumber(open.length)}
                </Button>
              );
            }}
            empty={
              <Fade>
                <EmptyState
                  icon={AnimatedClipboardListIcon}
                  title="No tasks yet"
                  description="Larger goals start here before they are planned and run as assignments. The assistant can add tasks too."
                  actionLabel="Create task"
                  actionTo="/tasks/new"
                  variant="plain"
                />
              </Fade>
            }
          />
        )}
      </Fade>

      <DetailDrawer
        open={drawerTask !== null}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
        title={drawerTask?.title ?? 'Task'}
        description={drawerTask ? TASK_STATUS_LABEL[drawerTask.status] : undefined}
        footer={
          drawerTask ? (
            <Button asChild>
              <NavLink to={'/tasks/' + drawerTask.id}>Open task</NavLink>
            </Button>
          ) : undefined
        }
      >
        {drawerTask ? <TaskDrawerBody task={drawerTask} /> : null}
      </DetailDrawer>
    </PageBody>
  );
}

/* ---------------------------------- parts --------------------------------- */

interface TaskRowMenuProps {
  task: Task;
  onOpen(): void;
  onEdit(): void;
  onPlan(): void;
  onRun(): void;
  onStatus(status: TaskStatus): void;
  onCancel(): void;
}

/** Open → Edit → Seiteneigenes → Separator → Cancel. */
function TaskRowMenu({
  task,
  onOpen,
  onEdit,
  onPlan,
  onRun,
  onStatus,
  onCancel,
}: TaskRowMenuProps) {
  const settled = task.status === 'done' || task.status === 'cancelled';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Actions for ' + task.title} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onOpen}>
          <SquareArrowOutUpRightIcon />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <PencilIcon />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem disabled={settled || task.status === 'running'} onSelect={onPlan}>
          <WandSparklesIcon />
          Plan
        </DropdownMenuItem>
        <DropdownMenuItem disabled={settled || task.status === 'running'} onSelect={onRun}>
          <PlayIcon />
          Run
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Change status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={task.status}
              onValueChange={(value) => onStatus(value as TaskStatus)}
            >
              {TASK_STATUS_ORDER.map((status) => (
                <DropdownMenuRadioItem
                  key={status}
                  value={status}
                  // `planned`, `running` and `failed` belong to the runner -
                  // PATCH rejects them - so they are shown to place the
                  // current state, not to be picked.
                  disabled={!isSettableTaskStatus(status)}
                >
                  {TASK_STATUS_LABEL[status]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={settled} onSelect={onCancel}>
          <BanIcon />
          Cancel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the row drawer shows: the facts, then the text the task was given. */
function TaskDrawerBody({ task }: { task: Task }) {
  const org = useOrgState();
  const tasks = useTasksState();
  const children = tasks.childrenOf(task.id);
  const assignee = org.agentById(task.assigneeId);
  const project = org.projects.find((entry) => entry.id === task.projectId);

  return (
    <>
      <MetaList
        columns={1}
        items={[
          { label: 'Status', value: <StatusBadge kind="task" status={task.status} /> },
          { label: 'Priority', value: <StatusBadge kind="priority" status={task.priority} /> },
          {
            label: 'Assignee',
            value: assignee?.name ?? TASK_UNASSIGNED,
            ...(assignee ? { to: '/org/agents/' + assignee.id } : {}),
          },
          { label: 'Project', value: project?.name },
          {
            label: 'Subtasks',
            value: children.length
              ? children.filter((child) => child.status === 'done').length + '/' + children.length
              : undefined,
          },
          { label: 'Created', value: relativeTime(task.createdAt) },
          { label: 'Last updated', value: relativeTime(task.updatedAt) },
        ]}
      />

      {task.description ? <ResultMarkdown text={task.description} /> : null}

      {task.error ? (
        <Alert variant="destructive">
          <BanIcon />
          <AlertTitle>The task failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{task.error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/* ---------------------------------- chart --------------------------------- */

interface FinishedDay {
  day: string;
  at: number;
  done: number;
  failed: number;
}

/**
 * Finished tasks per local calendar day, split into the two outcomes.
 *
 * `bucketByDay` would do this, but its `seriesOf` narrows to a literal union
 * and the two keys here have to survive as the chart's `dataKey`s; spelling
 * the walk out keeps the row type exact and the window explicit.
 */
function bucketFinished(tasks: readonly Task[], since: number, until: number): FinishedDay[] {
  const tally = new Map<string, { done: number; failed: number }>();

  for (const task of tasks) {
    const at = task.finishedAt;
    if (typeof at !== 'number' || at < since || at > until) continue;
    // Only the two outcomes the chart claims: a cancelled task was stopped,
    // not attempted and failed, and folding it in would overstate failures.
    const series =
      task.status === 'done'
        ? 'done'
        : task.status === 'failed'
          ? 'failed'
          : null;
    if (!series) continue;
    const key = dayKeyOf(at);
    const row = tally.get(key) ?? { done: 0, failed: 0 };
    row[series] += 1;
    tally.set(key, row);
  }

  const out: FinishedDay[] = [];
  const cursor = new Date(since);
  cursor.setHours(0, 0, 0, 0);
  const last = new Date(until);
  last.setHours(0, 0, 0, 0);
  // Stepping by calendar days, not by 86 400 000 ms: across a DST change one
  // day is 23 or 25 hours and a fixed offset misfiles an hour of rows.
  while (cursor.getTime() <= last.getTime()) {
    const key = dayKeyOf(cursor.getTime());
    const row = tally.get(key) ?? { done: 0, failed: 0 };
    out.push({ day: key, at: cursor.getTime(), ...row });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function dayKeyOf(value: number): string {
  const date = new Date(value);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return date.getFullYear() + '-' + month + '-' + day;
}
