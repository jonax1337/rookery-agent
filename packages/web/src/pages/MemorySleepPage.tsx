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
  { key: 'verdichtet', label: 'condensed', color: 'var(--chart-1)' },
  { key: 'verknuepft', label: 'linked', color: 'var(--chart-2)' },
  { key: 'eingeschlaefert', label: 'put to sleep', color: 'var(--chart-3)' },
  { key: 'einsichten', label: 'Insights', color: 'var(--chart-4)' },
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
  startedAt: 'Night',
  trigger: 'Trigger',
  duration: 'Duration',
  readCount: 'read',
  mergedCount: 'condensed',
  edgeCount: 'linked',
  dormantCount: 'put to sleep',
  insightCount: 'Insights',
  skillRevisedCount: 'Skills revised',
  skillCount: 'Skills written',
  modelCalls: 'Model calls',
  status: 'Status',
};

const column = createRookeryColumnHelper<SleepRun>();

/** A night is undoable only while it actually changed something. */
function undoable(run: SleepRun): boolean {
  if (run.undoneAt) return false;
  if (run.status !== 'done') return false;
  // The skill counts belong here too: undoing a night now puts the skill
  // files back as well, so a night that only rewrote a procedure is every bit
  // as undoable as one that touched the bank.
  return (
    run.mergedCount > 0 ||
    run.dormantCount > 0 ||
    run.edgeCount > 0 ||
    run.insightCount > 0 ||
    run.skillCount > 0 ||
    run.skillRevisedCount > 0
  );
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

  /* -------------------------------- Actions ------------------------------ */

  const start = useCallback(async (): Promise<void> => {
    const ok = await sleep.start();
    if (ok) toast('Memory sleep is running');
    else toast.error('Memory sleep could not be started');
  }, [sleep]);

  const undo = useCallback(
    async (run: SleepRun): Promise<void> => {
      const ok = await confirm({
        title: 'Undo night?',
        description:
          'Wakes memories made dormant by this run, removes its recorded generated memories and connections, and puts back any skill it wrote or rewrote. Other changes, such as topic updates, may remain.',
        confirmLabel: 'Undo',
        destructive: true,
      });
      if (!ok) return;
      setUndoing(run.id);
      try {
        const result = await sleep.undo(run.id);
        toast('Night undone', {
          description:
            formatNumber(result.woken) +
            ' restored · ' +
            formatNumber(result.removed) +
            ' removed · ' +
            formatNumber(result.edges) +
            ' connections unlinked' +
            (result.skills ? ' · ' + formatNumber(result.skills) + ' skills restored' : ''),
        });
      } catch (caught) {
        reportFailure('Undo', caught);
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
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Night" />,
          enableHiding: false,
          cell: ({ row }) => (
            <div className="flex flex-col">
              <span className="whitespace-nowrap tabular-nums">
                {formatDateTime(row.original.startedAt)}
              </span>
              {row.original.undoneAt ? (
                <span className="text-xs text-muted-foreground">
                  undone {formatDateTime(row.original.undoneAt)}
                </span>
              ) : null}
            </div>
          ),
        }),
        column.accessor((run) => CRON_TRIGGER_LABEL[run.trigger], {
          id: 'trigger',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Trigger" />,
          cell: ({ getValue }) => (
            <span className="text-muted-foreground">{getValue() as string}</span>
          ),
        }),
        column.accessor((run) => run.durationMs ?? 0, {
          id: 'duration',
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Duration" align="end" />
          ),
          cell: ({ row }) => (
            <div className="text-right tabular-nums">
              {formatDuration(row.original.durationMs) || EMPTY_CELL}
            </div>
          ),
        }),
        countColumn('readCount', 'read'),
        countColumn('mergedCount', 'condensed'),
        countColumn('edgeCount', 'linked'),
        countColumn('dormantCount', 'put to sleep'),
        countColumn('insightCount', 'Insights'),
        countColumn('skillRevisedCount', 'Skills revised'),
        countColumn('skillCount', 'Skills written'),
        countColumn('modelCalls', 'Model calls'),
        column.accessor('status', {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
          cell: ({ row }) => {
            const run = row.original;
            const open = run.conflictCount - run.resolvedCount;
            return (
              <div className="flex flex-wrap items-center gap-1">
                <StatusBadge kind="sleepRun" status={run.status} />
                {run.undoneAt ? <Badge variant="outline">undone</Badge> : null}
                {open > 0 ? (
                  <Badge variant="destructive" className="gap-1">
                    <TriangleAlertIcon aria-hidden="true" />
                    {open === 1 ? '1 unresolved conflict' : formatNumber(open) + ' unresolved conflicts'}
                  </Badge>
                ) : null}
              </div>
            );
          },
        }),
        actionsColumn<SleepRun>((run) => (
          <div className="flex items-center justify-end gap-1">
            {reportText(run) ? (
              <DetailDrawerTrigger onClick={() => setReport(run)}>Report</DetailDrawerTrigger>
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
                Undo
              </Button>
            ) : null}
          </div>
        )),
      ]),
    [undo, undoing],
  );

  /* -------------------------------- Schedule ------------------------------ */

  const schedule = status?.schedule ?? null;
  const config = status?.config ?? null;

  const nextRun = schedule?.enabled && schedule.nextRunAt ? formatDateTime(schedule.nextRunAt) : null;

  return (
    <>
      {dialog}

      <div className="px-4 lg:px-6">
        <TrendChartCard
          title="What the nights produced"
          description={
            'Consolidated, linked, put to sleep, and resolved per night, as recorded by the server.' +
            (runs.length > 0
              ? ' Based on the latest ' +
                formatNumber(runs.length) +
                (runs.length === 1 ? ' recorded night.' : ' recorded nights.')
              : '')
          }
          descriptionShort="Per night"
          data={nights}
          series={NIGHT_SERIES}
          {...cappedBadge(runsCapped)}
          empty={
            <EmptyState
              icon={MoonIcon}
              title="No night ran during this period"
              description="A longer period may show more."
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
              Sleep
              {running ? (
                <>
                  <Badge variant="secondary">{SLEEP_PHASE_LABEL[sleep.phase] ?? 'is running'}</Badge>
                  {sleep.cycle > 0 ? (
                    <span className="text-sm font-normal text-muted-foreground tabular-nums">
                      Cycle {formatNumber(sleep.cycle)}
                    </span>
                  ) : null}
                  <Spinner aria-label="Running" />
                </>
              ) : null}
            </CardTitle>
            <CardDescription>
              {running
                ? (SLEEP_PHASE_DETAIL[sleep.phase] ?? 'Memory is being reorganized.')
                : 'Light sleep cleans up, deep sleep consolidates and resolves conflicts, and dream sleep creates connections and insights. Nothing is deleted.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {running ? (
                <Button variant="outline" onClick={() => void sleep.cancel()}>
                  <SunIcon data-icon="inline-start" />
                  Wake
                </Button>
              ) : (
                <Button disabled={sleep.busy} onClick={() => void start()}>
                  {sleep.busy ? (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  ) : (
                    <MoonIcon data-icon="inline-start" />
                  )}
                  Run memory sleep now
                </Button>
              )}
              <span className="text-sm text-muted-foreground">
                {nextRun
                  ? 'Next run ' + nextRun
                  : config?.enabled === false
                    ? 'The nightly run is disabled.'
                    : 'No schedule configured.'}
              </span>
            </div>

            {config ? (
              <MetaList
                columns={3}
                items={[
                  { label: 'Schedule', value: config.schedule, mono: true },
                  {
                    label: 'Scope',
                    value: config.scope === 'all' ? 'Assistant and agents' : 'assistant only',
                  },
                  { label: 'Cycles per night', value: formatNumber(config.cycles) },
                  { label: 'Consolidate with', value: config.model || 'Default model' },
                  {
                    label: 'Generate insights with',
                    value: config.insightModel || config.model || 'Default model',
                  },
                  {
                    label: 'Put to sleep after',
                    value: formatNumber(config.dormantAfterDays) + ' days without recall',
                  },
                ]}
              />
            ) : null}
          </CardContent>
        </Card>
      </div>

      <SectionHeading title="Nights" hint="Recent nightly cleanup runs.">
        <DataTable
          data={runs}
          columns={columns}
          getRowId={(run) => run.id}
          idPrefix="naechte"
          initialSorting={[{ id: 'startedAt', desc: true }]}
          pageSize={10}
          columnLabels={COLUMN_LABELS}
          initialColumnVisibility={{ readCount: false, modelCalls: false }}
          rowLabel={{ singular: 'Night', plural: 'nights' }}
          capped={runsCapped}
          loading={sleep.loading}
          onRowClick={setReport}
          rowClickIgnoreColumns={['actions']}
          rowClassName={(run) => (run.undoneAt ? 'opacity-70' : undefined)}
          error={sleep.error ? <ServerOffline onRetry={() => void sleep.refresh()} /> : undefined}
          empty={
            <EmptyState
              icon={MoonIcon}
              title="No nights have run yet"
              description="A night tidies memory, consolidates duplicates and creates connections. You can review the report and undo recorded changes."
              actionLabel="Run memory sleep now"
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
        title="Night report"
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
              {report.undoneAt ? <Badge variant="outline">undone</Badge> : null}
              {report.durationMs !== undefined ? (
                <span className="text-muted-foreground">{formatDuration(report.durationMs)}</span>
              ) : null}
            </div>

            <MetaList
              columns={2}
              items={[
                { label: 'read', value: formatNumber(report.readCount) },
                { label: 'condensed', value: formatNumber(report.mergedCount) },
                { label: 'linked', value: formatNumber(report.edgeCount) },
                { label: 'put to sleep', value: formatNumber(report.dormantCount) },
                { label: 'Insights', value: formatNumber(report.insightCount) },
                { label: 'Skills revised', value: formatNumber(report.skillRevisedCount) },
                { label: 'Skills written', value: formatNumber(report.skillCount) },
                { label: 'Model calls', value: formatNumber(report.modelCalls) },
                {
                  label: 'Conflicts',
                  value:
                    report.conflictCount === 0
                      ? null
                      : formatNumber(report.resolvedCount) +
                        ' of ' +
                        formatNumber(report.conflictCount) +
                        ' resolved',
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
