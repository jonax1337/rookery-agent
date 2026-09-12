import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  CalendarClockIcon,
  ClockAlertIcon,
  HistoryIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { CRON_TRIGGER_LABEL, cronRunReport } from '@/lib/cron';
import { reportFailure } from '@/lib/errors';
import { CRON_JOB_KIND_LABEL, formatDateTime, formatDuration } from '@/lib/format';
import { daysAgo, formatNumber } from '@/lib/stats';
import type { CronJob, CronRun } from '@/lib/types';
import { useCronState, useOrgState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { SectionHeading } from '@/components/blocks/section-heading';
import { cappedBadge, StatCards } from '@/components/blocks/stat-cards';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { actionsColumn, emptyCell } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The schedules: standing orders that fire while the server runs.
 *
 * Two tables, no chart. `GET /api/cron` hands out fifty runs across *all*
 * jobs, which is enough for a "Recent runs" list and far too little for a
 * 30- or 90-day curve - a stacked area over that sample would draw a
 * plausible-looking shape out of an arbitrary window, so the second table
 * takes the chart's place (see serverGaps).
 *
 * The German plain text of a cron expression lives only in
 * `CronJobDetail.description`; the overview therefore shows the raw
 * expression as a mono badge and invents nothing.
 */
export function CronPage() {
  const cron = useCronState();
  const org = useOrgState();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();

  // Rows the user just flipped, before the socket has echoed the change back.
  // Keyed by job id so two switches can be in flight at once.
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [report, setReport] = useState<CronRun | null>(null);

  usePageMeta({
    actions: (
      <Button size="sm" asChild>
        <NavLink to="/cron/new">
          <PlusIcon data-icon="inline-start" />
          Create schedule
        </NavLink>
      </Button>
    ),
  });

  // An optimistic value that the server has confirmed is no longer an
  // override, it is just a stale copy of the truth - drop it, or a later
  // change from somewhere else would be masked by it forever.
  useEffect(() => {
    setOptimistic((current) => {
      let changed = false;
      const next = { ...current };
      for (const job of cron.jobs) {
        if (next[job.id] === job.enabled) {
          delete next[job.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cron.jobs]);

  const jobs = useMemo(
    () =>
      cron.jobs.map((job) => {
        const pending = optimistic[job.id];
        return pending === undefined || pending === job.enabled
          ? job
          : { ...job, enabled: pending };
      }),
    [cron.jobs, optimistic],
  );

  const mark = useCallback((id: string, on: boolean) => {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggle = useCallback(
    async (job: CronJob, enabled: boolean): Promise<void> => {
      setOptimistic((current) => ({ ...current, [job.id]: enabled }));
      mark(job.id, true);
      try {
        await api.updateCronJob(job.id, { enabled });
        toast(enabled ? 'Schedule enabled' : 'Schedule paused', { description: job.name });
      } catch (caught) {
        // Roll the row back to whatever the hook still holds.
        setOptimistic((current) => {
          const next = { ...current };
          delete next[job.id];
          return next;
        });
        reportFailure('Update', caught);
      } finally {
        mark(job.id, false);
      }
    },
    [mark],
  );

  const runNow = useCallback(
    async (job: CronJob): Promise<void> => {
      mark(job.id, true);
      try {
        await api.runCronJob(job.id);
        toast('Schedule started', { description: job.name });
      } catch (caught) {
        reportFailure('Start', caught);
      } finally {
        mark(job.id, false);
      }
    },
    [mark],
  );

  const remove = useCallback(
    async (job: CronJob): Promise<void> => {
      const ok = await confirm({
        title: 'Delete schedule?',
        description:
          'The schedule “' +
          job.name +
          '” will no longer run. Existing assignments and conversations will remain.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      try {
        await api.deleteCronJob(job.id);
        toast('Schedule deleted', { description: job.name });
      } catch (caught) {
        reportFailure('Delete', caught);
      }
    },
    [confirm],
  );

  /* ------------------------------ Kennzahlen ----------------------------- */

  // The sleep schedule is the system's own row - counting it as an active
  // standing order would inflate a number nobody created.
  const own = jobs.filter((job) => job.kind !== 'sleep');
  const active = own.filter((job) => job.enabled).length;
  const paused = own.length - active;
  const since = daysAgo(1);
  const failed = cron.runs.filter((run) => run.status === 'failed' && run.startedAt >= since).length;
  // Fifty is the server's ceiling for the shared run list; at exactly fifty
  // there may be more that nobody can reach.
  const runsCapped = cron.runs.length >= 50;

  /* -------------------------------- Spalten ------------------------------- */

  const jobColumn = useMemo(() => createRookeryColumnHelper<CronJob>(), []);

  const jobColumns = useMemo(
    () =>
      jobColumn.columns([
        jobColumn.accessor('enabled', {
          id: 'enabled',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Active" />,
          enableHiding: false,
          cell: ({ row }) => {
            const job = row.original;
            return (
              <Switch
                checked={job.enabled}
                disabled={busy.has(job.id)}
                aria-label={job.enabled ? 'Pause schedule' : 'Enable schedule'}
                onCheckedChange={(checked) => void toggle(job, checked)}
              />
            );
          },
        }),
        jobColumn.accessor('name', {
          id: 'name',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
          enableHiding: false,
          cell: ({ row }) => (
            <div className="flex items-center gap-2">
              <NavLink to={'/cron/' + row.original.id} className="font-medium hover:underline">
                {row.original.name}
              </NavLink>
              {row.original.once ? (
                <Badge variant="outline" className="font-normal">
                  once
                </Badge>
              ) : null}
            </div>
          ),
        }),
        jobColumn.accessor((job) => ownerLabel(job, org.agentById(job.agentId)?.name), {
          id: 'owner',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Run as" />,
          cell: ({ getValue }) => (
            <Badge variant="outline" className="font-normal">
              {getValue() as string}
            </Badge>
          ),
        }),
        jobColumn.accessor('schedule', {
          id: 'schedule',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Expression" />,
          cell: ({ row }) => (
            <Badge variant="secondary" className="font-mono font-normal">
              {row.original.schedule}
            </Badge>
          ),
        }),
        jobColumn.accessor((job) => job.nextRunAt ?? null, {
          id: 'nextRunAt',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Next run" />,
          cell: ({ row }) =>
            row.original.enabled ? (
              <span className="tabular-nums">{formatDateTime(row.original.nextRunAt)}</span>
            ) : (
              <span className="text-muted-foreground">Paused</span>
            ),
        }),
        jobColumn.accessor((job) => statusLabel(job), {
          id: 'lastStatus',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Latest status" />,
          cell: ({ row }) => {
            const job = row.original;
            if (cron.running.has(job.id)) return <StatusBadge kind="cronRun" status="running" />;
            if (!job.lastStatus) return emptyCell();
            const badge = <StatusBadge kind="cronRun" status={job.lastStatus} />;
            // The error text is the only thing that turns "Failed"
            // into something actionable, and it is far too long for a cell.
            if (!job.lastError) return badge;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help">{badge}</span>
                </TooltipTrigger>
                <TooltipContent>{job.lastError}</TooltipContent>
              </Tooltip>
            );
          },
        }),
        jobColumn.accessor('runCount', {
          id: 'runCount',
          header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Runs" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">{formatNumber(row.original.runCount)}</div>
          ),
        }),
        actionsColumn<CronJob>((job) => {
          const running = cron.running.has(job.id);
          const managed = job.kind === 'sleep';
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <RowMenuButton label={'Actions for ' + job.name} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => void navigate('/cron/' + job.id)}>
                  <SquareArrowOutUpRightIcon data-icon="inline-start" />
                  Open
                </DropdownMenuItem>
                <ManagedHint show={managed}>
                  <DropdownMenuItem
                    disabled={managed}
                    onSelect={() => void navigate('/cron/' + job.id + '/edit')}
                  >
                    <PencilIcon data-icon="inline-start" />
                    Edit
                  </DropdownMenuItem>
                </ManagedHint>
                <DropdownMenuItem
                  disabled={running || busy.has(job.id)}
                  onSelect={() => void runNow(job)}
                >
                  {running ? (
                    <Spinner data-icon="inline-start" aria-label="Running" />
                  ) : (
                    <PlayIcon data-icon="inline-start" />
                  )}
                  Run now
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <ManagedHint show={managed}>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={managed}
                    onSelect={() => void remove(job)}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Delete
                  </DropdownMenuItem>
                </ManagedHint>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }),
      ]),
    [busy, cron.running, jobColumn, navigate, org, remove, runNow, toggle],
  );

  const runColumn = useMemo(() => createRookeryColumnHelper<CronRun>(), []);

  const runColumns = useMemo(
    () =>
      runColumn.columns([
        runColumn.accessor((run) => cron.jobById(run.jobId)?.name ?? '', {
          id: 'job',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Schedule" />,
          cell: ({ row, getValue }) => {
            const name = getValue() as string;
            // A run whose job has since been deleted keeps its row rather than
            // disappearing - it happened, and the id is all that is left of it.
            if (!name) return <span className="text-muted-foreground">Deleted schedule</span>;
            return (
              <NavLink to={'/cron/' + row.original.jobId} className="font-medium hover:underline">
                {name}
              </NavLink>
            );
          },
        }),
        runColumn.accessor('status', {
          id: 'status',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
          cell: ({ row }) => <StatusBadge kind="cronRun" status={row.original.status} />,
        }),
        runColumn.accessor('startedAt', {
          id: 'startedAt',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Start" />,
          cell: ({ row }) => (
            <span className="tabular-nums">{formatDateTime(row.original.startedAt)}</span>
          ),
        }),
        runColumn.accessor((run) => CRON_TRIGGER_LABEL[run.trigger], {
          id: 'trigger',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Trigger" />,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{getValue() as string}</span>
          ),
        }),
        runColumn.accessor((run) => run.durationMs ?? null, {
          id: 'duration',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Duration" align="end" />,
          cell: ({ row }) => {
            const text = formatDuration(row.original.durationMs);
            if (!text) return emptyCell('end');
            return <div className="text-right tabular-nums">{text}</div>;
          },
        }),
        actionsColumn<CronRun>(
          (run) => {
            if (!cronRunReport(run)) return emptyCell();
            return <DetailDrawerTrigger onClick={() => setReport(run)}>Report</DetailDrawerTrigger>;
          },
          { header: 'Report' },
        ),
      ]),
    [cron, runColumn],
  );

  const offline = cron.error ? <ServerOffline onRetry={() => void cron.refresh()} /> : undefined;

  return (
    <PageBody>
      {dialog}

      <StatCards
        items={[
          {
            label: 'Active',
            value: formatNumber(active),
            headline: 'Run on schedule',
            footnote: 'The system memory sleep schedule is not included',
          },
          {
            label: 'Paused',
            value: formatNumber(paused),
            headline: 'Disabled but retained',
            footnote: 'A paused schedule will not run again until it is enabled',
          },
          {
            label: 'Running now',
            value: formatNumber(cron.running.size),
            headline: cron.running.size > 0 ? 'Work in progress' : 'No work in progress',
            footnote: 'Runs whose assignments have not returned yet',
          },
          {
            label: 'Failed (24 h)',
            value: formatNumber(failed),
            ...cappedBadge(runsCapped),
            headline: failed > 0 ? 'Needs attention' : 'No incidents',
            footnote: 'Based on the latest 50 runs across all schedules',
          },
        ]}
      />

      <DataTable
        data={jobs}
        columns={jobColumns}
        getRowId={(job) => job.id}
        idPrefix="zeitplaene"
        tabLabel="Schedules"
        tabs={[
          { value: 'alle', label: 'All', count: jobs.length },
          { value: 'aktiv', label: 'Active', count: jobs.filter((job) => job.enabled).length },
          { value: 'pausiert', label: 'Paused', count: jobs.filter((job) => !job.enabled).length },
          { value: 'einmalig', label: 'One-time', count: jobs.filter((job) => job.once).length },
        ]}
        searchable
        searchPlaceholder="Search schedules"
        columnLabels={JOB_COLUMN_LABELS}
        rowLabel={{ singular: 'Schedule', plural: 'schedules' }}
        rowClickIgnoreColumns={['enabled', 'actions']}
        onRowClick={(job) => void navigate('/cron/' + job.id)}
        loading={cron.loading}
        error={offline}
        empty={
          <EmptyState
            icon={CalendarClockIcon}
            title="No schedules yet"
            description="A schedule handles something automatically, such as a morning briefing at 8:00 AM or a reminder for tomorrow afternoon. You can also create one in chat: “Every morning at 8…”"
            actionLabel="Create schedule"
            actionTo="/cron/new"
            variant="plain"
            size="sm"
          />
        }
        filteredEmpty={<NoResults />}
      />

      <SectionHeading title="Recent runs" hint="The latest 50 runs across all schedules.">
        <DataTable
          data={cron.runs}
          columns={runColumns}
          getRowId={(run) => run.id}
          idPrefix="laeufe"
          initialSorting={[{ id: 'startedAt', desc: true }]}
          pageSize={10}
          capped={runsCapped}
          rowLabel={{ singular: 'Run', plural: 'runs' }}
          columnLabels={RUN_COLUMN_LABELS}
          loading={cron.loading}
          error={offline}
          empty={
            <EmptyState
              icon={HistoryIcon}
              title="No runs yet"
              description="When a schedule runs, its run and report appear here."
              actionLabel="Create schedule"
              actionTo="/cron/new"
              variant="plain"
              size="sm"
            />
          }
        />
      </SectionHeading>

      {/*
        One drawer for the whole table instead of one per row: fifty mounted
        vaul instances would each bring their own portal and focus trap.
      */}
      <DetailDrawer
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
        title={report ? (cron.jobById(report.jobId)?.name ?? 'Run') : 'Run'}
        description={
          report
            ? formatDateTime(report.startedAt) + ' · ' + CRON_TRIGGER_LABEL[report.trigger]
            : undefined
        }
      >
        {report ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="cronRun" status={report.status} />
              {report.durationMs !== undefined ? (
                <span className="text-muted-foreground">{formatDuration(report.durationMs)}</span>
              ) : null}
            </div>
            <pre
              className={
                'max-h-none whitespace-pre-wrap break-words font-mono text-xs ' +
                (report.error ? 'text-destructive' : '')
              }
            >
              {cronRunReport(report)}
            </pre>
          </>
        ) : null}
      </DetailDrawer>
    </PageBody>
  );
}

/** German column names for the visibility menu. */
const JOB_COLUMN_LABELS: Record<string, string> = {
  enabled: 'Active',
  name: 'Name',
  owner: 'Run as',
  schedule: 'Expression',
  nextRunAt: 'Next run',
  lastStatus: 'Latest status',
  runCount: 'Runs',
};

const RUN_COLUMN_LABELS: Record<string, string> = {
  job: 'Schedule',
  status: 'Status',
  startedAt: 'Start',
  trigger: 'Trigger',
  duration: 'Duration',
};

/**
 * Who fires a schedule, as text: the agent's own name where there is one, the
 * kind's label otherwise. `sleep` reads "System" rather than leaving the
 * column blank - nobody wrote that row and nobody may delete it.
 */
function ownerLabel(job: CronJob, agentName: string | undefined): string {
  if (job.kind === 'agent') return agentName ?? CRON_JOB_KIND_LABEL.agent;
  return CRON_JOB_KIND_LABEL[job.kind];
}

/** Sortable text behind the status badge; empty for a job that never ran. */
function statusLabel(job: CronJob): string {
  return job.lastStatus ?? '';
}

/**
 * Says why an action is off.
 *
 * A disabled `DropdownMenuItem` carries `pointer-events: none`, so the
 * tooltip has to hang on a wrapper around it, not on the item itself.
 */
function ManagedHint({ show, children }: { show: boolean; children: ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div>{children}</div>
      </TooltipTrigger>
      <TooltipContent side="left">
        <ClockAlertIcon className="size-3.5" aria-hidden="true" />
        Managed by the Memory setting
      </TooltipContent>
    </Tooltip>
  );
}
