import { useCallback, useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import {
  ArchiveIcon,
  BrainIcon,
  Building2Icon,
  CpuIcon,
  InboxIcon,
  MessagesSquareIcon,
  PencilIcon,
  SendIcon,
  ShieldIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { PageBody } from '@/components/blocks/page-body';
import { StatCards, StatCardsSkeleton, cappedBadge } from '@/components/blocks/stat-cards';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { EMPTY_CELL, relativeTimeCell } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { ActivityTimeline, useAssignmentActivityHistory } from '@/components/common/activity-timeline';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { LiveRunList } from '@/components/common/live-run-list';
import { MEMORY_COLUMN_LABELS, buildMemoryColumns } from '@/components/common/memory-columns';
import { MetaList, MetaListSkeleton } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { useConfirm } from '@/components/common/confirm-dialog';
import { useRecord } from '@/hooks/useRecord';
import { ResultMarkdown } from '@/components/result-markdown';
import { usePageMeta } from '@/components/shell/page-meta';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import {
  formatDuration,
  NO_PROJECT,
  PERMISSION_HINT,
  PERMISSION_LABEL,
  shorten,
} from '@/lib/format';
import { average, formatNumber } from '@/lib/stats';
import type { AgentDetail, Agent, Assignment, AssignmentView } from '@/lib/types';
import { useChatSession, useConfig, useConnection, useOrgState } from '@/providers/rookery-provider';

/**
 * One member of staff: who they are, what they are working on, what they know.
 *
 * The page used to stack six cards and put the assignment form in the middle
 * of them, which meant every handed-out task scrolled the page under the
 * reader while it streamed. Now the facts sit in a `MetaList`, the four
 * numbers in `StatCards`, the four lists behind tabs over one `DataTable`,
 * and the assignment lives in a drawer - the stream stays inside it and the
 * page underneath does not move.
 *
 * The assignment talks to the socket directly rather than through the chat
 * hook: handing an agent a task from their own page is not a turn in the
 * conversation and must not land in the transcript.
 */

/** The server's own ceilings on `GET /api/org/agents/:id` - see routes/org.ts. */
const ASSIGNMENT_LIMIT = 30;
const MEMORY_LIMIT = 100;

/** Past this many characters the instructions get a fold instead of a wall. */
const INSTRUCTIONS_FOLD = 1200;

type TabValue = 'assignments' | 'reports' | 'memories' | 'instructions';

export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrgState();
  const { socket } = useConnection();
  const { config } = useConfig();
  const { chooseCounterpart } = useChatSession();
  const { confirm, dialog } = useConfirm();
  // The stop button of `LiveRunList` asks the same question on every page that
  // renders it; this page used to be one of the two that cancelled silently.
  const { dialog: cancelDialog, cancelAssignment } = useCancelAssignment();

  const [tab, setTab] = useState<TabValue>('assignments');

  /* ------------------------------ the record ----------------------------- */

  // `missing` is what tells a deleted agent from a stopped server - the page
  // used to answer both with "Erneut versuchen".
  const {
    record: detail,
    loading,
    missing,
    error: loadError,
    reload,
  } = useRecord<AgentDetail>(id, api.agent);

  const agent = detail?.agent ?? null;
  const assignments = useMemo(() => detail?.assignments ?? [], [detail]);
  const memories = useMemo(() => detail?.memories ?? [], [detail]);
  const reports = useMemo(() => detail?.reports ?? [], [detail]);

  /* -------------------------------- live now ------------------------------ */

  // What this agent is doing *right now*, wherever the run was started from -
  // the board, a direct assignment from another page, a delegation. Separate
  // from the drawer's own `live` state below, which only ever shows a run
  // this page itself just kicked off.
  const runningAssignment = useMemo(
    () => org.running.find((entry) => entry.agentId === agent?.id),
    [org.running, agent?.id],
  );
  const liveActivity = useAssignmentActivityHistory(runningAssignment?.id, org.live);

  /* ------------------------------ the drawer ----------------------------- */

  const [assignOpen, setAssignOpen] = useState(false);
  const [task, setTask] = useState('');
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<AssignmentView[]>([]);
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);

  const assign = (): void => {
    if (!agent || busy) return;
    const trimmed = task.trim();
    if (!trimmed) return;

    setBusy(true);
    setLive([]);
    setResult('');
    setError(null);

    socket.sendAssign(
      {
        agent: agent.slug,
        task: trimmed,
        ...(projectId !== NO_PROJECT ? { projectId } : {}),
      },
      {
        onEvent: (event) => {
          if (event.type === 'assignment') {
            const view = event.assignment;
            setLive((current) => {
              const index = current.findIndex((entry) => entry.id === view.id);
              if (index === -1) return [...current, view];
              const next = [...current];
              next[index] = { ...(next[index] as AssignmentView), ...view };
              return next;
            });
          } else if (event.type === 'text') {
            setResult((current) => current + event.delta);
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        onDone: (text) => {
          if (text) setResult(text);
          setBusy(false);
          setTask('');
          // The run is over, so the live list has nothing left to say - the
          // finished assignment belongs in the table, and showing it twice is
          // what made the old page read as if two runs had happened.
          setLive([]);
          void reload();
          void org.refresh();
          toast('Assignment completed');
        },
        onError: (message) => {
          setError(message);
          setBusy(false);
        },
      },
    );
  };

  const cancelRun = useCallback(
    (assignmentId: string) => {
      void cancelAssignment(assignmentId);
    },
    [cancelAssignment],
  );

  /* ------------------------------- archive ------------------------------- */

  const archive = useCallback(async (): Promise<void> => {
    if (!agent) return;
    const ok = await confirm({
      title: agent.name + ' archive?',
      description:
        'Archived agents no longer accept assignments. Their previous assignments and ' +
        'memories will remain.',
      confirmLabel: 'Archive',
      destructive: true,
      icon: ArchiveIcon,
    });
    if (!ok) return;
    try {
      await api.updateAgent(agent.id, { archived: true });
      await org.refresh();
      await reload();
      toast(agent.name + ' archived');
    } catch (caught) {
      reportFailure('Archive', caught);
    }
  }, [agent, confirm, org, reload]);

  /* -------------------------------- header ------------------------------- */

  usePageMeta(
    {
      ...(agent ? { title: agent.name } : {}),
      breadcrumb: [
        { label: 'Organization', to: '/org/agents' },
        { label: 'Agents', to: '/org/agents' },
        { label: agent?.name ?? 'Agent' },
      ],
      actions: agent ? (
        <>
          <Button size="sm" onClick={() => setAssignOpen(true)} disabled={agent.archived}>
            <SendIcon data-icon="inline-start" />
            Create assignment
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => chooseCounterpart(agent.id)}
          >
            <MessagesSquareIcon data-icon="inline-start" />
            Chat
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="More actions" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <NavLink to={'/org/agents/' + agent.id + '/edit'}>
                  <PencilIcon data-icon="inline-start" />
                  Edit
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={agent.archived}
                onSelect={() => void archive()}
              >
                <ArchiveIcon data-icon="inline-start" />
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : null,
    },
    [agent?.id, agent?.archived, archive, chooseCounterpart],
  );

  /* -------------------------------- columns ------------------------------ */

  const assignmentColumns = useMemo(() => {
    const column = createRookeryColumnHelper<Assignment>();
    return column.columns([
      column.accessor('task', {
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Assignment" />,
        cell: ({ row }) => (
          <NavLink
            to={'/assignments/' + row.original.id}
            className="font-medium hover:underline"
          >
            {shorten(row.original.task, 90)}
          </NavLink>
        ),
        enableHiding: false,
      }),
      column.accessor('status', {
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Status" />,
        cell: ({ row }) => <StatusBadge kind="assignment" status={row.original.status} />,
      }),
      column.accessor((row) => row.durationMs ?? 0, {
        id: 'durationMs',
        header: ({ column: head }) => (
          <DataTableColumnHeader column={head} title="Duration" align="end" />
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-muted-foreground">
            {formatDuration(row.original.durationMs) || EMPTY_CELL}
          </span>
        ),
      }),
      column.accessor('chars', {
        header: ({ column: head }) => (
          <DataTableColumnHeader column={head} title="Characters" align="end" />
        ),
        cell: ({ row }) => (
          <span className="block text-right tabular-nums text-muted-foreground">
            {row.original.chars > 0 ? formatNumber(row.original.chars) : EMPTY_CELL}
          </span>
        ),
      }),
      column.accessor('createdAt', {
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Assigned" />,
        cell: ({ row }) => relativeTimeCell(row.original.createdAt),
      }),
    ]);
  }, []);

  const reportColumns = useMemo(() => {
    const column = createRookeryColumnHelper<Agent>();
    return column.columns([
      column.accessor('name', {
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
        cell: ({ row }) => (
          <NavLink
            to={'/org/agents/' + row.original.id}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </NavLink>
        ),
        enableHiding: false,
      }),
      column.accessor('title', {
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Role" />,
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.title}</span>,
      }),
      column.accessor((row) => org.teams.find((team) => team.id === row.teamId)?.name ?? '', {
        id: 'team',
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Team" />,
        cell: ({ row }) => {
          const team = org.teams.find((entry) => entry.id === row.original.teamId);
          return team ? (
            <NavLink to="/org/teams" className="hover:underline">
              {team.name}
            </NavLink>
          ) : (
            <span className="text-muted-foreground">No team</span>
          );
        },
      }),
      column.accessor((row) => row.provider ?? '', {
        id: 'provider',
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Model" />,
        cell: ({ row }) => (
          <ProviderCell
            {...(row.original.provider ? { provider: row.original.provider } : {})}
            {...(row.original.model ? { model: row.original.model } : {})}
          />
        ),
      }),
      column.accessor((row) => row.permission ?? '', {
        id: 'permission',
        header: ({ column: head }) => <DataTableColumnHeader column={head} title="Permission" />,
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.permission ? PERMISSION_LABEL[row.original.permission] : 'Default'}
          </span>
        ),
      }),
    ]);
  }, [org.teams]);

  // The same table the memory list draws, in its short form: the agent tab
  // used to call the weight "Gewicht" and print it as "0,73" where the list
  // said "Importance" and "73 %".
  const memoryColumns = useMemo(() => buildMemoryColumns({ compact: true }), []);

  /* --------------------------------- states ------------------------------ */

  if (loading && !agent) return <AgentDetailSkeleton />;

  if (!agent) {
    return (
      <PageBody width="3xl">
        {loadError && !missing ? (
          <ServerOffline onRetry={() => void reload()} />
        ) : (
          <EmptyState
            icon={UserRoundIcon}
            title="This agent does not exist"
            description="The entry was deleted, or the address is incorrect."
            actionLabel="View agents"
            actionTo="/org/agents"
          />
        )}
      </PageBody>
    );
  }

  /* -------------------------------- numbers ------------------------------ */

  const failedCount = assignments.filter((entry) => entry.status === 'failed').length;
  const cancelledCount = assignments.filter((entry) => entry.status === 'cancelled').length;
  const doneDurations = assignments
    .filter((entry) => entry.status === 'done' && (entry.durationMs ?? 0) > 0)
    .map((entry) => entry.durationMs ?? 0);
  const meanDuration = formatDuration(Math.round(average(doneDurations)));

  // Both lists come back capped, so every number below rests on what the
  // server handed over - never on "all of them". The footnotes say so, and a
  // list sitting exactly on its ceiling gets the badge as well.
  const assignmentsCapped = assignments.length >= ASSIGNMENT_LIMIT;
  const memoriesCapped = memories.length >= MEMORY_LIMIT;

  const cards: StatCardProps[] = [
    {
      label: 'Assignments',
      value: formatNumber(assignments.length),
      ...cappedBadge(assignmentsCapped),
      headline: assignments.length === 0 ? 'Nothing assigned yet' : 'Last run erteilte Assignments',
      footnote: 'The server returns the latest ' + ASSIGNMENT_LIMIT,
    },
    {
      label: 'Failed',
      value: formatNumber(failedCount),
      ...(cancelledCount > 0
        ? { badge: <Badge variant="outline">{cancelledCount} cancelled</Badge> }
        : {}),
      headline: failedCount === 0 ? 'Nothing has failed' : 'Failures with error messages',
      footnote: 'Among the ' + assignments.length + ' loaded assignments',
    },
    {
      label: 'Average duration',
      value: meanDuration || '–',
      headline: doneDurations.length === 0 ? 'Nothing completed yet' : 'From start to response',
      footnote: 'Across ' + doneDurations.length + ' abgeschlossene Assignments',
    },
    {
      label: 'Memories',
      value: formatNumber(memories.length),
      ...cappedBadge(memoriesCapped),
      headline: memories.length === 0 ? 'Nothing learned yet' : 'Own memory',
      footnote: 'The server returns the latest ' + MEMORY_LIMIT,
    },
  ];

  /* --------------------------------- facts ------------------------------- */

  const manager = org.agentById(agent.managerId);
  const team = org.teams.find((entry) => entry.id === agent.teamId);
  const permission = agent.permission ?? config?.defaultPermission;

  const instructions = agent.instructions.trim();
  const foldInstructions = instructions.length > INSTRUCTIONS_FOLD;

  return (
    <PageBody>
      {dialog}
      {cancelDialog}

      <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
        <span className="text-sm text-muted-foreground">{agent.title}</span>
        <Badge variant="outline" className="font-mono font-normal">
          {agent.slug}
        </Badge>
        {agent.archived && <Badge variant="secondary">archived</Badge>}
      </div>

      <div className="px-4 lg:px-6">
        <MetaList
          columns={2}
          items={[
            {
              label: 'Team',
              value: team?.name ?? 'No team',
              icon: Building2Icon,
              ...(team ? { to: '/org/teams' } : {}),
            },
            {
              label: 'Manager',
              value: manager?.name ?? 'The assistant',
              icon: UsersIcon,
              ...(manager ? { to: '/org/agents/' + manager.id } : {}),
            },
            {
              label: 'Provider',
              value: (
                <ProviderCell
                  layout="inline"
                  {...(agent.provider ? { provider: agent.provider } : {})}
                  {...(agent.model ? { model: agent.model } : {})}
                />
              ),
              icon: CpuIcon,
            },
            {
              label: 'Permission',
              value: permission ? PERMISSION_LABEL[permission] : 'Default',
              icon: ShieldIcon,
            },
          ]}
        />
      </div>

      <StatCards items={cards} />

      {/* Live only while this agent has a run in flight, wherever it was
          started from - the org-wide broadcast Workstream B adds is what
          makes this visible for a run this page never kicked off itself. */}
      {runningAssignment && (
        <div className="px-4 lg:px-6">
          <Card className="py-3">
            <CardHeader className="flex flex-row flex-wrap items-center gap-2 border-b px-3! [&_[data-slot=card-title]]:flex-1">
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                Live now
                <StatusBadge kind="assignment" status={runningAssignment.status} />
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {shorten(runningAssignment.task, 80)}
              </span>
            </CardHeader>
            <CardContent className="px-3!">
              <ActivityTimeline
                items={liveActivity}
                variant="plain"
                emptyLabel="Waiting for the first tool call…"
                limit={8}
              />
            </CardContent>
          </Card>
        </div>
      )}

      <div className="px-4 lg:px-6">
        <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
          <TabsList>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            <TabsTrigger value="reports">Direct reports</TabsTrigger>
            <TabsTrigger value="memories">Memory</TabsTrigger>
            <TabsTrigger value="instructions">Instructions</TabsTrigger>
          </TabsList>

          <TabsContent value="assignments" className="mt-4">
            <DataTable
              flush
              idPrefix="agent-auftraege"
              data={assignments}
              columns={assignmentColumns}
              searchable
              searchPlaceholder="Assignments durchsuchen"
              searchText={(row) => row.task}
              initialSorting={[{ id: 'createdAt', desc: true }]}
              groupTime={(row) => row.createdAt}
              groupSortId="createdAt"
              capped={assignmentsCapped}
              rowLabel={{ singular: 'Assignment', plural: 'assignments' }}
              columnLabels={{
                task: 'Assignment',
                status: 'Status',
                durationMs: 'Duration',
                chars: 'Characters',
                createdAt: 'Assigned',
              }}
              empty={
                <EmptyState
                  icon={InboxIcon}
                  title={'No assignments for ' + agent.name}
                  description="Assignments run in a separate process, independently of the conversation."
                  actionLabel="Create assignment"
                  onAction={() => setAssignOpen(true)}
                  variant="plain"
                  size="sm"
                />
              }
            />
          </TabsContent>

          <TabsContent value="reports" className="mt-4">
            <DataTable
              flush
              idPrefix="agent-unterstellt"
              data={reports}
              columns={reportColumns}
              paginate={false}
              showColumnMenu={false}
              rowLabel={{ singular: 'Agent', plural: 'Agents' }}
              empty={
                <EmptyState
                  icon={UsersIcon}
                  title={'No one reports to ' + agent.name}
                  description="Assign a manager in an agent’s profile to make that agent a direct report."
                  actionLabel="Hire agent"
                  actionTo="/org/agents/new"
                  variant="plain"
                  size="sm"
                />
              }
            />
          </TabsContent>

          <TabsContent value="memories" className="mt-4">
            <DataTable
              flush
              idPrefix="agent-gedaechtnis"
              data={memories}
              columns={memoryColumns}
              searchable
              searchPlaceholder="Search memories"
              searchText={(row) => row.content + ' ' + row.tags.join(' ')}
              initialSorting={[{ id: 'createdAt', desc: true }]}
              groupTime={(row) => row.createdAt}
              groupSortId="createdAt"
              capped={memoriesCapped}
              rowLabel={{ singular: 'Memory', plural: 'Memories' }}
              columnLabels={MEMORY_COLUMN_LABELS}
              empty={
                <EmptyState
                  icon={BrainIcon}
                  title="Nothing learned yet"
                  description={
                    agent.name + ' learns from its own assignments, not from this conversation.'
                  }
                  actionLabel="Create assignment"
                  onAction={() => setAssignOpen(true)}
                  variant="plain"
                  size="sm"
                />
              }
            />
          </TabsContent>

          <TabsContent value="instructions" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Instructions</CardTitle>
                <CardDescription>
                  The exact assignment text that {agent.name} starts every run with.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {instructions === '' ? (
                  <EmptyState
                    icon={PencilIcon}
                    title="No instructions provided"
                    description="Without custom instructions, the agent works only from the assignment text."
                    actionLabel="Edit"
                    actionTo={'/org/agents/' + agent.id + '/edit'}
                    variant="plain"
                    size="sm"
                  />
                ) : foldInstructions ? (
                  <>
                    <ResultMarkdown text={shorten(instructions, INSTRUCTIONS_FOLD)} />
                    {/* The fold, not a truncation: the whole text stays one
                        click away instead of being cut off for good. */}
                    <Accordion type="single" collapsible>
                      <AccordionItem value="full" className="border-b-0">
                        <AccordionTrigger>Show full text</AccordionTrigger>
                        <AccordionContent>
                          <ResultMarkdown text={instructions} />
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  </>
                ) : (
                  <ResultMarkdown text={instructions} />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* ------------------------------ assign ------------------------------ */}
      <DetailDrawer
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title={'Assignment for ' + agent.name}
        description="Runs as a fresh process in the project directory or workspace."
        className="data-[vaul-drawer-direction=right]:sm:max-w-xl"
        footer={
          <Button onClick={assign} disabled={busy || !task.trim()}>
            <SendIcon data-icon="inline-start" />
            {busy ? 'Running…' : 'Start'}
          </Button>
        }
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="assign-task">Assignment</FieldLabel>
            <Textarea
              id="assign-task"
              rows={5}
              required
              placeholder={'What should ' + agent.name + ' do?'}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              disabled={busy}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="assign-project">Project</FieldLabel>
            <Select value={projectId} onValueChange={setProjectId} disabled={busy}>
              <SelectTrigger id="assign-project" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>No project</SelectItem>
                {org.projects
                  .filter((project) => !project.archived)
                  .map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {permission
                ? 'Permission ' + PERMISSION_LABEL[permission] + ': ' + PERMISSION_HINT[permission]
                : 'The run uses the permission level from Settings.'}
            </FieldDescription>
          </Field>
        </FieldGroup>

        {/* Derselbe Bau wie auf /org/assignments/:id und im Formularrahmen:
            `Alert` bringt `role="alert"` mit, ein nacktes <p> sagte einer
            Vorlesehilfe nichts. */}
        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>The assignment failed</AlertTitle>
            <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* The stream stays in the drawer: the page behind it must not jump
            while an agent works. */}
        {live.length > 0 && (
          <LiveRunList assignments={live} onCancel={cancelRun} variant="plain" />
        )}

        {result && (
          <div className="rounded-xl border p-4">
            <ResultMarkdown text={result} />
          </div>
        )}
      </DetailDrawer>
    </PageBody>
  );
}

/**
 * The loading state, in the geometry the loaded page will have: the fact
 * rows, the four numbers, the tab bar and a table. Anything shorter would
 * make the header jump the moment the request comes back.
 */
function AgentDetailSkeleton() {
  return (
    <PageBody>
      <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-24" />
      </div>

      <MetaListSkeleton className="px-4 lg:px-6" />
      <StatCardsSkeleton />

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <Skeleton className="h-9 w-96 max-w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
    </PageBody>
  );
}
