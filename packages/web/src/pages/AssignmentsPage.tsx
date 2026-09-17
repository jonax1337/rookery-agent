import * as React from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  BanIcon,
  ClipboardCheckIcon as ListTodoIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  SendIcon as AnimatedSendIcon,
  UserIcon as UserRoundIcon,
} from "@/components/icons";
import { toast } from 'sonner';
import { z } from 'zod';

import { formatDateTime, formatDuration, relativeTime, shorten } from '@/lib/format';
import {
  average,
  bucketByDay,
  daysAgo,
  formatNumber,
  formatPercent,
  ratePercent,
  startOfDay,
} from '@/lib/stats';
import { api } from '@/lib/api';
import type {
  Agent,
  Assignment,
  AssignmentStatus,
  AssignmentView,
  ProviderId,
  Task,
} from '@/lib/types';
import { useConnection, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { useStatsTotals } from '@/hooks/useStatsTotals';
import { usePageMeta } from '@/components/shell/page-meta';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { PageBody } from '@/components/blocks/page-body';
import { cappedBadge, StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import { TrendChartCard, type TrendSeries } from '@/components/blocks/trend-chart-card';
import {
  DetailDrawer,
  DetailDrawerTrigger,
  useDrawerSubject,
} from '@/components/blocks/detail-drawer';
import { DataTable, type DataTableTab } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  EMPTY_CELL,
  relativeTimeCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import {
  createRookeryColumnHelper,
  type RookeryColumnDef,
} from '@/components/blocks/data-table/table-features';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { AssignmentTerminal } from '@/components/common/assignment-terminal';
import { FormField, type FieldAria } from '@/components/forms/form-kit';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { RunningBadge, StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import type { IconComponent } from "@/components/icons";

/**
 * Every single run an agent was ever asked to do.
 *
 * The page is the full `dashboard-01` triple - headline numbers, a stacked
 * day curve, one big table - because assignments are the one thing in this
 * app that exists in the thousands and carries a status, a duration and a
 * size. Everything a card or a curve shows rests on the same loaded window,
 * and each of them says so.
 *
 * Two honesty rules shape what is here. Nothing claims a total the API cannot
 * prove: the only real totals come from `GET /api/stats`, everything else
 * names "die letzten 500" in its footnote and wears "gedeckelt" once the list
 * hangs exactly at the cap. And the cards that count states count them over
 * the *unfiltered* window, never over whatever the status tab narrowed the
 * request to - otherwise "Completed" would read 500 on the "Done" tab.
 */

/** The server's ceiling for one list request; the honest base of every count. */
const LIMIT = 500;

/** How long a burst of socket news is collected before one silent refetch. */
const REFRESH_DEBOUNCE_MS = 600;

/* ------------------------------ the row type ----------------------------- */

/**
 * One table row: an `Assignment` flattened, with the agent's name resolved and
 * the live status overlaid.
 *
 * Flat rather than a nested `{ assignment, agent }` because sorting, the
 * column visibility menu and the toolbar search all address fields by name.
 */
export interface AssignmentRow {
  id: string;
  status: AssignmentStatus;
  agentId: string;
  agentName: string;
  agentSlug: string;
  /** The run's name - a task's name when it carries one out. */
  title: string;
  /** The full brief, kept for search and for the drawer. */
  task: string;
  provider?: ProviderId;
  model?: string;
  chars: number;
  durationMs?: number;
  depth: number;
  createdAt: number;
  error?: string;
  /** The board task this run belongs to, when one points at it. */
  taskId?: string;
}

/**
 * Builds a row, letting the socket's newest word win over the loaded record.
 *
 * That overlay is what replaced the old full reload on every broadcast: a
 * running assignment changes its status, its character count and its duration
 * several times a second, and refetching 500 rows for each of them made the
 * table flicker for the whole length of a run.
 */
export function toAssignmentRow(
  assignment: Assignment,
  agent?: Agent,
  live?: AssignmentView,
  taskId?: string,
): AssignmentRow {
  const durationMs = live?.durationMs ?? assignment.durationMs;
  const provider = assignment.provider ?? live?.provider;
  const error = assignment.error ?? live?.error;

  return {
    id: assignment.id,
    status: live?.status ?? assignment.status,
    agentId: assignment.agentId,
    agentName: agent?.name ?? live?.agentName ?? 'Unknown',
    agentSlug: agent?.slug ?? live?.agentSlug ?? '',
    title: live?.title ?? assignment.title,
    task: assignment.task,
    chars: live?.chars ?? assignment.chars,
    depth: assignment.depth,
    createdAt: assignment.createdAt,
    ...(provider ? { provider } : {}),
    ...(assignment.model ? { model: assignment.model } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(error ? { error } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

/** German column names for the visibility menu, keyed by column id. */
export const ASSIGNMENT_COLUMN_LABELS: Record<string, string> = {
  status: 'Status',
  agentName: 'Agent',
  task: 'Assignment',
  provider: 'Provider',
  chars: 'Characters',
  durationMs: 'Duration',
  depth: 'Level',
  createdAt: 'Time',
};

/** Level is noise on a flat list, so it starts hidden and stays in the menu. */
export const ASSIGNMENT_HIDDEN_COLUMNS = { depth: false };

export const ASSIGNMENT_SORTING = [{ id: 'createdAt', desc: true }];

export const ASSIGNMENT_ROW_LABEL = { singular: 'Assignment', plural: 'assignments' };

export interface AssignmentColumnOptions {
  /** Opens the row drawer. Left out where the table has no drawer. */
  onOpenDetail?: (row: AssignmentRow) => void;
  /** Given: pending and running rows offer "Cancel". */
  onCancel?: (row: AssignmentRow) => void;
  /** Drops the checkbox column, for the read-only children table. */
  selectable?: boolean;
}

const column = createRookeryColumnHelper<AssignmentRow>();

/**
 * The assignment columns, shared by this page's table and the "Delegated"
 * table on the detail page - two views of the same kind of record should not
 * drift into two different sets of columns.
 */
export function buildAssignmentColumns({
  onOpenDetail,
  onCancel,
  selectable = true,
}: AssignmentColumnOptions = {}): RookeryColumnDef<AssignmentRow>[] {
  const columns: RookeryColumnDef<AssignmentRow>[] = [];

  if (selectable) {
    columns.push(
      selectionColumn<AssignmentRow>({
        rowLabel: (row) => shorten(row.title, 60) + ' selected',
      }),
    );
  }

  columns.push(
    column.accessor('status', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
      // A running row gets the spinner alone: the badge next to it would say
      // "running" in a table where motion already says it, and the column stays
      // narrow enough for the task text to keep its two lines.
      cell: ({ row }) =>
        row.original.status === 'running' ? (
          <span className="flex items-center gap-1.5 text-sm">
            <Spinner className="size-4 text-primary" aria-hidden="true" />
            <span className="sr-only">running</span>
          </span>
        ) : (
          <StatusBadge kind="assignment" status={row.original.status} />
        ),
      enableHiding: false,
    }),

    column.accessor('agentName', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Agent" />,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <NavLink
            to={'/org/agents/' + row.original.agentId}
            className="truncate text-sm font-medium hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {row.original.agentName}
          </NavLink>
          {row.original.agentSlug ? (
            <Badge variant="outline" className="font-mono text-2xs font-normal">
              {row.original.agentSlug}
            </Badge>
          ) : null}
        </div>
      ),
    }),

    // The name, never the brief: three runs of the same errand start with
    // the same twenty words, and a column of those tells nobody them apart.
    column.accessor('title', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Run" />,
      cell: ({ row }) =>
        onOpenDetail ? (
          <DetailDrawerTrigger
            className="line-clamp-2 h-auto max-w-xl py-0 text-sm whitespace-normal"
            onClick={() => onOpenDetail(row.original)}
          >
            {row.original.title}
          </DetailDrawerTrigger>
        ) : (
          <NavLink
            to={'/assignments/' + row.original.id}
            className="line-clamp-2 max-w-xl text-sm hover:underline"
          >
            {row.original.title}
          </NavLink>
        ),
      enableHiding: false,
    }),

    column.accessor('provider', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Provider" />,
      cell: ({ row }) => (
        <ProviderCell
          {...(row.original.provider ? { provider: row.original.provider } : {})}
          {...(row.original.model ? { model: row.original.model } : {})}
        />
      ),
    }),

    column.accessor('chars', {
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Characters" align="end" />
      ),
      cell: ({ row }) => (
        <div className="text-right text-sm tabular-nums">
          {row.original.chars > 0 ? formatNumber(row.original.chars) : EMPTY_CELL}
        </div>
      ),
    }),

    column.accessor('durationMs', {
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Duration" align="end" />
      ),
      cell: ({ row }) => (
        <div className="text-right text-sm tabular-nums">
          {formatDuration(row.original.durationMs) || EMPTY_CELL}
        </div>
      ),
    }),

    column.accessor('depth', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Level" />,
      // Depth 0 is the normal case - a badge on every row would say nothing.
      cell: ({ row }) =>
        row.original.depth > 0 ? (
          <Badge variant="outline" className="tabular-nums">
            Level {row.original.depth}
          </Badge>
        ) : null,
    }),

    column.accessor('createdAt', {
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Time" align="end" />
      ),
      cell: ({ row }) => relativeTimeCell(row.original.createdAt, { align: 'end' }),
    }),

    actionsColumn<AssignmentRow>((row) => (
      <RowActions row={row} {...(onCancel ? { onCancel } : {})} />
    )),
  );

  return column.columns(columns);
}

