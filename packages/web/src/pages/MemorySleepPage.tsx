import { useCallback, useMemo, useState } from 'react';

import { MoonIcon } from '@/components/icons';
import { toast } from 'sonner';

import { reportFailure } from '@/lib/errors';
import { bucketByDay, daysAgo, formatNumber } from '@/lib/stats';
import type { SleepRun } from '@/lib/types';
import { SLEEP_RUN_LIMIT } from '@/hooks/useMemories';
import { useMemoryState, type MemoryState } from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { SectionHeading } from '@/components/blocks/section-heading';
import { cappedBadge } from '@/components/blocks/stat-cards';
import { TrendChartCard, type TrendPoint, type TrendSeries } from '@/components/blocks/trend-chart-card';
import { useConfirm, type ConfirmHandle } from '@/components/common/confirm-dialog';
import { DreamSection } from '@/components/common/dream-section';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';

import { NightReportDrawer } from './memory/NightReportDrawer';
import { NIGHT_COLUMN_LABELS, NIGHT_INITIAL_VISIBILITY, nightColumns } from './memory/night-columns';
import { SleepCard } from './memory/SleepCard';

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
  { key: 'condensed', label: 'condensed', color: 'var(--chart-1)' },
  { key: 'linked', label: 'linked', color: 'var(--chart-2)' },
  { key: 'putToSleep', label: 'put to sleep', color: 'var(--chart-3)' },
  { key: 'insights', label: 'Insights', color: 'var(--chart-4)' },
];

/** The widest window the range switch offers. */
const CHART_DAYS = 90;

interface NightPoint extends TrendPoint {
  condensed: number;
  linked: number;
  putToSleep: number;
  insights: number;
}

export function MemorySleepPage() {
  const { sleep } = useMemoryState();
  const { confirm, dialog } = useConfirm();
  const [report, setReport] = useState<SleepRun | null>(null);
  const { undoing, undo } = useUndoNight(sleep, confirm);

  const runs = sleep.runs;

  // The history request stops at two hundred nights - roughly half a year of
  // nightly runs, so the cap normally never bites. When it does, curve and
  // table both rest on a cut-off list and have to say so, the way every
  // other capped surface in the app does.
  const runsCapped = runs.length >= SLEEP_RUN_LIMIT;

  const start = useCallback(async (): Promise<void> => {
    const ok = await sleep.start();
    if (ok) toast('Memory sleep is running');
    else toast.error('Memory sleep could not be started');
  }, [sleep]);

  const columns = useMemo(
    () => nightColumns({ undoing, onReport: setReport, onUndo: (run) => void undo(run) }),
    [undo, undoing],
  );

  return (
    <>
      {dialog}

      <Fade asChild>
        <div className="px-4 lg:px-6">
          <NightsChart runs={runs} capped={runsCapped} />
        </div>
      </Fade>

      <Fade asChild delay={50}>
        <div className="px-4 lg:px-6">
          <SleepCard sleep={sleep} onStart={() => void start()} />
        </div>
      </Fade>

      <Fade delay={100}>
        <SectionHeading title="Nights" hint="Recent nightly cleanup runs.">
          <DataTable
            data={runs}
            columns={columns}
            getRowId={(run) => run.id}
            idPrefix="nights"
            initialSorting={[{ id: 'startedAt', desc: true }]}
            pageSize={10}
            columnLabels={NIGHT_COLUMN_LABELS}
            initialColumnVisibility={NIGHT_INITIAL_VISIBILITY}
            rowLabel={{ singular: 'Night', plural: 'nights' }}
            capped={runsCapped}
            loading={sleep.loading}
            onRowClick={setReport}
            rowClickIgnoreColumns={['actions']}
            rowClassName={(run) => (run.undoneAt ? 'opacity-70' : undefined)}
            error={sleep.error ? <ServerOffline onRetry={() => void sleep.refresh()} /> : undefined}
            empty={
              <Fade>
                <EmptyState
                  icon={MoonIcon}
                  title="No nights have run yet"
                  description="A night tidies memory, consolidates duplicates and creates connections. You can review the report and undo recorded changes."
                  actionLabel="Run memory sleep now"
                  onAction={() => void start()}
                  variant="plain"
                  size="sm"
                />
              </Fade>
            }
          />
        </SectionHeading>
      </Fade>

      {/*
        The dream is a section of this page, not a fourth tab under /memory
        (concept 9.6, S27): it is one stage of the same night the table above
        lists, and `page-navigation.test.mjs` asserts /memory keeps exactly
        three children.
      */}
      <DreamSection />

      <NightReportDrawer run={report} onClose={() => setReport(null)} />
    </>
  );
}

/** Taking a night back is itself a rewrite, so it asks first and reports what it undid. */
function useUndoNight(sleep: MemoryState['sleep'], confirm: ConfirmHandle['confirm']) {
  const [undoing, setUndoing] = useState<string | null>(null);

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

  return { undoing, undo };
}

function NightsChart({ runs, capped }: { runs: SleepRun[]; capped: boolean }) {
  const nights = useMemo(() => bucketNights(runs), [runs]);

  return (
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
      {...cappedBadge(capped)}
      empty={
        <Fade>
          <EmptyState
            icon={MoonIcon}
            title="No night ran during this period"
            description="A longer period may show more."
            variant="plain"
            size="sm"
          />
        </Fade>
      }
    />
  );
}

// Four passes over the same runs rather than one hand-rolled loop: the
// shared bucketing already fills the empty days and steps the calendar the
// way a DST change needs, and four passes over two hundred rows is nothing.
function bucketNights(runs: SleepRun[]): NightPoint[] {
  // No runs at all is not "ninety days of zero": the card should say that
  // nothing has run rather than draw a flat line along the floor.
  if (runs.length === 0) return [];
  const since = daysAgo(CHART_DAYS - 1);
  const perDay = (weigh: (run: SleepRun) => number) =>
    bucketByDay(runs, (run) => run.startedAt, { since, weight: weigh });

  const merged = perDay((run) => run.mergedCount);
  const edges = perDay((run) => run.edgeCount);
  const dormant = perDay((run) => run.dormantCount);
  const insights = perDay((run) => run.insightCount);

  return merged.map((day, index) => ({
    day: day.day,
    at: day.at,
    condensed: day.count,
    linked: edges[index]?.count ?? 0,
    putToSleep: dormant[index]?.count ?? 0,
    insights: insights[index]?.count ?? 0,
  }));
}
