import { useCallback, useMemo, useState } from 'react';
import { MoonIcon, RotateCcwIcon, SunIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';

import { reportFailure } from '@/lib/errors';

import { CRON_TRIGGER_LABEL } from '@/lib/cron';
import { SLEEP_PHASE_DETAIL, SLEEP_PHASE_LABEL, formatDuration } from '@/lib/format';
import { bucketByDay, daysAgo, formatDateTime, formatNumber } from '@/lib/stats';
import type { SleepRun } from '@/lib/types';
import { SLEEP_RUN_LIMIT } from '@/hooks/useMemories';
import { useMemoryState } from '@/providers/rookery-provider';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { EMPTY_CELL, actionsColumn } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { SectionHeading } from '@/components/blocks/section-heading';
import { cappedBadge } from '@/components/blocks/stat-cards';
import { TrendChartCard, type TrendPoint, type TrendSeries } from '@/components/blocks/trend-chart-card';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';

/**
 * What the nights have done, and what the next one will do.
 *
 * This is the only page in the whole rebuild whose curve rests on a real
 * server time series: `GET /api/sleep/runs` hands out up to two hundred runs,
 * each one carrying its own ten counters, which is enough to draw ninety days
 * honestly. Everywhere else a chart would have to be summed over a capped
 * list, and those pages got tables instead.
 *
 * The undo button is not a nicety. A process that rewrites memory unattended
 * is only acceptable because every night it wrote can be taken back, so the
 * action sits in the row rather than three clicks away - behind a
 * confirmation, because taking a night back is itself a rewrite.
 */

/** The four things a night produces, stacked in the order it produces them. */
const NIGHT_SERIES: TrendSeries[] = [
  { key: 'verdichtet', label: 'verdichtet', color: 'var(--chart-1)' },
  { key: 'verknuepft', label: 'verknüpft', color: 'var(--chart-2)' },
  { key: 'eingeschlaefert', label: 'eingeschläfert', color: 'var(--chart-3)' },
  { key: 'einsichten', label: 'Einsichten', color: 'var(--chart-4)' },
];

/** The widest window the range switch offers. */
const CHART_DAYS = 90;

interface NightPoint extends TrendPoint {
  verdichtet: number;
  verknuepft: number;
  eingeschlaefert: number;
  einsichten: number;
}

const COLUMN_LABELS: Record<string, string> = {
  startedAt: 'Nacht',
  trigger: 'Auslöser',
  duration: 'Dauer',
  readCount: 'gelesen',
  mergedCount: 'verdichtet',
  edgeCount: 'verknüpft',
  dormantCount: 'eingeschläfert',
  insightCount: 'Einsichten',
  modelCalls: 'Modellaufrufe',
  status: 'Status',
};

const column = createRookeryColumnHelper<SleepRun>();

/** A night is undoable only while it actually changed something. */
function undoable(run: SleepRun): boolean {
  if (run.undoneAt) return false;
  if (run.status !== 'done') return false;
  return run.mergedCount > 0 || run.dormantCount > 0 || run.edgeCount > 0 || run.insightCount > 0;
}

/** What a night has to say for itself: its error, else its report. */
function reportText(run: SleepRun): string {
  return run.error ?? run.report ?? '';
}

export function MemorySleepPage() {
  const { sleep } = useMemoryState();
  const { confirm, dialog } = useConfirm();

  const [report, setReport] = useState<SleepRun | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);

  const runs = sleep.runs;
  const status = sleep.status;
  const running = status?.running ?? false;

  // The history request stops at two hundred nights - roughly half a year of
  // nightly runs, so the cap normally never bites. When it does, curve and
  // table both rest on a cut-off list and have to say so, the way every
  // other capped surface in the app does.
  const runsCapped = runs.length >= SLEEP_RUN_LIMIT;

  /* --------------------------------- Kurve -------------------------------- */

  // Four passes over the same runs rather than one hand-rolled loop: the
  // shared bucketing already fills the empty days and steps the calendar the
  // way a DST change needs, and four passes over two hundred rows is nothing.
  const nights = useMemo<NightPoint[]>(() => {
    // No runs at all is not "ninety days of zero": the card should say that
    // nothing has run rather than draw a flat line along the floor.
    if (runs.length === 0) return [];
    const since = daysAgo(CHART_DAYS - 1);
    const at = (pick: (run: SleepRun) => number) =>
      bucketByDay(runs, (run) => run.startedAt, { since, weight: pick });

    const merged = at((run) => run.mergedCount);
    const edges = at((run) => run.edgeCount);
    const dormant = at((run) => run.dormantCount);
    const insights = at((run) => run.insightCount);

    return merged.map((day, index) => ({
      day: day.day,
      at: day.at,
      verdichtet: day.count,
      verknuepft: edges[index]?.count ?? 0,
      eingeschlaefert: dormant[index]?.count ?? 0,
      einsichten: insights[index]?.count ?? 0,
    }));
  }, [runs]);

  /* -------------------------------- Aktionen ------------------------------ */

  const start = useCallback(async (): Promise<void> => {
    const ok = await sleep.start();
    if (ok) toast('Die Nacht läuft');
    else toast.error('Die Nacht konnte nicht gestartet werden');
  }, [sleep]);

  const undo = useCallback(
    async (run: SleepRun): Promise<void> => {
      const ok = await confirm({
        title: 'Nacht zurücknehmen?',
        description:
          'Verdichtete Erinnerungen werden geweckt, im Schlaf gezogene Verbindungen und Einsichten verschwinden wieder. Der Stand von vor dieser Nacht ist danach zurück.',
        confirmLabel: 'Zurücknehmen',
        destructive: true,
      });
      if (!ok) return;
      setUndoing(run.id);
      try {
        const result = await sleep.undo(run.id);
        toast('Nacht zurückgenommen', {
          description:
            formatNumber(result.woken) +
            ' geweckt · ' +
            formatNumber(result.removed) +
            ' entfernt · ' +
            formatNumber(result.edges) +
            ' Verbindungen gelöst',
        });
      } catch (caught) {
        reportFailure('Zurücknehmen', caught);
      } finally {
        setUndoing(null);
      }
    },
    [confirm, sleep],
  );

  /* -------------------------------- Spalten ------------------------------- */

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('startedAt', {
          id: 'startedAt',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Nacht" />,
          enableHiding: false,
          cell: ({ row }) => (
            <div className="flex flex-col">
              <span className="whitespace-nowrap tabular-nums">
                {formatDateTime(row.original.startedAt)}
              </span>
              {row.original.undoneAt ? (
                <span className="text-xs text-muted-foreground">
                  zurückgenommen {formatDateTime(row.original.undoneAt)}
                </span>
              ) : null}
            </div>
          ),
        }),
        column.accessor((run) => CRON_TRIGGER_LABEL[run.trigger], {
          id: 'trigger',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Auslöser" />,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{getValue() as string}</span>
          ),
        }),
        column.accessor((run) => run.durationMs ?? 0, {
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
        countColumn('readCount', 'gelesen'),
        countColumn('mergedCount', 'verdichtet'),
        countColumn('edgeCount', 'verknüpft'),
        countColumn('dormantCount', 'eingeschläfert'),
        countColumn('insightCount', 'Einsichten'),
        countColumn('modelCalls', 'Modellaufrufe'),
        column.accessor('status', {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
          cell: ({ row }) => {
            const run = row.original;
            const open = run.conflictCount - run.resolvedCount;
            return (
              <div className="flex flex-wrap items-center gap-1">
                <StatusBadge kind="sleepRun" status={run.status} />
                {run.undoneAt ? <Badge variant="outline">zurückgenommen</Badge> : null}
                {open > 0 ? (
                  <Badge variant="destructive" className="gap-1">
                    <TriangleAlertIcon aria-hidden="true" />
                    {open === 1 ? '1 Widerspruch offen' : formatNumber(open) + ' Widersprüche offen'}
                  </Badge>
                ) : null}
              </div>
            );
          },
        }),
        actionsColumn<SleepRun>((run) => (
          <div className="flex items-center justify-end gap-1">
            {reportText(run) ? (
              <DetailDrawerTrigger onClick={() => setReport(run)}>Bericht</DetailDrawerTrigger>
            ) : null}
            {undoable(run) ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={undoing === run.id}
                onClick={() => void undo(run)}
              >
                {undoing === run.id ? (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <RotateCcwIcon data-icon="inline-start" />
                )}
                Rückgängig
              </Button>
            ) : null}
          </div>
        )),
      ]),
    [undo, undoing],
  );

  /* -------------------------------- Zeitplan ------------------------------ */

  const schedule = status?.schedule ?? null;
  const config = status?.config ?? null;

  const nextRun = schedule?.enabled && schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : null;

  return (
    <>
      {dialog}

      <div className="px-4 lg:px-6">
        <TrendChartCard
          title="Was die Nächte gebracht haben"
          description={
            'Verdichtet, verknüpft, eingeschläfert und geschlossen — pro Nacht, wie der Server sie protokolliert hat.' +
            (runs.length > 0
              ? ' Basis: die letzten ' +
                formatNumber(runs.length) +
                (runs.length === 1 ? ' protokollierte Nacht.' : ' protokollierten Nächte.')
              : '')
          }
          descriptionShort="Pro Nacht"
          data={nights}
          series={NIGHT_SERIES}
          {...cappedBadge(runsCapped)}
          empty={
            <EmptyState
              icon={MoonIcon}
              title="In diesem Zeitraum lief keine Nacht"
              description="Ein größerer Zeitraum zeigt womöglich mehr."
              variant="plain"
              size="sm"
            />
          }
        />
      </div>

      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <MoonIcon
                className={running ? 'animate-pulse text-primary' : 'text-muted-foreground'}
                aria-hidden="true"
              />
              Schlaf
              {running ? (
                <>
                  <Badge variant="secondary">{SLEEP_PHASE_LABEL[sleep.phase] ?? 'arbeitet'}</Badge>
                  {sleep.cycle > 0 ? (
                    <span className="text-sm font-normal text-muted-foreground tabular-nums">
                      Zyklus {formatNumber(sleep.cycle)}
                    </span>
                  ) : null}
                  <Spinner aria-label="Läuft" />
                </>
              ) : null}
            </CardTitle>
            <CardDescription>
              {running
                ? (SLEEP_PHASE_DETAIL[sleep.phase] ?? 'Das Gedächtnis wird gerade umgeräumt.')
                : 'Leichtschlaf räumt auf, Tiefschlaf verdichtet und entscheidet Widersprüche, Traumschlaf verknüpft und zieht Schlüsse. Gelöscht wird dabei nichts.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <Button variant="outline" onClick={() => void sleep.cancel()}>
                  <SunIcon data-icon="inline-start" />
                  Aufwecken
                </Button>
              ) : (
                <Button disabled={sleep.busy} onClick={() => void start()}>
                  {sleep.busy ? (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  ) : (
                    <MoonIcon data-icon="inline-start" />
                  )}
                  Jetzt schlafen
                </Button>
              )}
              <span className="text-sm text-muted-foreground">
                {nextRun
                  ? 'Nächster Lauf ' + nextRun
                  : config?.enabled === false
                    ? 'Der nächtliche Lauf ist abgeschaltet.'
                    : 'Kein Zeitplan hinterlegt.'}
              </span>
            </div>

            {config ? (
              <MetaList
                columns={3}
                items={[
                  { label: 'Zeitplan', value: config.schedule, mono: true },
                  {
                    label: 'Umfang',
                    value: config.scope === 'all' ? 'Assistent und Agenten' : 'nur der Assistent',
                  },
                  { label: 'Zyklen pro Nacht', value: formatNumber(config.cycles) },
                  { label: 'Verdichten mit', value: config.model || 'Standardmodell' },
                  {
                    label: 'Einsichten mit',
                    value: config.insightModel || config.model || 'Standardmodell',
                  },
                  {
                    label: 'Einschläfern nach',
                    value: formatNumber(config.dormantAfterDays) + ' Tagen ohne Abruf',
                  },
                ]}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <SectionHeading title="Nächte" hint="Die letzten Läufe des nächtlichen Aufräumens.">
        <DataTable
          data={runs}
          columns={columns}
          getRowId={(run) => run.id}
          idPrefix="naechte"
          initialSorting={[{ id: 'startedAt', desc: true }]}
          pageSize={10}
          columnLabels={COLUMN_LABELS}
          initialColumnVisibility={{ readCount: false, modelCalls: false }}
          rowLabel={{ singular: 'Nacht', plural: 'Nächten' }}
          capped={runsCapped}
          loading={sleep.loading}
          onRowClick={setReport}
          rowClickIgnoreColumns={['actions']}
          rowClassName={(run) => (run.undoneAt ? 'opacity-70' : undefined)}
          error={sleep.error ? <ServerOffline onRetry={() => void sleep.refresh()} /> : undefined}
          empty={
            <EmptyState
              icon={MoonIcon}
              title="Noch keine Nacht gelaufen"
              description="Eine Nacht räumt das Gedächtnis auf, verdichtet Doppeltes und zieht Verbindungen. Alles davon ist mit einem Klick zurückholbar."
              actionLabel="Jetzt schlafen"
              onAction={() => void start()}
              variant="plain"
              size="sm"
            />
          }
        />
      </SectionHeading>

      {/*
        One drawer for the whole table instead of one per row: two hundred
        mounted vaul instances would each bring their own portal and focus trap.
      */}
      <DetailDrawer
        open={report !== null}
        onOpenChange={(open) => {
          if (!open) setReport(null);
        }}
        title="Bericht der Nacht"
        description={
          report
            ? formatDateTime(report.startedAt) + ' · ' + CRON_TRIGGER_LABEL[report.trigger]
            : undefined
        }
      >
        {report ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge kind="sleepRun" status={report.status} />
              {report.undoneAt ? <Badge variant="outline">zurückgenommen</Badge> : null}
              {report.durationMs !== undefined ? (
                <span className="text-muted-foreground">{formatDuration(report.durationMs)}</span>
              ) : null}
            </div>

            <MetaList
              columns={2}
              items={[
                { label: 'gelesen', value: formatNumber(report.readCount) },
                { label: 'verdichtet', value: formatNumber(report.mergedCount) },
                { label: 'verknüpft', value: formatNumber(report.edgeCount) },
                { label: 'eingeschläfert', value: formatNumber(report.dormantCount) },
                { label: 'Einsichten', value: formatNumber(report.insightCount) },
                { label: 'Modellaufrufe', value: formatNumber(report.modelCalls) },
                {
                  label: 'Widersprüche',
                  value:
                    report.conflictCount === 0
                      ? null
                      : formatNumber(report.resolvedCount) +
                        ' von ' +
                        formatNumber(report.conflictCount) +
                        ' entschieden',
                },
              ]}
            />

            {reportText(report) ? (
              <pre
                className={
                  'whitespace-pre-wrap break-words font-mono text-xs ' +
                  (report.error ? 'text-destructive' : '')
                }
              >
                {reportText(report)}
              </pre>
            ) : null}
          </>
        ) : null}
      </DetailDrawer>
    </>
  );
}

/**
 * One of the six counters a night reports.
 *
 * They are all the same column - right-aligned, sortable, tabular - so they
 * are built rather than written out six times.
 */
function countColumn(key: keyof SleepRun & string, title: string) {
  return column.accessor((run) => Number(run[key] ?? 0), {
    id: key,
    header: ({ column: col }) => <DataTableColumnHeader column={col} title={title} align="end" />,
    cell: ({ getValue }) => (
      <div className="text-right tabular-nums">{formatNumber(getValue() as number)}</div>
    ),
  });
}