/**
 * The row menu.
 *
 * "Cancel" sits here rather than only on the detail page: stopping a run
 * that is going wrong used to cost two navigations, which is one too many for
 * something people do while watching the list.
 */
function RowActions({
  row,
  onCancel,
}: {
  row: AssignmentRow;
  onCancel?: (row: AssignmentRow) => void;
}) {
  const cancellable = row.status === 'pending' || row.status === 'running';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Actions for ' + shorten(row.title, 60)} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <NavLink to={'/assignments/' + row.id}>
            <SquareArrowOutUpRightIcon data-icon="inline-start" />
            Open
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <NavLink to={'/org/agents/' + row.agentId}>
            <UserRoundIcon data-icon="inline-start" />
            Open agent
          </NavLink>
        </DropdownMenuItem>
        {row.taskId ? (
          <DropdownMenuItem asChild>
            <NavLink to={'/tasks/' + row.taskId}>
              <ListTodoIcon data-icon="inline-start" />
              View task
            </NavLink>
          </DropdownMenuItem>
        ) : null}
        {cancellable && onCancel ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onCancel(row)}>
              <BanIcon data-icon="inline-start" />
              Cancel
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* --------------------------------- facets -------------------------------- */

interface FacetTab {
  value: string;
  label: string;
  /** What goes into the server's `status[]`; unset means "no filter". */
  status?: AssignmentStatus[];
}

/**
 * The status tabs, each one a server parameter rather than a client filter -
 * with no paging in the API, filtering after the fact would only ever search
 * inside the newest 500 rows, so a long-finished failure would be unreachable.
 */
const TABS: FacetTab[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running', status: ['pending', 'running'] },
  { value: 'done', label: 'Done', status: ['done'] },
  { value: 'failed', label: 'Failed', status: ['failed'] },
  { value: 'cancelled', label: 'Cancelled', status: ['cancelled'] },
];

/**
 * Chart bands: the outcomes an assignment can stand in today.
 *
 * The curve is dated by `createdAt`, so a band says "this many of the
 * assignments created that day ended like this" - not "this many finished
 * that day". Assignments still pending or running carry no outcome yet and
 * are left out rather than guessed at; the card description spells both
 * halves out, because "nach Abschluss gestapelt" read as a completion curve
 * and was the wrong sentence for this data.
 */
type ChartKey = 'done' | 'failed' | 'cancelled';

const CHART_SERIES: TrendSeries[] = [
  { key: 'done', label: 'Done', color: 'var(--chart-1)' },
  { key: 'failed', label: 'Failed', color: 'var(--chart-5)' },
  { key: 'cancelled', label: 'Cancelled', color: 'var(--chart-3)' },
];

const CHART_KEYS: ChartKey[] = ['done', 'failed', 'cancelled'];

/* ------------------------------- the page -------------------------------- */

/**
 * The empty states swap their lucide send for the animate-ui one: same
 * silhouette and stroke, the paper plane flies once when the state enters
 * the viewport. `EmptyState` types its `icon` as a `IconComponent` and renders
 * it without props, so the `animateOnView` trigger rides along in this shell.
 */
const EmptySendIcon = React.forwardRef<SVGSVGElement>(function EmptySendIcon() {
  return <AnimatedSendIcon size={24} />;
});

export function AssignmentsPage() {
  const navigate = useNavigate();
  const { socket } = useConnection();
  const org = useOrgState();
  const { tasks } = useTasksState();
  // Eine Rueckfrage fuer alle sechs Abbruchstellen der App - inklusive der
  // Sammelaktion unten, die bisher als einzige ohne gefragt hat.
  const { dialog, cancelAssignment, cancelAssignments } = useCancelAssignment();

  const [tab, setTab] = React.useState('all');
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [detailRow, setDetailRow] = React.useState<AssignmentRow | null>(null);

  const activeTab = TABS.find((entry) => entry.value === tab) ?? TABS[0];
  const status = activeTab?.status;
  const narrowed = status !== undefined || agentId !== null;

  /* ------------------------------- loading ------------------------------ */

  const [base, setBase] = React.useState<Assignment[]>([]);
  const [baseState, setBaseState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [narrow, setNarrow] = React.useState<Assignment[]>([]);
  const [narrowState, setNarrowState] = React.useState<'loading' | 'ready' | 'error'>('ready');

  // The real totals, the one number on this page that is not an estimate -
  // shared with the other lists so the same tile is equally current.
  const totals = useStatsTotals(socket);

  // Sequence guard: silent socket reloads, the retry and the drawer's
  // "assigned" nudge can overlap; only the newest run may write state.
  const baseSeq = React.useRef(0);

  /**
   * The unfiltered window. Everything above the table rests on it, which is
   * what keeps "Completed" meaning the same thing on every tab.
   */
  const loadBase = React.useCallback(async (silent = false): Promise<void> => {
    const seq = ++baseSeq.current;
    if (!silent) setBaseState('loading');
    try {
      const list = await api.assignments({ limit: LIMIT });
      if (seq !== baseSeq.current) return;
      setBase(list);
      setBaseState('ready');
    } catch {
      if (seq !== baseSeq.current) return;
      // A silent failure must not strand the skeleton: if it invalidated an
      // older visible load still showing `loading`, the newest run owes the
      // view a verdict — error with its retry beats a frozen table.
      if (!silent) setBaseState('error');
      else setBaseState((previous) => (previous === 'loading' ? 'error' : previous));
    }
  }, []);

  const statusKey = status?.join(',') ?? '';
  // Sequence guard: switching the status tab or the agent filter starts a new
  // request; a slow answer for the previous one must not land in the new list.
  const narrowSeq = React.useRef(0);
  const loadNarrow = React.useCallback(
    async (silent = false): Promise<void> => {
      const seq = ++narrowSeq.current;
      if (!narrowed) return;
      if (!silent) setNarrowState('loading');
      try {
        const list = await api.assignments({
          limit: LIMIT,
          ...(statusKey ? { status: statusKey.split(',') as AssignmentStatus[] } : {}),
          ...(agentId ? { agentId } : {}),
        });
        if (seq !== narrowSeq.current) return;
        setNarrow(list);
        setNarrowState('ready');
      } catch {
        if (seq !== narrowSeq.current) return;
        // Same as loadBase: a silent failure owes a verdict to a view it
        // invalidated, but stays quiet over a ready one.
        if (!silent) setNarrowState('error');
        else setNarrowState((previous) => (previous === 'loading' ? 'error' : previous));
      }
    },
    [agentId, narrowed, statusKey],
  );

  React.useEffect(() => {
    void loadBase();
  }, [loadBase]);

  React.useEffect(() => {
    void loadNarrow();
  }, [loadNarrow]);

  const list = narrowed ? narrow : base;
  const listState = narrowed ? narrowState : baseState;

  /* ------------------------- live merge, not reload --------------------- */

  const knownIds = React.useMemo(() => new Set(list.map((entry) => entry.id)), [list]);
  const knownRef = React.useRef(knownIds);
  knownRef.current = knownIds;

  // Assignments we have already refetched for, so an id that does not match
  // the current filter cannot re-trigger a load on every single broadcast.
  const handledRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    handledRef.current = new Set();
  }, [statusKey, agentId]);

  React.useEffect(() => {
    if (listState === 'loading') return;
    const fresh = Object.keys(org.live).filter(
      (id) => !knownRef.current.has(id) && !handledRef.current.has(id),
    );
    if (fresh.length === 0) return;
    for (const id of fresh) handledRef.current.add(id);

    // Only a genuinely new assignment is worth a request; everything else the
    // socket says about a row we already hold is merged in memory below.
    const timer = setTimeout(() => {
      void loadBase(true);
      void loadNarrow(true);
    }, REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [org.live, listState, loadBase, loadNarrow]);

  /* -------------------------------- rows -------------------------------- */

  /** Which board task points at which assignment, for "View task". */
  const taskByAssignment = React.useMemo(() => {
    const map = new Map<string, Task>();
    for (const task of tasks) if (task.assignmentId) map.set(task.assignmentId, task);
    return map;
  }, [tasks]);

  const rows = React.useMemo(
    () =>
      list.map((assignment) =>
        toAssignmentRow(
          assignment,
          org.agentById(assignment.agentId),
          org.live[assignment.id],
          taskByAssignment.get(assignment.id)?.id,
        ),
      ),
    [list, org, taskByAssignment],
  );

  /* ------------------------------- numbers ------------------------------ */

  const baseCapped = base.length >= LIMIT;
  const basis = totals
    ? 'Based on the latest ' +
      formatNumber(base.length) +
      ' of ' +
      formatNumber(totals.assignments) +
      ' assignments'
    : 'Based on the latest ' + formatNumber(base.length) + ' Assignments';

  const counts = React.useMemo(() => {
    const tally: Record<AssignmentStatus, number> = {
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const entry of base) tally[org.live[entry.id]?.status ?? entry.status] += 1;
    return tally;
  }, [base, org.live]);

  const meanDuration = React.useMemo(
    () =>
      average(
        base.flatMap((entry) =>
          entry.status === 'done' && entry.durationMs && entry.durationMs > 0
            ? [entry.durationMs]
            : [],
        ),
      ),
    [base],
  );

  const running = org.running.length;

  // The number cards roll their digits rather than count: the counts keep
  // changing with the socket, and only SlidingNumber holds formatNumber's
  // en-GB grouping ("1,234") once it settles - CountingNumber would drop the
  // separator and change the resting pose.
  const cards: StatCardProps[] = [
    {
      label: 'Running now',
      value: <SlidingNumber number={running} thousandSeparator="," />,
      ...(running > 0 ? { badge: <RunningBadge count={running} /> } : {}),
      headline: running > 0 ? 'The organization is working' : 'No work in progress',
      // The one card that is not an estimate at all: the socket knows every
      // run that is open right now, capped list or not.
      footnote: 'From the current organization state',
    },
    {
      label: 'Completed',
      value: <SlidingNumber number={counts.done} thousandSeparator="," />,
      headline:
        base.length > 0
          ? formatPercent(ratePercent(counts.done, base.length)) + ' of loaded assignments'
          : 'Nothing completed yet',
      footnote: basis,
    },
    {
      label: 'Failed',
      value: <SlidingNumber number={counts.failed} thousandSeparator="," />,
      ...(counts.cancelled > 0
        ? {
            badge: (
              <Badge variant="destructive">
                {formatNumber(counts.cancelled)} cancelled
              </Badge>
            ),
          }
        : {}),
      headline:
        base.length > 0
          ? formatPercent(ratePercent(counts.failed, base.length)) + ' of loaded assignments'
          : 'No failures yet',
      footnote: basis,
    },
    {
      label: 'Average duration',
      value: meanDuration > 0 ? formatDuration(meanDuration) : '–',
      headline: 'Across ' + formatNumber(counts.done) + ' completed assignments',
      footnote: basis,
    },
  ];

  /* -------------------------------- chart ------------------------------- */

  const chartSince = React.useMemo(() => startOfDay(daysAgo(89)), []);
  const chartData = React.useMemo(
    () =>
      bucketByDay<Assignment, ChartKey>(base, (entry) => entry.createdAt, {
        since: chartSince,
        keys: CHART_KEYS,
        seriesOf: (entry) => {
          const state = org.live[entry.id]?.status ?? entry.status;
          return state === 'done' || state === 'failed' || state === 'cancelled' ? state : null;
        },
      }),
    [base, chartSince, org.live],
  );

  /* ------------------------------- actions ------------------------------ */

  const cancel = React.useCallback(
    (row: AssignmentRow): void => {
      void cancelAssignment(row.id);
    },
    [cancelAssignment],
  );

  const columns = React.useMemo(
    () => buildAssignmentColumns({ onOpenDetail: setDetailRow, onCancel: cancel }),
    [cancel],
  );

  usePageMeta({
    breadcrumb: [{ label: 'Runs' }],
    actions: (
      <Button size="sm" onClick={() => setAssignOpen(true)}>
        {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
        <AnimatedSendIcon data-icon="inline-start" />
        Assign agent
      </Button>
    ),
  });

  /* ------------------------------- facets ------------------------------- */

  // Counts on the tabs would be a guess once the window is capped, so they
  // only appear while the loaded list really is everything there is.
  const tabs: DataTableTab[] = TABS.map((entry) => {
    const count = baseCapped
      ? undefined
      : entry.status
        ? entry.status.reduce((sum, state) => sum + counts[state], 0)
        : base.length;
    return { value: entry.value, label: entry.label, ...(count === undefined ? {} : { count }) };
  });

  const agentOptions = React.useMemo(
    () =>
      org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name })),
    [org.agents],
  );

  const retry = (): void => {
    void loadBase();
    void loadNarrow();
  };

  return (
    <PageBody>
      {dialog}

      {baseState === 'error' ? (
        <Fade>
          <div className="px-4 lg:px-6">
            <ServerOffline onRetry={retry} />
          </div>
        </Fade>
      ) : (
        <>
          <Fade>
            <StatCards items={cards} />
          </Fade>

          <Fade delay={50}>
            <div className="px-4 lg:px-6">
              <TrendChartCard
                title="Runs started per day"
                description={
                  'Colored by their current outcome; runs still going are not included yet. ' +
                  basis +
                  '.'
                }
                descriptionShort="Created per day"
                data={chartData}
                series={CHART_SERIES}
                {...cappedBadge(baseCapped)}
                empty={
                  <Fade>
                    <EmptyState
                      icon={EmptySendIcon}
                      title="Nothing in this period"
                      description="Nothing started during the selected days has finished yet."
                      variant="plain"
                      size="sm"
                    />
                  </Fade>
                }
              />
            </div>
          </Fade>
        </>
      )}

      <Fade delay={100}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          tabs={tabs}
          tab={tab}
          onTabChange={setTab}
          tabLabel="Status"
          searchable
          searchPlaceholder="Search runs"
          searchText={(row) => row.title + ' ' + row.task}
          filters={
            <AgentFilter options={agentOptions} value={agentId} onChange={setAgentId} />
          }
          columnLabels={ASSIGNMENT_COLUMN_LABELS}
          initialSorting={ASSIGNMENT_SORTING}
          initialColumnVisibility={ASSIGNMENT_HIDDEN_COLUMNS}
          pageSize={20}
          capped={list.length >= LIMIT}
          rowLabel={ASSIGNMENT_ROW_LABEL}
          loading={listState === 'loading' && rows.length === 0}
          idPrefix="auftraege"
          // The ganze Zeile oeffnet die Schublade, wie auf /chats und /tasks -
          // ausser dort, wo die Zelle selbst etwas anderes tut.
          onRowClick={setDetailRow}
          rowClickIgnoreColumns={['select', 'task', 'actions']}
          bulkActions={(selected, clear) => {
            const open = selected.filter(
              (row) => row.status === 'pending' || row.status === 'running',
            );
            return (
              <Button
                variant="outline"
                size="sm"
                disabled={open.length === 0}
                onClick={() => {
                  void cancelAssignments(open.map((row) => row.id)).then((stopped) => {
                    if (stopped !== null) clear();
                  });
                }}
              >
                <BanIcon data-icon="inline-start" />
                {formatNumber(open.length)} cancel
              </Button>
            );
          }}
          error={listState === 'error' ? <ServerOffline onRetry={retry} size="sm" /> : undefined}
          empty={
            <Fade>
              <EmptyState
                icon={EmptySendIcon}
                title="Nothing has run yet"
                description="Each agent run appears here with its result, duration, and reported usage."
                actionLabel="Assign agent"
                onAction={() => setAssignOpen(true)}
                variant="plain"
                size="sm"
              />
            </Fade>
          }
        />
      </Fade>

      <AssignDrawer
        open={assignOpen}
        onOpenChange={setAssignOpen}
        agents={org.agents}
        projects={org.projects.filter((project) => !project.archived)}
        onAssigned={() => {
          void loadBase(true);
          void loadNarrow(true);
        }}
        assign={(payload, handlers) => socket.sendAssign(payload, handlers)}
      />

      <RowDrawer
        row={detailRow}
        onOpenChange={(next) => {
          if (!next) setDetailRow(null);
        }}
        onOpen={(id) => {
          setDetailRow(null);
          void navigate('/assignments/' + id);
        }}
        onCancel={cancel}
      />
    </PageBody>
  );
}

