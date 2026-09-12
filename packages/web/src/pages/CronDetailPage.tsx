import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import {
  Building2Icon,
  CalendarClockIcon,
  HistoryIcon,
  KeyRoundIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlayIcon,
  ShieldIcon,
  Trash2Icon,
  UserRoundIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { CRON_RUN_STATUS_LABEL, CRON_TRIGGER_LABEL, cronRunReport } from '@/lib/cron';
import {
  CRON_JOB_KIND_LABEL,
  PERMISSION_LABEL,
  REQUESTER_LABEL,
  formatDateTime,
  formatDuration,
  timeAgo,
} from '@/lib/format';
import { average, formatNumber } from '@/lib/stats';
import type { CronJobDetail, CronRun } from '@/lib/types';
import { useCronState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards } from '@/components/blocks/stat-cards';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  EMPTY_CELL,
  actionsColumn,
  emptyCell,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { useRecord } from '@/hooks/useRecord';
import { reportFailure } from '@/lib/errors';
import { ResultMarkdown } from '@/components/result-markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';

/**
 * One schedule: what it does, when it fires next, and every run so far.
 *
 * This is the only place that knows the German plain text of the cron
 * expression - `GET /api/cron/:id` computes it as `description`, the
 * overview's payload does not carry it - so the sentence sits under "Nächste
 * Läufe" where the dates it describes are.
 *
 * The detail is fetched once and refetched whenever the socket reports a
 * change to this job, so a run's report appears as soon as it is in.
 */
export function CronDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const cron = useCronState();
  const { confirm, dialog } = useConfirm();

  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CronRun | null>(null);

  const { record: detail, missing, error, reload } = useRecord<CronJobDetail>(id, api.cronJob);

  // The hook's copy of this job changes identity on every broadcast about it,
  // which is exactly the moment the detail payload went stale.
  const live = cron.jobById(id);
  const running = id ? cron.running.has(id) : false;
  useEffect(() => {
    void reload();
  }, [live, running, reload]);

  const job = detail?.job;

  const runNow = useCallback(async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await api.runCronJob(id);
      toast('Zeitplan gestartet');
    } catch (caught) {
      reportFailure('Start', caught);
    } finally {
      setBusy(false);
    }
  }, [id]);

  const toggle = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!id) return;
      setBusy(true);
      try {
        await api.updateCronJob(id, { enabled });
        toast(enabled ? 'Zeitplan aktiviert' : 'Zeitplan pausiert');
      } catch (caught) {
        reportFailure('Änderung', caught);
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const remove = useCallback(async (): Promise<void> => {
    if (!id || !job) return;
    const ok = await confirm({
      title: 'Zeitplan löschen?',
      description:
        'Der Zeitplan „' + job.name + '“ feuert danach nicht mehr. Bereits gelaufene Aufträge und Gespräche bleiben erhalten.',
      confirmLabel: 'Löschen',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteCronJob(id);
      toast('Zeitplan gelöscht', { description: job.name });
      void navigate('/cron');
    } catch (caught) {
      reportFailure('Löschen', caught);
    }
  }, [confirm, id, job, navigate]);

  // `sleep` is the system's own schedule: `ensureSleepSchedule` recreates it
  // and the memory settings own its timetable, so editing and deleting are off.
  const managed = job?.kind === 'sleep';

  usePageMeta(
    {
      ...(job ? { title: job.name } : {}),
      actions: job ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="zeitplan-aktiv" className="flex h-8 items-center gap-2 rounded-md border px-2 font-normal">
            <Switch
              id="zeitplan-aktiv"
              checked={job.enabled}
              disabled={busy}
              onCheckedChange={(checked) => void toggle(checked)}
            />
            Aktiv
          </Label>
          <Button size="sm" disabled={running || busy} onClick={() => void runNow()}>
            {running ? (
              <Spinner aria-label="Läuft" data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Jetzt ausführen
          </Button>
          <Button size="sm" variant="outline" disabled={managed} asChild={!managed}>
            {managed ? (
              <>
                  <PencilIcon data-icon="inline-start" />
                  Bearbeiten
              </>
            ) : (
              <NavLink to={'/cron/' + job.id + '/edit'}>
                  <PencilIcon data-icon="inline-start" />
                  Bearbeiten
              </NavLink>
            )}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="Weitere Aktionen" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                variant="destructive"
                disabled={managed}
                onSelect={() => void remove()}
              >
                <Trash2Icon data-icon="inline-start" />
                Löschen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : undefined,
    },
    [busy, job, managed, running, remove, runNow, toggle],
  );

  /* -------------------------------- Spalten ------------------------------- */

  const column = useMemo(() => createRookeryColumnHelper<CronRun>(), []);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('status', {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
          cell: ({ row }) => <StatusBadge kind="cronRun" status={row.original.status} />,
        }),
        column.accessor('startedAt', {
          id: 'startedAt',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Start" />,
          cell: ({ row }) => (
            <span className="tabular-nums">{formatDateTime(row.original.startedAt)}</span>
          ),
        }),
        column.accessor((run) => CRON_TRIGGER_LABEL[run.trigger], {
          id: 'trigger',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Auslöser" />,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{getValue() as string}</span>
          ),
        }),
        column.accessor((run) => run.durationMs ?? null, {
          id: 'duration',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Dauer" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">
              {formatDuration(row.original.durationMs) || EMPTY_CELL}
            </div>
          ),
        }),
        column.display({
          id: 'assignment',
          header: () => <span className="text-sm font-medium">Auftrag</span>,
          cell: ({ row }) =>
            row.original.assignmentId ? (
              <NavLink
                to={'/assignments/' + row.original.assignmentId}
                className="hover:underline"
              >
                Auftrag
              </NavLink>
            ) : (
              emptyCell()
            ),
        }),
        column.display({
          id: 'session',
          header: () => <span className="text-sm font-medium">Gespräch</span>,
          cell: ({ row }) =>
            row.original.sessionId ? (
              <NavLink to={'/c/' + row.original.sessionId} className="hover:underline">
                Gespräch
              </NavLink>
            ) : (
              emptyCell()
            ),
        }),
        actionsColumn<CronRun>(
          (run) =>
            cronRunReport(run) ? (
              <DetailDrawerTrigger onClick={() => setReport(run)}>Bericht</DetailDrawerTrigger>
            ) : (
              emptyCell()
            ),
          { header: 'Bericht' },
        ),
      ]),
    [column],
  );

  /* -------------------------------- Zustände ------------------------------ */

  if (missing) {
    return (
      <PageBody width="3xl">
        <EmptyState
          icon={CalendarClockIcon}
          title="Zeitplan nicht gefunden"
          description="Dieser Zeitplan wurde gelöscht oder hat nie existiert."
          actionLabel="Zu den Zeitplänen"
          actionTo="/cron"
        />
      </PageBody>
    );
  }

  if (error && !detail) {
    return (
      <PageBody width="3xl">
        <ServerOffline onRetry={() => void reload()} />
      </PageBody>
    );
  }

  if (!detail || !job) {
    return (
      <PageBody>
        <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-32 w-full rounded-xl" />
          ))}
        </div>
        <div className="px-4 lg:px-6">
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </PageBody>
    );
  }

  const { runs, agent, project, session, next, description } = detail;

  const durations = runs
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const meanDuration = durations.length ? formatDuration(Math.round(average(durations))) : '';

  const upcoming = job.enabled ? next : [];

  return (
    <PageBody>
      {dialog}

      <StatCards
        items={[
          {
            label: 'Läufe',
            value: formatNumber(job.runCount),
            badge: job.once ? <Badge variant="outline">einmalig</Badge> : undefined,
            headline: job.lastRunAt ? 'Zuletzt ' + timeAgo(job.lastRunAt) : 'Noch nicht gelaufen',
            footnote: 'Angelegt am ' + formatDateTime(job.createdAt),
          },
          {
            label: 'Letzter Status',
            value: running
              ? CRON_RUN_STATUS_LABEL.running
              : job.lastStatus
                ? CRON_RUN_STATUS_LABEL[job.lastStatus]
                : '–',
            headline: job.lastRunAt ? timeAgo(job.lastRunAt) : 'Ohne Lauf',
            footnote: job.lastError ? job.lastError : undefined,
          },
          {
            label: 'Nächster Lauf',
            value: job.enabled ? formatDateTime(job.nextRunAt) : 'Abgeschaltet',
            headline: job.enabled ? description : 'Pausiert',
            footnote: job.schedule,
          },
          {
            label: 'Mittlere Dauer',
            value: meanDuration || '–',
            headline: meanDuration ? 'Wie lange ein Lauf braucht' : 'Noch nichts gemessen',
            footnote: durations.length
              ? 'Über ' + formatNumber(durations.length) + (durations.length === 1 ? ' Lauf' : ' Läufe')
              : 'Sobald ein Lauf fertig ist, steht hier ein Mittel',
          },
        ]}
      />

      <div className="grid gap-4 px-4 md:gap-6 lg:px-6 @4xl/main:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Anweisung</CardTitle>
            <CardDescription>
              {managed
                ? 'Diesen Zeitplan legt das System selbst an; seine Anweisung steht in der Gedächtnis-Einstellung.'
                : 'Was zur festgelegten Zeit ausgeführt wird.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {job.prompt ? (
              <ResultMarkdown text={job.prompt} />
            ) : (
              <EmptyState
                icon={PencilIcon}
                title="Keine eigene Anweisung hinterlegt"
                description="Ohne Text führt dieser Zeitplan nichts Eigenes aus."
                variant="plain"
                size="sm"
                {...(managed
                  ? {}
                  : { actionLabel: 'Bearbeiten', actionTo: '/cron/' + job.id + '/edit' })}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Nächste Läufe</CardTitle>
            {/* The only German plain text of the expression there is - it
                comes from the server, it is not derived here. */}
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {job.enabled
                  ? 'Für diesen Ausdruck steht kein weiterer Termin an.'
                  : 'Pausiert — es ist kein Termin geplant.'}
              </p>
            ) : (
              <ItemGroup className="gap-2">
                {upcoming.map((at) => (
                  <Item key={at} variant="muted" size="sm">
                    <ItemMedia variant="icon">
                      <CalendarClockIcon className="text-muted-foreground" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle className="font-normal tabular-nums">
                        {formatDateTime(at)}
                      </ItemTitle>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        <MetaList
          columns={3}
          items={[
            {
              label: 'Wer führt aus',
              value: agent ? agent.name + ' · ' + agent.title : CRON_JOB_KIND_LABEL[job.kind],
              icon: UserRoundIcon,
              ...(agent ? { to: '/org/agents/' + agent.id } : {}),
            },
            { label: 'Projekt', value: project?.name ?? '', icon: Building2Icon },
            {
              label: 'Gespräch',
              value: session?.title ?? '',
              icon: MessagesSquareIcon,
              ...(session ? { to: '/c/' + session.id } : {}),
            },
            {
              label: 'Zugriff',
              value: job.permission ? PERMISSION_LABEL[job.permission] : '',
              icon: ShieldIcon,
            },
            {
              label: 'Angelegt von',
              value: REQUESTER_LABEL[job.createdBy],
              icon: KeyRoundIcon,
            },
          ]}
        />
      </div>

      <DataTable
        data={runs}
        columns={columns}
        getRowId={(run) => run.id}
        idPrefix="laeufe"
        initialSorting={[{ id: 'startedAt', desc: true }]}
        pageSize={10}
        rowLabel={{ singular: 'Lauf', plural: 'Läufen' }}
        columnLabels={RUN_COLUMN_LABELS}
        // Fifty is the server's ceiling for one job's run list.
        capped={runs.length >= 50}
        empty={
          <EmptyState
            icon={HistoryIcon}
            title="Noch nicht gelaufen"
            description="Sobald dieser Zeitplan feuert — nach Plan oder von Hand — steht sein Lauf mit Bericht hier."
            actionLabel="Jetzt ausführen"
            onAction={() => void runNow()}
            variant="plain"
            size="sm"
          />
        }
      />

      {/* One drawer for the table, not one per row: a mounted vaul instance
          per run would bring fifty portals and focus traps along. */}
      <DetailDrawer
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
        title={job.name}
        description={
          report
            ? formatDateTime(report.startedAt) + ' · ' + CRON_TRIGGER_LABEL[report.trigger]
            : undefined
        }
        footer={
          report?.assignmentId ? (
            <Button variant="outline" asChild>
              <NavLink to={'/assignments/' + report.assignmentId}>Auftrag öffnen</NavLink>
            </Button>
          ) : undefined
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
                'whitespace-pre-wrap break-words font-mono text-xs ' +
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

const RUN_COLUMN_LABELS: Record<string, string> = {
  status: 'Status',
  startedAt: 'Start',
  trigger: 'Auslöser',
  duration: 'Dauer',
  assignment: 'Auftrag',
  session: 'Gespräch',
};
