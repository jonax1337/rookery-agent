import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router';

import {
  BanIcon,
  CheckIcon,
  ClipboardCheckIcon as ClipboardListAnimatedIcon,
  ClipboardCheckIcon as ListTodoIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  FolderOpenIcon as FolderIcon,
  LinkIcon,
  PenToolIcon as PencilIcon,
  PenToolIcon as PencilLineIcon,
  PlayIcon as PlayAnimatedIcon,
  SendIcon,
  SendIcon as SendAnimatedIcon,
  SparklesIcon as WandSparklesIcon,
  UserIcon as UserRoundIcon,
} from "@/components/icons";
import { toast } from 'sonner';

import { ApiError, api } from '@/lib/api';
import { failureMessage, reportFailure } from '@/lib/errors';
import {
  formatDuration,
  REQUESTER_LABEL,
  TASK_STATUS_LABEL,
  timeAgo,
} from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type {
  Agent,
  Assignment,
  AssignmentView,
  Task,
  TaskDetail,
} from '@/lib/types';
import { useConnection, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import {
  RotatingText,
  RotatingTextContainer,
} from '@/components/animate-ui/primitives/texts/rotating';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards, StatCardsSkeleton, type StatCardProps } from '@/components/blocks/stat-cards';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { LiveRunList } from '@/components/common/live-run-list';
import { MetaList, MetaListSkeleton } from '@/components/common/meta-list';
import { ResultCard } from '@/components/common/result-card';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { TASK_COLUMN_LABELS, buildTaskColumns } from '@/components/common/task-columns';
import { useRecord } from '@/hooks/useRecord';
import { ResultMarkdown } from '@/components/result-markdown';
import {
  ASSIGNMENT_COLUMN_LABELS,
  ASSIGNMENT_ROW_LABEL,
  ASSIGNMENT_SORTING,
  buildAssignmentColumns,
  toAssignmentRow,
} from '@/pages/AssignmentsPage';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { IconComponent } from "@/components/icons";

/**
 * One task: what it is, who does it, and the two things you can do to it -
 * plan it and run it.
 *
 * The page used to be one column of five cards with the planning form wedged
 * between description and subtasks, so every run scrolled the reader's place
 * away while it streamed. Now the facts sit in a `MetaList`, the four numbers
 * in `StatCards`, and the four things worth reading - the text, the subtasks,
 * the runs, the result - live behind tabs that do not move each other.
 *
 * Two sources feed it. `useTasks` is the live copy: it merges the `task`
 * broadcast, so a subtask moving from planned to running updates here without
 * this page tracking it. The fetched `TaskDetail` fills in what the broadcast
 * does not carry - the assignee record and the assignment the task ran as.
 *
 * What a reload cannot bring back is the streamed text of a run in flight:
 * nothing persists it (see serverGaps). So the "Runs" tab rehydrates the
 * *status* of every open run from `TaskDetail.assignment` and `org.live` and
 * says plainly that the text is gone, rather than showing an empty box that
 * looks like a run producing nothing.
 */

type TabValue = 'ueberblick' | 'teilaufgaben' | 'laeufe' | 'ergebnis';

/** Statuses in which a run is still open, for the live list and the tab badge. */
const OPEN = new Set(['pending', 'running']);