/* ------------------------------ the filters ------------------------------ */

interface Option {
  value: string;
  label: string;
}

/**
 * The agent filter.
 *
 * It sets the server's `agentId`, not a client predicate, for the same reason
 * the status tabs do: filtering inside the newest 500 rows would hide an
 * agent's older work entirely.
 */
function AgentFilter({
  options,
  value,
  onChange,
}: {
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(next: Option | null) => onChange(next?.value ?? null)}
    >
      <ComboboxInput
        placeholder="All Agents"
        aria-label="Filter by agent"
        className="h-8 w-full sm:w-48"
        showClear={selected !== null}
      />
      <ComboboxContent>
        <ComboboxEmpty>No agent found</ComboboxEmpty>
        <ComboboxList>
          {(item: Option) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/* ------------------------------- the drawers ----------------------------- */

/** What the row drawer shows: the whole record, without leaving the table. */
function RowDrawer({
  row: chosen,
  onOpenChange,
  onOpen,
  onCancel,
}: {
  row: AssignmentRow | null;
  onOpenChange: (open: boolean) => void;
  onOpen: (id: string) => void;
  onCancel: (row: AssignmentRow) => void;
}) {
  // The Zeile bleibt stehen, bis die Schublade zugefahren ist - `open` ist
  // damit eine echte Statussangabe statt eines fest verdrahteten `true`.
  const row = useDrawerSubject(chosen);
  if (!row) return null;
  const cancellable = row.status === 'pending' || row.status === 'running';

  return (
    <DetailDrawer
      open={chosen !== null}
      onOpenChange={onOpenChange}
      title={shorten(row.title, 80)}
      description={row.agentName + ' · ' + relativeTime(row.createdAt)}
      footer={
        <div className="flex flex-wrap gap-2">
          <Button className="flex-1" onClick={() => onOpen(row.id)}>
            Open assignment
          </Button>
          {cancellable ? (
            <Button variant="outline" onClick={() => onCancel(row)}>
              <BanIcon data-icon="inline-start" />
              Cancel
            </Button>
          ) : null}
        </div>
      }
    >
      {row.status === 'running' ? (
        // The run is happening now, one drawer away from the table: watch it
        // live instead of waiting for the row to change. No status override -
        // the terminal reads `org.live`, which keeps moving after the table's
        // copy was taken. Live-only: the moment the run ends, the buffer is
        // gone and this collapses to the facts below.
        <AssignmentTerminal assignmentId={row.id} />
      ) : null}

      <MetaList
        columns={1}
        items={[
          { label: 'Status', value: <StatusBadge kind="assignment" status={row.status} /> },
          {
            label: 'Agent',
            value: row.agentName,
            to: '/org/agents/' + row.agentId,
          },
          {
            label: 'Provider',
            value: row.provider ? (
              <ProviderCell
                provider={row.provider}
                {...(row.model ? { model: row.model } : {})}
                layout="inline"
              />
            ) : null,
          },
          { label: 'Characters', value: row.chars > 0 ? formatNumber(row.chars) : null },
          { label: 'Duration', value: formatDuration(row.durationMs) || null },
          { label: 'Level', value: row.depth > 0 ? String(row.depth) : null },
          { label: 'Created', value: formatDateTime(row.createdAt) },
        ]}
      />

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">Brief</p>
        <p className="whitespace-pre-wrap">{row.task}</p>
      </div>

      {row.error ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Error</p>
          <p className="whitespace-pre-wrap text-destructive">{row.error}</p>
        </div>
      ) : null}
    </DetailDrawer>
  );
}

const assignSchema = z.object({
  agent: z.string().min(1, 'Select an agent.'),
  task: z.string().trim().min(3, 'The assignment needs at least one sentence.'),
});

type AssignErrors = Partial<Record<'agent' | 'task', string>>;

/**
 * Hand an agent a job, from the page that lists what came of it.
 *
 * The turn runs over the socket exactly as it does in the chat - the drawer
 * only needs to know that it started; the row appears in the table as soon as
 * the first broadcast names it.
 */
function AssignDrawer({
  open,
  onOpenChange,
  agents,
  projects,
  onAssigned,
  assign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  projects: { id: string; name: string }[];
  onAssigned: () => void;
  assign: (
    payload: { agent: string; task: string; projectId?: string },
    handlers: {
      onEvent: () => void;
      onDone: (text: string) => void;
      onError: (message: string) => void;
    },
  ) => string;
}) {
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [task, setTask] = React.useState('');
  const [errors, setErrors] = React.useState<AssignErrors>({});
  const [busy, setBusy] = React.useState(false);

  const agentOptions = React.useMemo(
    () =>
      agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name + ' · ' + agent.slug })),
    [agents],
  );
  const projectOptions = React.useMemo(
    () => projects.map((project) => ({ value: project.id, label: project.name })),
    [projects],
  );

  const submit = (): void => {
    const parsed = assignSchema.safeParse({ agent: agentId ?? '', task });
    if (!parsed.success) {
      const next: AssignErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'agent' || field === 'task') next[field] = issue.message;
      }
      setErrors(next);
      return;
    }
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) return;

    setErrors({});
    setBusy(true);
    assign(
      {
        agent: agent.slug,
        task: parsed.data.task,
        ...(projectId ? { projectId } : {}),
      },
      {
        // The live rows arrive on the org socket anyway; this turn's own
        // stream is only interesting for its end.
        onEvent: () => undefined,
        onDone: () => {
          setBusy(false);
          onAssigned();
          toast('Assignment completed');
        },
        onError: (message) => {
          setBusy(false);
          toast.error('Assignment failed', { description: message });
        },
      },
    );

    toast(agent.name + ' has been assigned');
    setTask('');
    onOpenChange(false);
    onAssigned();
  };

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Assign agent"
      description="The run starts immediately and appears in the table."
      closeLabel="Cancel"
      footer={
        <Button onClick={submit} disabled={busy}>
          {busy ? <Spinner aria-label="Starting" /> : (
            <AnimatedSendIcon data-icon="inline-start" />
          )}
          Assign
        </Button>
      }
    >
      <FieldGroup>
        {/* FormField statt handverdrahtetem Field: `data-invalid` faerbte die
            Gruppe zwar rot, das Bedienelement selbst trug aber weder
            `aria-invalid` noch einen Verweis auf seine Meldung. */}
        <FormField id="auftrag-agent" label="Agent" error={errors.agent}>
          {(control) => (
            <OptionCombobox
              {...control}
              options={agentOptions}
              value={agentId}
              onChange={setAgentId}
              placeholder="Select agent"
            />
          )}
        </FormField>

        <FormField
          id="auftrag-projekt"
          label="Project"
          description="Determines which directory the agent works in."
        >
          {(control) => (
            <OptionCombobox
              {...control}
              options={projectOptions}
              value={projectId}
              onChange={setProjectId}
              placeholder="No project"
            />
          )}
        </FormField>

        <FormField id="auftrag-text" label="Task" error={errors.task}>
          {(control) => (
            <Textarea
              {...control}
              rows={6}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="What should be done?"
            />
          )}
        </FormField>
      </FieldGroup>
    </DetailDrawer>
  );
}

/**
 * The plain single-select combobox both fields in the drawer use.
 *
 * Nimmt die ARIA-Props aus `FormField` entgegen und reicht sie an die Eingabe
 * durch - dort sitzt der Fokus, also muss dort auch stehen, dass das Feld
 * abgelehnt wurde und wo die Begruendung steht.
 */
function OptionCombobox({
  options,
  value,
  onChange,
  placeholder,
  ...control
}: FieldAria['control'] & {
  options: Option[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder: string;
}) {
  const selected = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(next: Option | null) => onChange(next?.value ?? null)}
    >
      <ComboboxInput {...control} placeholder={placeholder} showClear={selected !== null} />
      <ComboboxContent>
        <ComboboxEmpty>Nothing found</ComboboxEmpty>
        <ComboboxList>
          {(item: Option) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
