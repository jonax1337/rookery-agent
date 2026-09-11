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
 * jobs, which is enough for a "Letzte Läufe" list and far too little for a
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
          Zeitplan anlegen
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
        toast(enabled ? 'Zeitplan aktiviert' : 'Zeitplan pausiert', { description: job.name });
      } catch (caught) {
        // Roll the row back to whatever the hook still holds.
        setOptimistic((current) => {
          const next = { ...current };
          delete next[job.id];
          return next;
        });
        reportFailure('Ändern', caught);
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
        toast('Zeitplan gestartet', { description: job.name });
      } catch (caught) {
        reportFailure('Starten', caught);
      } finally {
        mark(job.id, false);
      }
    },
    [mark],
  );

  const remove = useCallback(
    async (job: CronJob): Promise<void> => {
      const ok = await confirm({
        title: 'Zeitplan löschen?',
        description:
          'Der Zeitplan „' +
          job.name +
          '“ feuert danach nicht mehr. Bereits gelaufene Aufträge und Gespräche bleiben erhalten.',
        confirmLabel: 'Löschen',
        destructive: true,
      });
      if (!ok) return;
      try {
        await api.deleteCronJob(job.id);
        toast('Zeitplan gelöscht', { description: job.name });
      } catch (caught) {
        reportFailure('Löschen', caught);
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
          header: ({ column }) => <DataTableColumnHeader column={column} title="Aktiv" />,
          enableHiding: false,
          cell: ({ row }) => {
            const job = row.original;
            return (
              <Switch
                checked={job.enabled}
                disabled={busy.has(job.id)}
                aria-label={job.enabled ? 'Zeitplan pausieren' : 'Zeitplan aktivieren'}
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
                  einmalig
                </Badge>
              ) : null}
            </div>
          ),
        }),
        jobColumn.accessor((job) => ownerLabel(job, org.agentById(job.agentId)?.name), {
          id: 'owner',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Wer führt aus" />,
          cell: ({ getValue }) => (
            <Badge variant="outline" className="font-normal">
              {getValue() as string}
            </Badge>
          ),
        }),
        jobColumn.accessor('schedule', {
          id: 'schedule',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Ausdruck" />,
          cell: ({ row }) => (
            <Badge variant="secondary" className="font-mono font-normal">
              {row.original.schedule}
            </Badge>
          ),
        }),
        jobColumn.accessor((job) => job.nextRunAt ?? null, {
          id: 'nextRunAt',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Nächster Lauf" />,
          cell: ({ row }) =>
            row.original.enabled ? (
              <span className="tabular-nums">{formatDateTime(row.original.nextRunAt)}</span>
            ) : (
              <span className="text-muted-foreground">Pausiert</span>
            ),
        }),
        jobColumn.accessor((job) => statusLabel(job), {
          id: 'lastStatus',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Letzter Status" />,
          cell: ({ row }) => {
            const job = row.original;
            if (cron.running.has(job.id)) return <StatusBadge kind="cronRun" status="running" />;
            if (!job.lastStatus) return emptyCell();
            const badge = <StatusBadge kind="cronRun" status={job.lastStatus} />;
            // The error text is the only thing that turns "Fehlgeschlagen"
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
            <DataTableColumnHeader column={column} title="Läufe" align="end" />
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
                <RowMenuButton label={'Aktionen für ' + job.name} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onSelect={() => void navigate('/cron/' + job.id)}>
                  <SquareArrowOutUpRightIcon data-icon="inline-start" />
                  Öffnen
                </DropdownMenuItem>
                <ManagedHint show={managed}>
                  <DropdownMenuItem
                    disabled={managed}
                    onSelect={() => void navigate('/cron/' + job.id + '/edit')}
                  >
                    <PencilIcon data-icon="inline-start" />
                    Bearbeiten
                  </DropdownMenuItem>
                </ManagedHint>
                <DropdownMenuItem
                  disabled={running || busy.has(job.id)}
                  onSelect={() => void runNow(job)}
                >
                  {running ? (
                    <Spinner data-icon="inline-start" aria-label="Läuft" />
                  ) : (
                    <PlayIcon data-icon="inline-start" />
                  )}
                  Jetzt ausführen
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <ManagedHint show={managed}>
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={managed}
                    onSelect={() => void remove(job)}
                  >
                    <Trash2Icon data-icon="inline-start" />
                    Löschen
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
          header: ({ column }) => <DataTableColumnHeader column={column} title="Zeitplan" />,
          cell: ({ row, getValue }) => {
            const name = getValue() as string;
            // A run whose job has since been deleted keeps its row rather than
            // disappearing - it happened, and the id is all that is left of it.
            if (!name) return <span className="text-muted-foreground">Gelöschter Zeitplan</span>;
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
          header: ({ column }) => <DataTableColumnHeader column={column} title="Auslöser" />,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{getValue() as string}</span>
          ),
        }),
        runColumn.accessor((run) => run.durationMs ?? null, {
          id: 'duration',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Dauer" align="end" />,
          cell: ({ row }) => {
            const text = formatDuration(row.original.durationMs);
            if (!text) return emptyCell('end');
            return <div className="text-right tabular-nums">{text}</div>;
          },
        }),
        actionsColumn<CronRun>(
          (run) => {
            if (!cronRunReport(run)) return emptyCell();
            return <DetailDrawerTrigger onClick={() => setReport(run)}>Bericht</DetailDrawerTrigger>;
          },
          { header: 'Bericht' },
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
            label: 'Aktiv',
            value: formatNumber(active),
            headline: 'Feuern nach Plan',
            footnote: 'Der Schlaf-Zeitplan des Systems ist nicht mitgezählt',
          },
          {
            label: 'Pausiert',
            value: formatNumber(paused),
            headline: 'Abgeschaltet, aber erhalten',
            footnote: 'Ein pausierter Zeitplan feuert erst wieder nach dem Einschalten',
          },
          {
            label: 'Läuft gerade',
            value: formatNumber(cron.running.size),
            headline: cron.running.size > 0 ? 'Gerade in Arbeit' : 'Nichts in Arbeit',
            footnote: 'Läufe, deren Auftrag noch nicht zurück ist',
          },
          {
            label: 'Fehlgeschlagen (24 h)',
            value: formatNumber(failed),
            ...cappedBadge(runsCapped),
            headline: failed > 0 ? 'Einen Blick wert' : 'Ohne Zwischenfall',
            footnote: 'Basis: die letzten 50 Läufe über alle Zeitpläne',
          },
        ]}
      />

      <DataTable
        data={jobs}
        columns={jobColumns}
        getRowId={(job) => job.id}
        idPrefix="zeitplaene"
        tabLabel="Zeitpläne"
        tabs={[
          { value: 'alle', label: 'Alle', count: jobs.length },
          { value: 'aktiv', label: 'Aktiv', count: jobs.filter((job) => job.enabled).length },
          { value: 'pausiert', label: 'Pausiert', count: jobs.filter((job) => !job.enabled).length },
          { value: 'einmalig', label: 'Einmalig', count: jobs.filter((job) => job.once).length },
        ]}
        searchable
        searchPlaceholder="Zeitpläne durchsuchen"
        columnLabels={JOB_COLUMN_LABELS}
        rowLabel={{ singular: 'Zeitplan', plural: 'Zeitplänen' }}
        rowClickIgnoreColumns={['enabled', 'actions']}
        onRowClick={(job) => void navigate('/cron/' + job.id)}
        loading={cron.loading}
        error={offline}
        empty={
          <EmptyState
            icon={CalendarClockIcon}
            title="Noch kein Zeitplan"
            description="Ein Zeitplan erledigt etwas von selbst — ein Morgenbriefing um 08:00 oder eine Erinnerung für morgen Nachmittag. Auch im Chat anlegbar: „Jeden Morgen um 8 …“."
            actionLabel="Zeitplan anlegen"
            actionTo="/cron/new"
            variant="plain"
            size="sm"
          />
        }
        filteredEmpty={<NoResults />}
      />

      <SectionHeading title="Letzte Läufe" hint="Die letzten 50 Läufe über alle Zeitpläne.">
        <DataTable
          data={cron.runs}
          columns={runColumns}
          getRowId={(run) => run.id}
          idPrefix="laeufe"
          initialSorting={[{ id: 'startedAt', desc: true }]}
          pageSize={10}
          capped={runsCapped}
          rowLabel={{ singular: 'Lauf', plural: 'Läufen' }}
          columnLabels={RUN_COLUMN_LABELS}
          loading={cron.loading}
          error={offline}
          empty={
            <EmptyState
              icon={HistoryIcon}
              title="Noch kein Lauf"
              description="Sobald ein Zeitplan feuert, steht sein Lauf hier — mit Bericht."
              actionLabel="Zeitplan anlegen"
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
        title={report ? (cron.jobById(report.jobId)?.name ?? 'Lauf') : 'Lauf'}
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
  enabled: 'Aktiv',
  name: 'Name',
  owner: 'Wer führt aus',
  schedule: 'Ausdruck',
  nextRunAt: 'Nächster Lauf',
  lastStatus: 'Letzter Status',
  runCount: 'Läufe',
};

const RUN_COLUMN_LABELS: Record<string, string> = {
  job: 'Zeitplan',
  status: 'Status',
  startedAt: 'Start',
  trigger: 'Auslöser',
  duration: 'Dauer',
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
        Wird von der Gedächtnis-Einstellung verwaltet
      </TooltipContent>
    </Tooltip>
  );
}