export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrgState();
  const tasks = useTasksState();
  const { socket } = useConnection();
  const { confirm, dialog } = useConfirm();
  // The stop button of `LiveRunList` asks the same question on every page that
  // renders it; this page used to be the one that cancelled without a word.
  const { dialog: cancelDialog, cancelAssignment } = useCancelAssignment();

  const [tab, setTab] = useState<TabValue>('ueberblick');
  const [planning, setPlanning] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  // The hint is read once, on submit: a controlled value would have to be a
  // dependency of `usePageMeta`, which republishes the whole header - one
  // rebuild of the action row per keystroke.
  const hintRef = useRef<HTMLInputElement>(null);

  /** True only while *this page* holds a run's socket stream. */
  const [starting, setStarting] = useState(false);
  const [streamed, setStreamed] = useState<AssignmentView[]>([]);
  const [streamResult, setStreamResult] = useState('');
  const [streamError, setStreamError] = useState<string | null>(null);

  /* ------------------------------ the record ----------------------------- */

  const {
    record: detail,
    loading,
    missing,
    error: loadError,
    reload,
  } = useRecord<TaskDetail>(id, api.task);

  // The board's copy is the one the socket keeps current.
  const boardTask = id ? tasks.tasks.find((entry) => entry.id === id) : undefined;
  const task: Task | null = boardTask ?? detail?.task ?? null;

  const children = useMemo<Task[]>(() => {
    if (!id) return [];
    const fromBoard = tasks.childrenOf(id);
    return fromBoard.length > 0 ? fromBoard : (detail?.children ?? []);
  }, [detail?.children, id, tasks]);

  /* -------------------------------- the runs ----------------------------- */

  /**
   * The assignments this task and its subtasks ran as.
   *
   * `GET /api/org/tasks/:id` names only the task's own run, a subtask carries
   * nothing but its `assignmentId`, and no endpoint lists assignments by task.
   * So the ids are fetched one by one - there are as many of them as there are
   * subtasks, never a list that would need paging.
   */
  const runIds = useMemo(() => {
    const ids: string[] = [];
    const own = task?.assignmentId ?? detail?.assignment?.id;
    if (own) ids.push(own);
    for (const child of children) if (child.assignmentId) ids.push(child.assignmentId);
    return [...new Set(ids)];
  }, [children, detail?.assignment?.id, task?.assignmentId]);

  const [runs, setRuns] = useState<Record<string, Assignment>>({});

  // The ids plus their live status: a run that just finished has to be read
  // again, because the record carries the result and the duration the socket
  // view does not.
  const runKey = runIds.map((runId) => runId + ':' + (org.live[runId]?.status ?? '')).join(',');

  useEffect(() => {
    if (runIds.length === 0) {
      setRuns({});
      return;
    }
    let alive = true;
    void Promise.all(
      runIds.map((runId) =>
        api
          .assignment(runId)
          .then((answer) => answer.assignment)
          .catch(() => null),
      ),
    ).then((list) => {
      if (!alive) return;
      const next: Record<string, Assignment> = {};
      for (const entry of list) if (entry) next[entry.id] = entry;
      setRuns(next);
    });
    return () => {
      alive = false;
    };
    // `runKey` carries both the ids and their live states; `runIds` itself is
    // a fresh array on every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  /** Which subtask a run belongs to, for the row menu's way back. */
  const taskOfRun = useMemo(() => {
    const map = new Map<string, string>();
    for (const child of children) if (child.assignmentId) map.set(child.assignmentId, child.id);
    return map;
  }, [children]);

  const runRows = useMemo(
    () =>
      runIds.flatMap((runId) => {
        const record = runs[runId];
        if (!record) return [];
        return [
          toAssignmentRow(
            record,
            org.agentById(record.agentId),
            org.live[runId],
            taskOfRun.get(runId),
          ),
        ];
      }),
    [org, runIds, runs, taskOfRun],
  );

  /**
   * What is in flight right now.
   *
   * A run this page started wins outright - that is the real stream. Without
   * one, the open runs are rebuilt from the socket's newest word and, failing
   * that, from the fetched record, so a reload still shows that something is
   * working even though its text is gone.
   */
  const liveViews = useMemo<AssignmentView[]>(() => {
    if (streamed.length > 0) return streamed;
    const open: AssignmentView[] = [];
    for (const runId of runIds) {
      const view = org.live[runId];
      if (view) {
        if (OPEN.has(view.status)) open.push(view);
        continue;
      }
      const record = runs[runId];
      if (record && OPEN.has(record.status)) open.push(viewOf(record, org.agentById(record.agentId)));
    }
    return open;
  }, [org, runIds, runs, streamed]);

  /** The live rows were rebuilt, not streamed - so their text is missing. */
  const rehydrated = streamed.length === 0 && liveViews.length > 0;
  const openRuns = liveViews.filter((view) => OPEN.has(view.status)).length;

  /* ------------------------------- actions ------------------------------- */

  const isRunning = task?.status === 'running' || starting;
  const settled = task?.status === 'done' || task?.status === 'cancelled';

  const run = useCallback((): void => {
    if (!id) return;
    setStarting(true);
    setStreamed([]);
    setStreamResult('');
    setStreamError(null);
    setTab('laeufe');

    socket.sendRunTask(
      { taskId: id },
      {
        onEvent: (event) => {
          if (event.type === 'assignment') {
            const view = event.assignment;
            setStreamed((current) => {
              const index = current.findIndex((entry) => entry.id === view.id);
              if (index === -1) return [...current, view];
              const next = [...current];
              next[index] = { ...(next[index] as AssignmentView), ...view };
              return next;
            });
          } else if (event.type === 'text') {
            setStreamResult((current) => current + event.delta);
          } else if (event.type === 'error') {
            setStreamError(event.message);
          }
        },
        onDone: (text) => {
          if (text) setStreamResult(text);
          setStarting(false);
          // The finished run belongs in the table below; leaving it in the
          // live list as well would read as two runs having happened.
          setStreamed([]);
          void reload();
          void tasks.refresh();
          void org.refresh();
          toast('Task completed');
        },
        onError: (message) => {
          setStreamError(message);
          setStarting(false);
          toast.error('Run failed', { description: message });
        },
      },
    );
    toast('Task started');
  }, [id, reload, org, socket, tasks]);

  const plan = useCallback(async (): Promise<void> => {
    if (!id || planning) return;
    setPlanning(true);
    const hint = hintRef.current?.value.trim() ?? '';
    try {
      const answer = await api.planTask(id, hint || undefined);
      await tasks.refresh();
      await reload();
      setPlanOpen(false);
      if (hintRef.current) hintRef.current.value = '';
      // The planner's reasoning is persisted as `planNote` and shown under
      // "Why this plan"; the toast only says where to look.
      if (answer.children.length > 0) setTab('teilaufgaben');
      toast('Plan ready', { description: answer.plan.reason });
    } catch (caught) {
      reportFailure('Plan', caught);
    } finally {
      setPlanning(false);
    }
  }, [id, planning, reload, tasks]);

  const setStatus = useCallback(
    async (status: 'done' | 'cancelled'): Promise<void> => {
      if (!id) return;
      try {
        await api.updateTask(id, { status });
        await tasks.refresh();
        await reload();
        toast(status === 'done' ? 'Task completed' : 'Task cancelled');
      } catch (caught) {
        // 409 is the one failure with a real explanation: the runner holds the
        // task and only "abbrechen" gets through while it does.
        const conflict = caught instanceof ApiError && caught.status === 409;
        toast.error(conflict ? 'The task is currently running' : 'Status unchanged', {
          description: conflict
            ? 'While a run is active, the task can only be cancelled.'
            : failureMessage(caught),
        });
      }
    },
    [id, reload, tasks],
  );

  const cancelTask = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: 'Cancel task?',
      description: 'Any running assignment will be stopped. This cannot be undone.',
      confirmLabel: 'Cancel',
      cancelLabel: 'Keep running',
      destructive: true,
      icon: BanIcon,
    });
    if (ok) await setStatus('cancelled');
  }, [confirm, setStatus]);

  const cancelRun = useCallback(
    (assignmentId: string): void => {
      void cancelAssignment(assignmentId);
    },
    [cancelAssignment],
  );

  /* -------------------------------- header ------------------------------- */

  usePageMeta(
    {
      ...(task ? { title: task.title } : {}),
      breadcrumb: [{ label: 'Tasks', to: '/tasks' }, { label: task?.title ?? 'Task' }],
      actions: task ? (
        <>
          <Button size="sm" disabled={isRunning || settled} onClick={run}>
            {isRunning ? (
              <Spinner aria-label="Running" data-icon="inline-start" />
            ) : (
              <PlayAnimatedIcon
                size={16}
                data-icon="inline-start"
              />
            )}
            <RotatingTextContainer text={isRunning ? 'Running…' : 'Run'}>
              <RotatingText />
            </RotatingTextContainer>
          </Button>

          <Popover open={planOpen} onOpenChange={setPlanOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" disabled={isRunning || settled}>
                {planning ? (
                  <Spinner aria-label="Planning" data-icon="inline-start" />
                ) : (
                  <WandSparklesIcon data-icon="inline-start" />
                )}
                <RotatingTextContainer text={planning ? 'Planning…' : 'Plan'}>
                  <RotatingText />
                </RotatingTextContainer>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <PopoverHeader>
                <PopoverTitle>Plan</PopoverTitle>
                <PopoverDescription>
                  A model reviews the available agents and decides whether to assign one person
                  or split the work into subtasks. This takes a few seconds.
                </PopoverDescription>
              </PopoverHeader>
              <FieldGroup className="pt-3">
                <Field>
                  <FieldLabel htmlFor="aufgabe-hinweis">Guidance for the planner</FieldLabel>
                  <Input
                    id="aufgabe-hinweis"
                    ref={hintRef}
                    placeholder="e.g. “please assign this to Mara”"
                    disabled={planning}
                  />
                  <FieldDescription>
                    Leave this blank to let the model decide.
                  </FieldDescription>
                </Field>
                <Button onClick={() => void plan()} disabled={planning}>
                  {planning ? (
                    <Spinner aria-label="Planning" data-icon="inline-start" />
                  ) : (
                    <WandSparklesIcon data-icon="inline-start" />
                  )}
                  <RotatingTextContainer text={planning ? 'Planning…' : 'Plan'}>
                    <RotatingText />
                  </RotatingTextContainer>
                </Button>
              </FieldGroup>
            </PopoverContent>
          </Popover>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="More actions" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <NavLink to={'/tasks/' + task.id + '/edit'}>
                  <PencilIcon data-icon="inline-start" />
                  Edit
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isRunning || settled}
                onSelect={() => void setStatus('done')}
              >
                <CheckIcon data-icon="inline-start" />
                Complete
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={settled}
                onSelect={() => void cancelTask()}
              >
                <BanIcon data-icon="inline-start" />
                Cancel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null,
    },
    [task?.id, isRunning, settled, planning, planOpen, cancelTask, plan, run, setStatus],
  );

  /* ------------------------------- columns ------------------------------- */

  /** Every task by id, so a `dependsOn` entry can be shown by its title. */
  const titleOf = useCallback(
    (taskId: string): string | undefined =>
      tasks.tasks.find((entry) => entry.id === taskId)?.title ??
      children.find((entry) => entry.id === taskId)?.title,
    [children, tasks.tasks],
  );

  const subtaskColumns = useMemo(
    () =>
      buildTaskColumns({
        agentById: org.agentById,
        titleOf,
        showUpdatedAt: false,
        rowActions: (child) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + child.title} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <NavLink to={'/tasks/' + child.id}>
                  <SquareArrowOutUpRightIcon data-icon="inline-start" />
                  Open
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to={'/tasks/' + child.id + '/edit'}>
                  <PencilIcon data-icon="inline-start" />
                  Edit
                </NavLink>
              </DropdownMenuItem>
              {child.assignmentId ? (
                <DropdownMenuItem asChild>
                  <NavLink to={'/assignments/' + child.assignmentId}>
                    <SendIcon data-icon="inline-start" />
                    Open assignment
                  </NavLink>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      }),
    [org, titleOf],
  );

  const runColumns = useMemo(
    () => buildAssignmentColumns({ selectable: false, onCancel: (row) => cancelRun(row.id) }),
    [cancelRun],
  );

  /* -------------------------------- states ------------------------------- */

  if (missing) {
    return (
      <PageBody width="3xl">
        <Fade className="flex min-w-0 flex-1 flex-col">
          <EmptyState
            icon={ClipboardListEmptyIcon as unknown as IconComponent}
            title="This task does not exist"
            description="The entry was deleted, or the address is incorrect."
            actionLabel="View tasks"
            actionTo="/tasks"
          />
        </Fade>
      </PageBody>
    );
  }

  if (!task) {
    if (loading) return <TaskDetailSkeleton />;
    return (
      <PageBody width="3xl">
        {loadError ? (
          <Fade className="flex min-w-0 flex-1 flex-col">
            <ServerOffline onRetry={() => void reload()} />
          </Fade>
        ) : (
          <Fade className="flex min-w-0 flex-1 flex-col">
            <EmptyState
              icon={ClipboardListEmptyIcon as unknown as IconComponent}
              title="This task does not exist"
              description="The entry was deleted, or the address is incorrect."
              actionLabel="View tasks"
              actionTo="/tasks"
            />
          </Fade>
        )}
      </PageBody>
    );
  }

  /* -------------------------------- numbers ------------------------------ */

  const assignee = org.agentById(task.assigneeId) ?? detail?.assignee ?? null;
  const project = org.projects.find((entry) => entry.id === task.projectId);
  const doneChildren = children.filter((child) => child.status === 'done').length;
  const result = streamResult || task.result || '';

  const cards: StatCardProps[] = [
    {
      label: 'Status',
      value: TASK_STATUS_LABEL[task.status],
      badge: <StatusBadge kind="priority" status={task.priority} />,
      headline: assignee ? assignee.name + ' is assigned' : 'No assignee yet',
      footnote: 'Last updated ' + timeAgo(task.updatedAt),
    },
    {
      label: 'Subtasks',
      value:
        children.length > 0 ? (
          <>
            <CountingNumber number={doneChildren} />
            {'/'}
            {children.length}
          </>
        ) : (
          '–'
        ),
      headline:
        children.length === 0
          ? 'Not split into subtasks'
          : doneChildren === children.length
            ? 'All done'
            : formatNumber(children.length - doneChildren) + ' still open',
      footnote: children.length === 0 ? 'Planning defines the subtasks' : 'From the loaded task list',
    },
    {
      label: 'Runs',
      value: <CountingNumber number={runIds.length} />,
      // Not `RunningBadge`: this counts pending *and* running, which is a
      // different state than "running". It borrows the look, not the word.
      ...(openRuns > 0
        ? {
            badge: (
              <Badge variant="secondary" className="animate-pulse tabular-nums">
                {openRuns} open
              </Badge>
            ),
          }
        : {}),
      headline: runIds.length === 0 ? 'No runs yet' : 'Assignments for this task',
      footnote: 'This task and its subtasks',
    },
    {
      label: 'Duration',
      value: runtimeOf(task),
      headline:
        task.finishedAt && task.startedAt
          ? 'From start to finish'
          : task.startedAt
            ? 'Since the start'
            : 'Not started yet',
      footnote: task.startedAt ? 'Started ' + formatDateTime(task.startedAt) : 'No start time',
    },
  ];

  return (
    <PageBody>
      {dialog}
      {cancelDialog}

      <Fade>
        <div className="px-4 lg:px-6">
          <MetaList
            columns={2}
            items={[
              {
                label: 'Project',
                value: project?.name ?? 'No project',
                icon: FolderIcon,
              },
              {
                label: 'Assignee',
                value: assignee?.name ?? 'Unassigned',
                icon: UserRoundIcon,
                ...(assignee ? { to: '/org/agents/' + assignee.id } : {}),
              },
              {
                label: 'Created by',
                value:
                  REQUESTER_LABEL[task.createdBy] +
                  (task.createdByAgentId
                    ? ' · ' + (org.agentById(task.createdByAgentId)?.name ?? 'Unknown')
                    : ''),
                icon: PencilLineIcon,
              },
              {
                label: 'Dependencies',
                icon: LinkIcon,
                value:
                  task.dependsOn.length === 0 ? null : (
                    <span className="flex flex-wrap gap-1">
                      {task.dependsOn.map((dependency) => {
                        const label = titleOf(dependency);
                        return (
                          <Badge
                            key={dependency}
                            variant="outline"
                            className={label ? 'font-normal' : 'font-mono text-2xs font-normal'}
                          >
                            {label ?? dependency}
                          </Badge>
                        );
                      })}
                    </span>
                  ),
              },
            ]}
          />
        </div>
      </Fade>

      {task.error || streamError ? (
        <Fade delay={50}>
          <div className="px-4 lg:px-6">
            <Alert variant="destructive">
              <BanIcon />
              <AlertTitle>The task failed</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">
                {streamError ?? task.error}
              </AlertDescription>
            </Alert>
          </div>
        </Fade>
      ) : null}

      <Fade delay={100}>
        <StatCards items={cards} />
      </Fade>

      <Fade delay={150}>
        <div className="px-4 lg:px-6">
          <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
            <TabsList>
              <TabsTrigger value="ueberblick">Overview</TabsTrigger>
              <TabsTrigger value="teilaufgaben">
                Subtasks
                {children.length > 0 ? (
                  <Badge variant="secondary" className="tabular-nums">
                    {children.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="laeufe">
                Runs
                {openRuns > 0 ? (
                  <Badge variant="secondary" className="animate-pulse tabular-nums">
                    {openRuns}
                  </Badge>
                ) : runIds.length > 0 ? (
                  <Badge variant="secondary" className="tabular-nums">
                    {runIds.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="ergebnis">Result</TabsTrigger>
            </TabsList>

          {/* ----------------------------- overview ---------------------------- */}
          <TabsContent value="ueberblick" className="mt-4 flex flex-col gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Description</CardTitle>
                <CardDescription>The original task description, as entered.</CardDescription>
              </CardHeader>
              <CardContent>
                {task.description.trim() ? (
                  <ResultMarkdown text={task.description} />
                ) : (
                  <EmptyState
                    icon={PencilIcon}
                    title="No description"
                    description="Without a description, the planner only has the title."
                    actionLabel="Edit"
                    actionTo={'/tasks/' + task.id + '/edit'}
                    variant="plain"
                    size="sm"
                  />
                )}
              </CardContent>
            </Card>

            {task.planNote ? (
              <Card>
                <CardHeader>
                  <CardTitle>Why this plan</CardTitle>
                  <CardDescription>
                    The planner’s reasoning for the breakdown and assignee.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ResultMarkdown text={task.planNote} />
                </CardContent>
              </Card>
            ) : null}
          </TabsContent>

          {/* ----------------------------- subtasks ---------------------------- */}
          <TabsContent value="teilaufgaben" className="mt-4">
            <DataTable
              flush
              idPrefix="teilaufgaben"
              data={children}
              columns={subtaskColumns}
              getRowId={(child) => child.id}
              searchable
              searchPlaceholder="Search subtasks"
              searchText={(child) => child.title + ' ' + child.description}
              initialSorting={[{ id: 'priority', desc: false }]}
              paginate={false}
              columnLabels={TASK_COLUMN_LABELS}
              rowLabel={{ singular: 'subtask', plural: 'subtasks' }}
              empty={
                <EmptyState
                  icon={ListTodoIcon}
                  title="No subtasks yet"
                  description="The planner reviews the available agents and breaks the task down, or assigns it to one person."
                  actionLabel="Plan"
                  onAction={() => void plan()}
                  variant="plain"
                  size="sm"
                />
              }
            />
          </TabsContent>

          {/* ------------------------------- runs ------------------------------ */}
          <TabsContent value="laeufe" className="mt-4 flex flex-col gap-4">
            {liveViews.length > 0 ? (
              <div className="flex flex-col gap-2">
                <LiveRunList
                  assignments={liveViews}
                  onCancel={cancelRun}
                  title={rehydrated ? 'Currently running' : 'This run'}
                />
                {rehydrated ? (
                  // Honest about the gap instead of showing an empty box: the
                  // text deltas of a stream are not persisted anywhere, so
                  // after a reload only the status of the run survives.
                  <p className="text-xs text-muted-foreground">
                    After a reload, only the running assignment’s status is available;
                    previously streamed text is not stored.
                  </p>
                ) : null}
              </div>
            ) : null}

            {streamed.length > 0 && streamResult ? (
              <Card>
                <CardHeader>
                  <CardTitle>During the run</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResultMarkdown text={streamResult} />
                </CardContent>
              </Card>
            ) : null}

            <DataTable
              flush
              idPrefix="aufgabe-laeufe"
              data={runRows}
              columns={runColumns}
              getRowId={(row) => row.id}
              searchable
              searchPlaceholder="Search assignments"
              searchText={(row) => row.task}
              initialSorting={ASSIGNMENT_SORTING}
              paginate={false}
              columnLabels={ASSIGNMENT_COLUMN_LABELS}
              rowLabel={ASSIGNMENT_ROW_LABEL}
              empty={
                <EmptyState
                  icon={SendEmptyIcon as unknown as IconComponent}
                  title="No runs yet"
                  description="Run sends the task to its assigned agents. Each run is then listed here."
                  actionLabel="Run"
                  onAction={run}
                  variant="plain"
                  size="sm"
                />
              }
            />
          </TabsContent>

          {/* ------------------------------ result ----------------------------- */}
          <TabsContent value="ergebnis" className="mt-4">
            {result ? (
              <ResultCard text={result} description="What the run produced." />
            ) : (
              <EmptyState
                icon={ClipboardListEmptyIcon as unknown as IconComponent}
                title="No result yet"
                description="The response will appear here once the task has run."
                actionLabel="Run"
                onAction={run}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
      </Fade>
    </PageBody>
  );
}

/* ---------------------------------- parts --------------------------------- */

/**
 * `EmptyState` types its `icon` as a `IconComponent` and renders it without
 * props, so the animate-ui icons ride along in these shells: same silhouette
 * and stroke as their lucide counterparts, drawing themselves once when the
 * state enters the viewport (the pattern of `AnimatedPlugZapIcon` in
 * `empty-state.tsx`).
 */
function ClipboardListEmptyIcon() {
  return <ClipboardListAnimatedIcon size={24} />;
}

function SendEmptyIcon() {
  return <SendAnimatedIcon size={24} />;
}

/**
 * The loading state in the geometry the loaded page will have - facts, four
 * numbers, a tab bar, a panel - so nothing jumps when the request lands.
 */
function TaskDetailSkeleton() {
  return (
    <PageBody>
      <MetaListSkeleton className="px-4 lg:px-6" />
      <StatCardsSkeleton />

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <Skeleton className="h-9 w-96 max-w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </PageBody>
  );
}

/* ---------------------------------- helpers -------------------------------- */

/**
 * How long the task took, or how long it has been going.
 *
 * `finishedAt - startedAt` is the only duration a task carries; while it runs
 * there is no end yet, so the card says when it started and uses the same
 * coarse buckets the rest of the app uses for elapsed time.
 */
function runtimeOf(task: Task): string {
  if (task.startedAt && task.finishedAt && task.finishedAt >= task.startedAt) {
    return formatDuration(task.finishedAt - task.startedAt) || '–';
  }
  if (task.startedAt && task.status === 'running') {
    return 'Started ' + timeAgo(task.startedAt);
  }
  return '–';
}

/** An `Assignment` record as the live list wants it, for rehydrating a run. */
function viewOf(assignment: Assignment, agent?: Agent): AssignmentView {
  return {
    id: assignment.id,
    agentId: assignment.agentId,
    agentSlug: agent?.slug ?? assignment.agentId,
    agentName: agent?.name ?? 'Agent',
    task: assignment.task,
    status: assignment.status,
    depth: assignment.depth,
    chars: assignment.chars,
    ...(assignment.projectId ? { projectId: assignment.projectId } : {}),
    ...(assignment.parentId ? { parentId: assignment.parentId } : {}),
    ...(assignment.provider ? { provider: assignment.provider } : {}),
    ...(assignment.durationMs !== undefined ? { durationMs: assignment.durationMs } : {}),
    ...(assignment.error ? { error: assignment.error } : {}),
  };
}
