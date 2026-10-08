import { BrainIcon, MoonIcon, PlusIcon, SunIcon } from '@/components/icons';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useOutletContext } from 'react-router';

import { toast } from 'sonner';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { RotatingText, RotatingTextContainer } from '@/components/animate-ui/primitives/texts/rotating';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';

import { api } from '@/lib/api';
import { ORIGIN_LABEL, SLEEP_PHASE_DETAIL, SLEEP_PHASE_LABEL } from '@/lib/format';
import { bucketByDay, daysAgo, formatNumber } from '@/lib/stats';
import type { MemoryOrigin, MemoryStats } from '@/lib/types';
import { useMemoryState, type MemoryState } from '@/providers/rookery-provider';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import { TrendChartCard, type TrendSeries } from '@/components/blocks/trend-chart-card';
import { EmptyState } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { RememberDialog } from './memory/RememberDialog';

/**
 * The memory, three ways - and the frame all three share.
 *
 * The views are routes, so a link into the net or into last night's report
 * exists; this layout is what stays put across them - the headline numbers,
 * the running night, the tab row.
 *
 * Neither number is summed over a capped list: `GET /api/memories/stats`
 * counts in SQL (`memoryStats` in `core/memory/store.ts`), and the growth
 * badge comes from `GET /api/stats`, which groups by day in the database.
 * They still count different things - the total only what is awake, the badge
 * everything ever learned - so the card says so in its footnote.
 *
 * While a night actually runs, one row appears under the cards; the rest of
 * what a night did lives on `/memory/sleep`.
 */

/** How far back the growth badge counts. Whole local days, including today. */
const GROWTH_DAYS = 7;

/** The window the growth curve on the overview draws. */
const CHART_DAYS = 90;

const ORIGINS: MemoryOrigin[] = ['extract', 'user', 'sleep'];

/** The bands of the growth curve, one per origin of a memory. */
const GROWTH_SERIES: TrendSeries[] = [
  { key: 'extract', label: ORIGIN_LABEL.extract, color: 'var(--chart-1)' },
  { key: 'user', label: ORIGIN_LABEL.user, color: 'var(--chart-2)' },
  { key: 'sleep', label: ORIGIN_LABEL.sleep, color: 'var(--chart-3)' },
];

/**
 * The stages of a night, in order - the row's progress bar walks them. `replay`
 * runs once before the cycles and has to be listed here like every other
 * `SleepStage` from `types.ts`: `phaseProgress` maps an unknown phase to zero,
 * so a missing stage makes the bar jump back to the start mid-run.
 */
const SLEEP_PHASES = ['started', 'replay', 'dream', 'light', 'deep', 'rem', 'finished'] as const;

const OVERVIEW_TAB = { to: '/memory', label: 'Overview', end: true } as const;
const NETWORK_PATH = '/memory/graph';

const TABS = [
  OVERVIEW_TAB,
  { to: '/memory/memories', label: 'Memories', end: false },
  { to: NETWORK_PATH, label: 'Network', end: false },
  { to: '/memory/sleep', label: 'Nights', end: false },
] as const;

/** What the three child routes may reach back into the frame for. */
export interface MemoryOutletContext {
  /**
   * Opens the shared "Save memory" dialog. The header button and the list's
   * toolbar button are the same dialog, so a half-typed memory survives a
   * click on the wrong one.
   */
  openRemember(): void;
}

export function useMemoryOutlet(): MemoryOutletContext {
  return useOutletContext<MemoryOutletContext>();
}

function phaseProgress(phase: string): number {
  const index = SLEEP_PHASES.indexOf(phase as (typeof SLEEP_PHASES)[number]);
  if (index < 0) return 0;
  return (index / (SLEEP_PHASES.length - 1)) * 100;
}

function useActiveTab() {
  const { pathname } = useLocation();
  return useMemo(() => {
    const match = [...TABS].reverse().find((tab) => (tab.end ? pathname === tab.to : pathname.startsWith(tab.to)));
    return match ?? OVERVIEW_TAB;
  }, [pathname]);
}

