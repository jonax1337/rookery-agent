import { useCallback, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  BanIcon,
  ClipboardListIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  WandSparklesIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import {
  relativeTime,
  isSettableTaskStatus,
  NO_PROJECT,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
} from '@/lib/format';
import { countSince, formatNumber } from '@/lib/stats';
import type { Task, TaskStatus } from '@/lib/types';
import { useConnection, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { useStatsTotals } from '@/hooks/useStatsTotals';
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

/** The sentinel for "nobody assigned yet" in the Zuständig filter. */
const UNASSIGNED = '__unassigned__';

/** Local midnight of this week's Monday - the base of "N diese Woche". */
function startOfWeek(now = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return date.getTime();
}

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
  /**
   * Status changes shown before the server has confirmed them. The row reads
   * through this map, and the entry is dropped again either when the refetch
   * lands or when the request came back 409 - which is the rollback.
   */
  const [pending, setPending] = useState<Record<string, TaskStatus>>({});

  usePageMeta({
    breadcrumb: [{ label: 'Aufgaben' }],
    actions: (
      <Button asChild size="sm">
        <NavLink to="/tasks/new">
          <PlusIcon data-icon="inline-start" />
          Aufgabe anlegen
        </NavLink>
      </Button>
    ),
  });

  /*
   * The only real total in this API. `countByStatus` rests on a capped list,
   * so without this the page could not tell "12 offen" from "12 offen of the
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
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of filtered) tally[task.status] += 1;
    return tally;
  }, [filtered]);

  const tabs = useMemo<DataTableTab[]>(
    () => [
      { value: 'alle', label: 'Alle', count: filtered.length },
      { value: 'open', label: 'Offen', count: counts.open },
      { value: 'planned', label: 'Geplant', count: counts.planned },
      { value: 'running', label: 'Läuft', count: counts.running },
      { value: 'done', label: 'Erledigt', count: counts.done },
      { value: 'undone', label: 'Nicht erledigt', count: counts.failed + counts.cancelled },
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
    async (task: Task, status: 'open' | 'done' | 'cancelled'): Promise<void> => {
      setPending((current) => ({ ...current, [task.id]: status }));
      try {
        await api.updateTask(task.id, { status });
        await tasks.refresh();
        toast(
          status === 'done'
            ? 'Aufgabe abgeschlossen'
            : status === 'cancelled'
              ? 'Aufgabe abgebrochen'
              : 'Aufgabe wieder geöffnet',
        );
      } catch (caught) {
        // 409 is the one failure with a real explanation: the runner has the
        // task and only "abbrechen" gets through while it does.
        if (caught instanceof ApiError && caught.status === 409) {
          toast.error('Die Aufgabe läuft gerade', {
            description: 'Während ein Lauf arbeitet, lässt sich nur noch abbrechen.',
          });
        } else {
          reportFailure('Status ändern', caught);
        }
      } finally {
        setPending((current) => {
          const next = { ...current };
          delete next[task.id];
          return next;
        });
      }
    },
    [tasks],
  );

  const cancelTask = useCallback(
    async (task: Task): Promise<void> => {
      const ok = await confirm({
        title: 'Aufgabe abbrechen?',
        description: 'Ein laufender Auftrag wird gestoppt. Das lässt sich nicht zurücknehmen.',
        confirmLabel: 'Abbrechen',
        cancelLabel: 'Weiterlaufen lassen',
        destructive: true,
        icon: BanIcon,
      });
      if (ok) await setStatus(task, 'cancelled');
    },
    [confirm, setStatus],
  );

  const planTask = useCallback(
    async (task: Task): Promise<void> => {
      toast('Wird geplant …', { description: task.title });
      try {
        await api.planTask(task.id);
        await tasks.refresh();
        toast('Plan steht', { description: task.title });
      } catch (caught) {
        reportFailure('Planen', caught);
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
            toast('Aufgabe ausgeführt', { description: task.title });
          },
          onError: (message) => toast.error('Ausführen fehlgeschlagen', { description: message }),
        },
      );
      toast('Aufgabe gestartet', { description: task.title });
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
              else if (next === 'open' || next === 'done') void setStatus(task, next);
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
    ? 'zählt nur Hauptaufgaben · ' +
      formatNumber(loaded) +
      ' von ' +
      formatNumber(totals?.tasks ?? loaded) +
      ' geladen'
    : 'zählt nur Hauptaufgaben';

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

      <StatCards
        items={[
          {
            label: 'Offen',
            value: formatNumber(board.open + board.planned),
            badge: <Badge variant="outline">{formatNumber(board.planned)} geplant</Badge>,
            headline: 'Wartet auf einen Lauf',
            footnote: base,
          },
          {
            label: 'Läuft',
            value: formatNumber(board.running),
            // `RunningBadge` gibt bei 0 nichts zurueck; die Kachel darf dann
            // aber auch keinen leeren Aktionsplatz aufmachen.
            badge: board.running > 0 ? <RunningBadge count={board.running} /> : undefined,
            headline: board.running > 0 ? 'Agenten arbeiten gerade' : 'Gerade niemand am Werk',
            footnote: base,
          },
          {
            label: 'Erledigt',
            value: formatNumber(board.done),
            headline: formatNumber(doneThisWeek) + ' diese Woche',
            footnote: base,
          },
          {
            label: 'Nicht erledigt',
            value: formatNumber(notDone),
            badge:
              board.failed > 0 ? (
                <Badge variant="destructive">{formatNumber(board.failed)} fehlgeschlagen</Badge>
              ) : undefined,
            headline: 'Fehlgeschlagen oder abgebrochen',
            footnote: base,
          },
        ]}
      />

      <div className="px-4 lg:px-6">
        <TrendChartCard
          title="Abgeschlossene Aufgaben pro Tag"
          description={
            'Nach dem Tag des Abschlusses; abgebrochene sind nicht dabei. Basis: die ' +
            formatNumber(loaded) +
            ' geladenen Aufgaben, Teilaufgaben eingeschlossen'
          }
          descriptionShort={formatNumber(loaded) + ' geladene Aufgaben'}
          data={trend}
          series={[
            { key: 'erledigt', label: 'Erledigt', color: 'var(--chart-2)' },
            { key: 'fehlgeschlagen', label: 'Fehlgeschlagen', color: 'var(--destructive)' },
          ]}
          {...cappedBadge(capped)}
          empty={
            <EmptyState
              icon={ClipboardListIcon}
              title="Noch nichts abgeschlossen"
              description="Sobald eine Aufgabe fertig wird oder scheitert, zeichnet diese Kurve sie."
              variant="plain"
              size="sm"
            />
          }
        />
      </div>

      <DataTable
        data={visible}
        columns={columns}
        getRowId={(task) => task.id}
        tabs={tabs}
        tab={tab}
        onTabChange={setTab}
        tabLabel="Status"
        searchable
        searchPlaceholder="Aufgaben durchsuchen"
        searchText={(task) => task.title + ' ' + task.description}
        columnLabels={TASK_COLUMN_LABELS}
        rowLabel={{ singular: 'Aufgabe', plural: 'Aufgaben' }}
        capped={capped}
        loading={tasks.loading && tasks.topLevel.length === 0}
        error={tasks.error ? <ServerOffline onRetry={() => void tasks.refresh()} /> : undefined}
        initialSorting={TASK_SORTING}
        onRowClick={(task) => setDrawerId(task.id)}
        rowClickIgnoreColumns={['select', 'title', 'actions']}
        filters={
          <>
            <FilterCombobox
              label="Zuständig"
              placeholder="Zuständig"
              value={assignee}
              onChange={setAssignee}
              options={[
                { value: UNASSIGNED, label: TASK_UNASSIGNED },
                ...org.agents.map((agent) => ({ value: agent.id, label: agent.name })),
              ]}
            />
            <FilterCombobox
              label="Projekt"
              placeholder="Projekt"
              value={project}
              onChange={setProject}
              options={[
                { value: NO_PROJECT, label: 'Kein Projekt' },
                ...org.projects.map((entry) => ({ value: entry.id, label: entry.name })),
              ]}
            />
          </>
        }
        /*
          Die Primaeraktion steht im Seitenkopf, nicht noch einmal hier - und
          die Auswahl-Spalten sind nicht mehr folgenlos: Abbrechen ist die
          einzige Sammelaktion, die dieses API kennt (es gibt kein DELETE fuer
          Aufgaben), und es ist dieselbe Tat wie unten im Zeilenmenue.
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
                  noun: { singular: 'Aufgabe', plural: 'Aufgaben' },
                  nameOf: (task) => task.title,
                  verb: 'abbrechen',
                  done: 'abgebrochen',
                  confirmLabel: 'Abbrechen',
                  cancelLabel: 'Weiterlaufen lassen',
                  icon: BanIcon,
                  description:
                    'Laufende Aufträge dazu werden gestoppt. Das lässt sich nicht zurücknehmen.',
                  run: (task) => api.updateTask(task.id, { status: 'cancelled' }),
                  after: tasks.refresh,
                  clear,
                })
              }
            >
              <BanIcon data-icon="inline-start" />
              {formatNumber(open.length)} abbrechen
            </Button>
          );
        }}
        empty={
          <EmptyState
            icon={ClipboardListIcon}
            title="Noch keine Aufgaben"
            description="Größere Vorhaben stehen hier, bevor sie geplant und als Aufträge ausgeführt werden. Der Assistent trägt selbst ein."
            actionLabel="Aufgabe anlegen"
            actionTo="/tasks/new"
            variant="plain"
          />
        }
      />

      <DetailDrawer
        open={drawerTask !== null}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
        title={drawerTask?.title ?? 'Aufgabe'}
        description={drawerTask ? TASK_STATUS_LABEL[drawerTask.status] : undefined}
        footer={
          drawerTask ? (
            <Button asChild>
              <NavLink to={'/tasks/' + drawerTask.id}>Aufgabe öffnen</NavLink>
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

/** Öffnen → Bearbeiten → Seiteneigenes → Separator → Abbrechen. */
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
        <RowMenuButton label={'Aktionen für ' + task.title} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onOpen}>
          <SquareArrowOutUpRightIcon />
          Öffnen
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <PencilIcon />
          Bearbeiten
        </DropdownMenuItem>
        <DropdownMenuItem disabled={settled || task.status === 'running'} onSelect={onPlan}>
          <WandSparklesIcon />
          Planen
        </DropdownMenuItem>
        <DropdownMenuItem disabled={settled || task.status === 'running'} onSelect={onRun}>
          <PlayIcon />
          Ausführen
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Status ändern</DropdownMenuSubTrigger>
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
          Abbrechen
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
          { label: 'Priorität', value: <StatusBadge kind="priority" status={task.priority} /> },
          {
            label: 'Zuständig',
            value: assignee?.name ?? TASK_UNASSIGNED,
            ...(assignee ? { to: '/org/agents/' + assignee.id } : {}),
          },
          { label: 'Projekt', value: project?.name },
          {
            label: 'Teilaufgaben',
            value: children.length
              ? children.filter((child) => child.status === 'done').length + '/' + children.length
              : undefined,
          },
          { label: 'Angelegt', value: relativeTime(task.createdAt) },
          { label: 'Zuletzt geändert', value: relativeTime(task.updatedAt) },
        ]}
      />

      {task.description ? <ResultMarkdown text={task.description} /> : null}

      {task.error ? (
        <Alert variant="destructive">
          <BanIcon />
          <AlertTitle>Die Aufgabe ist gescheitert</AlertTitle>
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
  erledigt: number;
  fehlgeschlagen: number;
}

/**
 * Finished tasks per local calendar day, split into the two outcomes.
 *
 * `bucketByDay` would do this, but its `seriesOf` narrows to a literal union
 * and the two keys here have to survive as the chart's `dataKey`s; spelling
 * the walk out keeps the row type exact and the window explicit.
 */
function bucketFinished(tasks: readonly Task[], since: number, until: number): FinishedDay[] {
  const tally = new Map<string, { erledigt: number; fehlgeschlagen: number }>();

  for (const task of tasks) {
    const at = task.finishedAt;
    if (typeof at !== 'number' || at < since || at > until) continue;
    // Only the two outcomes the chart claims: a cancelled task was stopped,
    // not attempted and failed, and folding it in would overstate failures.
    const series =
      task.status === 'done'
        ? 'erledigt'
        : task.status === 'failed'
          ? 'fehlgeschlagen'
          : null;
    if (!series) continue;
    const key = dayKeyOf(at);
    const row = tally.get(key) ?? { erledigt: 0, fehlgeschlagen: 0 };
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
    const row = tally.get(key) ?? { erledigt: 0, fehlgeschlagen: 0 };
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