export function MemoryLayout() {
  const { memories, graph, sleep } = useMemoryState();
  const [rememberOpen, setRememberOpen] = useState(false);
  const active = useActiveTab();

  const openRemember = useCallback(() => setRememberOpen(true), []);

  usePageMeta(
    {
      breadcrumb: [{ label: 'Memory', to: '/memory' }, { label: active.label }],
      actions: <HeaderActions sleep={sleep} onRemember={openRemember} />,
    },
    [active.label, openRemember, sleep],
  );

  const isOverview = active.to === OVERVIEW_TAB.to;
  const isNetwork = active.to === NETWORK_PATH;

  return (
    <PageBody scroll={!isNetwork} className={isNetwork ? 'memory-network-layout' : undefined}>
      {sleep.status?.running && !isNetwork ? <RunningNightRow sleep={sleep} /> : null}

      {/*
        Radix' tabs give the routes the block's own tab look and its keyboard
        handling; the triggers are `NavLink`s underneath, so each view has a
        URL somebody can send.

        The outlet sits in a `TabsContent` inside the same root, exactly as in
        `OrgLayout`: every trigger announces an `aria-controls`, and without a
        panel of that id the promise points at nothing.
      */}
      <Tabs value={active.to} className="min-h-0 flex-1 gap-4">
        <Fade delay={50} className="shrink-0">
          <div className="overflow-x-auto px-4 lg:px-6">
            <TabsList>
              {TABS.map((tab) => (
                <TabsTrigger key={tab.to} value={tab.to} asChild>
                  <NavLink to={tab.to} end={tab.end}>
                    {tab.label}
                  </NavLink>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Fade>

        <TabsContent
          value={active.to}
          forceMount
          className="flex min-h-0 flex-1 flex-col gap-4 md:gap-6"
        >
          {isOverview ? (
            <Overview stats={memories.stats} graph={graph} />
          ) : (
            <Outlet context={{ openRemember } satisfies MemoryOutletContext} />
          )}
        </TabsContent>
      </Tabs>

      <RememberDialog open={rememberOpen} onOpenChange={setRememberOpen} onAdd={memories.add} />
    </PageBody>
  );
}

/**
 * "Save memory" is the primary action; running a night is an operational one
 * and moves into the overflow menu rather than sitting glued beside it as an
 * equal. A night in progress is the exception - then the way to stop it has to
 * be visible, not two clicks deep.
 */
function HeaderActions({
  sleep,
  onRemember,
}: {
  sleep: MemoryState['sleep'];
  onRemember(): void;
}) {
  const running = sleep.status?.running ?? false;

  const startNight = async (): Promise<void> => {
    const started = await sleep.start();
    if (started) toast('Memory sleep is running', { description: 'Progress appears above the tabs.' });
    else toast.error('Memory sleep could not be started');
  };

  return (
    <>
      <Button size="sm" onClick={onRemember}>
        <PlusIcon data-icon="inline-start" size={24} />
        Save memory
      </Button>
      {running && (
        <Button size="sm" variant="outline" onClick={() => void sleep.cancel()}>
          <Spinner data-icon="inline-start" aria-hidden="true" />
          Wake
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton tone="header" label="More Memory actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={sleep.busy || running} onSelect={() => void startNight()}>
            {sleep.busy ? <Spinner aria-hidden="true" /> : <MoonIcon />}
            Run memory sleep now
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function RunningNightRow({ sleep }: { sleep: MemoryState['sleep'] }) {
  return (
    <Fade>
      <div className="px-4 lg:px-6">
        <Item variant="outline" size="sm">
          <ItemMedia variant="icon">
            <Spinner aria-hidden="true" />
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="flex flex-wrap items-center gap-2">
              {/* The phase walks through the night; each step rolls the
                  label rather than snapping it. */}
              <Badge variant="secondary">
                <RotatingTextContainer text={SLEEP_PHASE_LABEL[sleep.phase] ?? 'is running'}>
                  <RotatingText />
                </RotatingTextContainer>
              </Badge>
              {sleep.cycle > 0 ? (
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  Cycle {formatNumber(sleep.cycle)}
                </span>
              ) : null}
            </ItemTitle>
            <ItemDescription>
              {SLEEP_PHASE_DETAIL[sleep.phase] ?? 'Memory is being reorganized.'}
            </ItemDescription>
            <Progress
              value={phaseProgress(sleep.phase)}
              aria-label="Memory sleep progress"
              className="mt-2 h-1"
            />
          </ItemContent>
          <ItemActions>
            <Button size="sm" variant="outline" onClick={() => void sleep.cancel()}>
              <SunIcon data-icon="inline-start" size={24} />
              Wake
            </Button>
          </ItemActions>
        </Item>
      </div>
    </Fade>
  );
}

/** The headline cards and the growth curve - the index route's own content. */
function Overview({
  stats,
  graph,
}: {
  stats: MemoryStats | null;
  graph: MemoryState['graph'];
}) {
  const growth = useRecentGrowth(stats?.total ?? null);
  const nodes = graph.graph?.memories;

  // The curve rests on the net's nodes rather than on the memory list: that
  // list is re-ranked by every search, which would make the shape jump around
  // while somebody types. `GET /api/stats` does count memories per day in the
  // database, but it cannot split them by origin - and the split is the whole
  // point of this chart, so the base is the loaded nodes and the card says so.
  const growthCurve = useMemo(() => {
    // An empty bank is not "ninety days of zero": the card should say that
    // nothing was learned rather than draw a flat line along the floor.
    if (!nodes?.length) return [];
    return bucketByDay(nodes, (memory) => memory.createdAt, {
      since: daysAgo(CHART_DAYS - 1),
      seriesOf: (memory) => memory.origin,
      keys: ORIGINS,
    });
  }, [nodes]);

  return (
    <>
      <Fade delay={100}>
        <StatCards items={buildStatCards(stats, growth)} />
      </Fade>
      <Fade delay={150}>
        <div className="px-4 lg:px-6">
          <TrendChartCard
            title="Memory growth"
            description="New memories per day, grouped by source."
            descriptionShort="Learned per day"
            data={growthCurve}
            series={GROWTH_SERIES}
            {...(graph.graph?.truncated
              ? { badge: <Badge variant="outline">truncated</Badge> }
              : {})}
            empty={
              <EmptyState
                icon={BrainIcon}
                title="Nothing was learned during this period"
                description="A longer period may show more."
                variant="plain"
                size="sm"
              />
            }
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Based on the loaded network nodes
            {nodes ? ' (' + formatNumber(nodes.length) + ')' : ''}, not the entire database.
          </p>
        </div>
      </Fade>
    </>
  );
}

/**
 * Real growth, counted in the database rather than over the loaded nodes. It is
 * refetched whenever the total moves, which is every write to the bank and
 * every finished night. The badge is a nicety: when the count cannot be
 * fetched it stays out instead of raising an error over the headline numbers.
 */
function useRecentGrowth(total: number | null): number | null {
  const [growth, setGrowth] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stats({ days: GROWTH_DAYS })
      .then((snapshot) => {
        if (!cancelled) setGrowth(snapshot.series.reduce((sum, day) => sum + day.memories, 0));
      })
      .catch(() => {
        if (!cancelled) setGrowth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [total]);

  return growth;
}

// The headline numbers roll in from zero once the stats arrive and keep
// rolling whenever a write or a finished night moves them. The separator
// keeps `formatNumber`'s en-GB comma in the resting pose, which neither
// counting variant would draw on its own above a thousand.
function liveNumber(value: number): ReactNode {
  return <SlidingNumber number={value} fromNumber={0} thousandSeparator="," />;
}

function buildStatCards(stats: MemoryStats | null, growth: number | null): StatCardProps[] {
  const waiting = <Skeleton className="h-7 w-16" />;

  return [
    {
      label: 'Memories',
      value: stats ? liveNumber(stats.total) : waiting,
      // "Learned", not "added": the daily series counts every memory ever
      // created, while the number above only counts those still awake. A night
      // that condenses or puts memories to sleep lowers the number without
      // touching the badge - the footnote says so instead of making the two
      // look like the same amount.
      ...(growth !== null && growth > 0
        ? {
            badge: (
              <Badge variant="outline">
                +{formatNumber(growth)} learned in {GROWTH_DAYS} days
              </Badge>
            ),
          }
        : {}),
      headline: stats ? formatNumber(stats.forgotten) + ' forgotten' : ' ',
      footnote:
        'Active memories. Newly learned also includes entries that have since been consolidated.',
      to: '/memory/memories',
    },
    {
      label: 'Pinned',
      value: stats ? liveNumber(stats.pinned) : waiting,
      headline: 'Protected overnight',
      footnote: 'Pinned memories are untouched by nightly cleanup',
    },
    {
      label: 'Sleeping',
      value: stats ? liveNumber(stats.dormant) : waiting,
      headline: 'Skipped during recall',
      footnote: 'Not deleted — one click restores a sleeping memory',
    },
    {
      label: 'Connections',
      value: stats ? liveNumber(stats.edges) : waiting,
      headline: stats
        ? 'Across ' + formatNumber(stats.entities) + (stats.entities === 1 ? ' topic' : ' topics')
        : ' ',
      footnote: 'Connections between two memories, usually created during sleep',
      to: NETWORK_PATH,
    },
  ];
}
