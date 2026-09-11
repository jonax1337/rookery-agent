import * as React from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatDate, formatDayAxis, formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';

/**
 * The time series card from `dashboard-01/components/chart-area-interactive.tsx`.
 *
 * Four corrections to the original, all of them things that would be bugs
 * here: the reference date is `Date.now()` instead of the block's hard-wired
 * 2024-06-30, the axis and the tooltip format `de-DE`, the gradient ids are
 * prefixed with `useId()` so two charts on one page stop stealing each
 * other's fills, and the data arrives as a prop - `data.json` stays in the
 * reference folder.
 *
 * Four more corrections came out of looking at the card with real data
 * instead of the block's dense demo series, and they are the places where
 * being right beats being faithful to the block:
 *
 * - `type="monotone"` instead of the block's `"natural"`. A natural spline
 *   overshoots around a spike, and on a thin counting series it visibly
 *   dips below zero before a busy day. There is no such thing as minus two
 *   conversations; monotone interpolation cannot overshoot by construction.
 * - a narrow `YAxis`. The block leaves it out because its demo numbers mean
 *   nothing - here they are counts, and a curve without a scale never says
 *   whether the spike is three or three hundred.
 * - a legend as soon as more than one band is drawn. Three stacked colours
 *   with no key can only be read by hunting for the tooltip.
 * - the default range follows the data (see `suggestRange`), because a
 *   ninety-day window over a week-old database is 95 % empty and reads as a
 *   broken card.
 *
 * The range switch can be left alone (the card filters the rows it was given)
 * or driven from outside, for the pages whose range is a server parameter.
 */

export type TrendRange = '90d' | '30d' | '7d';

/** How many days each range covers - pages use it to size their fetch window. */
export const TREND_RANGE_DAYS: Record<TrendRange, number> = {
  '90d': 90,
  '30d': 30,
  '7d': 7,
};

const RANGE_LABEL: Record<TrendRange, string> = {
  '90d': 'Letzte 3 Monate',
  '30d': 'Letzte 30 Tage',
  '7d': 'Letzte 7 Tage',
};

/**
 * The same window as a suffix, for the badges a page hangs next to the range
 * switch: "12.345 Tokens in 30 Tagen" only means something with the window
 * in it, and the switch that changed it sits right there.
 */
export const TREND_RANGE_SUFFIX: Record<TrendRange, string> = {
  '90d': 'in 3 Monaten',
  '30d': 'in 30 Tagen',
  '7d': 'in 7 Tagen',
};

const RANGES: TrendRange[] = ['90d', '30d', '7d'];

/** Narrowest to widest - the order `suggestRange` tries them in. */
const RANGES_ASCENDING: TrendRange[] = ['7d', '30d', '90d'];

/**
 * The narrowest window the card picks on its own.
 *
 * Auto-narrowing to seven days would be right for the data and wrong for the
 * reader: a week of bars is a snapshot, not a trend, and someone opening the
 * dashboard on a young database should still see a month of context. Below
 * this the range is only ever the user's choice - or the mobile layout's.
 */
const AUTO_MIN_RANGE: TrendRange = '30d';

/** One stacked band: the field to read, its German label, its colour. */
export interface TrendSeries {
  /** Key on each row, e.g. `'Gespräche'` - also the `--color-*` variable name. */
  key: string;
  label: string;
  /** A CSS colour, usually `var(--chart-1)`. */
  color: string;
}

/** A row of the chart: a day key plus one number per series. */
export interface TrendPoint {
  /** `YYYY-MM-DD`, local, the key `dayKey`/`bucketByDay` produce. */
  day: string;
  /** Local midnight of that day, when the producer already knows it. */
  at?: number;
}

export interface TrendChartCardProps<T extends TrendPoint> {
  title: React.ReactNode;
  /** Says what the numbers rest on ("Basis: die letzten 500 Gespräche"). */
  description?: React.ReactNode;
  /** Shown instead of `description` on a narrow card, like the block does. */
  descriptionShort?: React.ReactNode;
  data: readonly T[];
  series: readonly TrendSeries[];
  /** Controlled range - pass it when the switch drives a refetch. */
  range?: TrendRange;
  onRangeChange?: (range: TrendRange) => void;
  /**
   * Fixes the starting window. Left out - the normal case - the card picks
   * the narrowest window that still holds every non-zero day, never below
   * `AUTO_MIN_RANGE`, once and only once, when the first rows arrive.
   */
  defaultRange?: TrendRange;
  /** Rendered when the window holds no rows at all - an `EmptyState`, usually. */
  empty?: React.ReactNode;
  /** Extra header content left of the range switch, e.g. a "gedeckelt" badge. */
  badge?: React.ReactNode;
  className?: string;
}

/**
 * Local midnight of a row. `YYYY-MM-DD` through `new Date()` would parse as
 * UTC and slide a day west of Greenwich, so the key is split by hand - unless
 * the producer already handed us `at`.
 */
function pointTime(point: TrendPoint): number {
  if (typeof point.at === 'number') return point.at;
  const [year, month, day] = point.day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1).getTime();
}

/**
 * Der Wert einer Reihe in einer Zeile, als Zahl.
 *
 * Dieselbe Lesart wie in `suggestRange`: die Zeilen sind typisiert nur ueber
 * `day`/`at`, die Reihenfelder kommen erst ueber `series` dazu.
 */
function seriesValue(point: TrendPoint, key: string): number {
  const raw = (point as unknown as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** Local midnight `days - 1` days back - the first day a range covers. */
function windowStart(days: number): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/**
 * The narrowest range that still contains every day carrying a number.
 *
 * The point is not to hide old data - it is that a database a few days old
 * drawn over ninety days is a flat line with a tick at the right edge, which
 * looks broken rather than empty. `null` means "nothing to go by": every row
 * is zero, so any window is as good as the next and the caller's stays.
 */
function suggestRange(
  data: readonly TrendPoint[],
  series: readonly TrendSeries[],
): TrendRange | null {
  let oldest = Number.POSITIVE_INFINITY;
  for (const point of data) {
    let sum = 0;
    for (const entry of series) {
      const raw = (point as unknown as Record<string, unknown>)[entry.key];
      if (typeof raw === 'number' && Number.isFinite(raw)) sum += raw;
    }
    if (sum <= 0) continue;
    const at = pointTime(point);
    if (at < oldest) oldest = at;
  }
  if (!Number.isFinite(oldest)) return null;

  for (const candidate of RANGES_ASCENDING) {
    if (TREND_RANGE_DAYS[candidate] < TREND_RANGE_DAYS[AUTO_MIN_RANGE]) continue;
    if (oldest >= windowStart(TREND_RANGE_DAYS[candidate])) return candidate;
  }
  return '90d';
}

export function TrendChartCard<T extends TrendPoint>({
  title,
  description,
  descriptionShort,
  data,
  series,
  range,
  onRangeChange,
  defaultRange,
  empty,
  badge,
  className,
}: TrendChartCardProps<T>) {
  const isMobile = useIsMobile();
  const [innerRange, setInnerRange] = React.useState<TrendRange>(defaultRange ?? '90d');
  const activeRange = range ?? innerRange;

  // `useId` carries colons; the chart primitive strips them for its own ids
  // and so do we, because a `url(#...)` reference is easier to read without.
  const gradientPrefix = React.useId().replace(/:/g, '');

  const setRange = React.useCallback(
    (next: TrendRange) => {
      setInnerRange(next);
      onRangeChange?.(next);
    },
    [onRangeChange],
  );

  React.useEffect(() => {
    if (isMobile) setRange('7d');
  }, [isMobile, setRange]);

  /*
    The data arrives a tick after the first render, so the window cannot be
    chosen in `useState`. It is chosen once, on the first non-empty data set,
    and never again - a second pass would yank the range out from under
    someone who had just widened it by hand. `setRange` rather than
    `setInnerRange` so a page driving the range from outside (and refetching
    on it) learns about the choice too.
  */
  const autoPicked = React.useRef(false);
  React.useEffect(() => {
    if (defaultRange !== undefined || isMobile) return;
    if (autoPicked.current || data.length === 0) return;
    autoPicked.current = true;
    const suggestion = suggestRange(data, series);
    if (suggestion !== null && suggestion !== activeRange) setRange(suggestion);
  }, [data, series, defaultRange, isMobile, activeRange, setRange]);

  const chartConfig = React.useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    for (const entry of series) {
      config[entry.key] = { label: entry.label, color: entry.color };
    }
    return config;
  }, [series]);

  const filtered = React.useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (TREND_RANGE_DAYS[activeRange] - 1));
    const from = start.getTime();
    return data.filter((point) => pointTime(point) >= from);
  }, [data, activeRange]);

  return (
    <Card className={cn('@container/card', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description !== undefined ? (
          <CardDescription>
            {descriptionShort !== undefined ? (
              <>
                <span className="hidden @[540px]/card:block">{description}</span>
                <span className="@[540px]/card:hidden">{descriptionShort}</span>
              </>
            ) : (
              description
            )}
          </CardDescription>
        ) : null}
        <CardAction className="flex items-center gap-2">
          {badge}
          <ToggleGroup
            type="single"
            value={activeRange}
            onValueChange={(value) => {
              if (value) setRange(value as TrendRange);
            }}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
          >
            {RANGES.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {RANGE_LABEL[value]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Select value={activeRange} onValueChange={(value) => setRange(value as TrendRange)}>
            <SelectTrigger
              className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
              size="sm"
              aria-label="Zeitraum wählen"
            >
              <SelectValue placeholder={RANGE_LABEL['90d']} />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {RANGES.map((value) => (
                <SelectItem key={value} value={value} className="rounded-lg">
                  {RANGE_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {filtered.length === 0 ? (
          empty
        ) : (
          <>
            {/*
              Die Kurve ist ein Bild aus <path>-Elementen: ohne Textfassung
              bleibt von ihr nichts uebrig, was vorgelesen werden koennte. Die
              Tabelle unter dem Diagramm ist genau diese Fassung, deshalb ist
              das Diagramm selbst fuer Vorlesehilfen ausgeblendet - sonst
              stuende dieselbe Reihe zweimal da. Bedienbar ist im Diagramm
              nichts, was dabei verloren ginge; der Zeitraumschalter sitzt im
              Kartenkopf.
            */}
            <ChartContainer
              config={chartConfig}
              aria-hidden="true"
              className="aspect-auto h-[250px] w-full"
            >
              <AreaChart data={filtered.slice()}>
                <defs>
                  {series.map((entry, index) => (
                    <linearGradient
                      key={entry.key}
                      id={`${gradientPrefix}-fill-${entry.key}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor={`var(--color-${entry.key})`}
                        stopOpacity={index === 0 ? 1.0 : 0.8}
                      />
                      <stop
                        offset="95%"
                        stopColor={`var(--color-${entry.key})`}
                        stopOpacity={0.1}
                      />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={(value) => formatDayAxis(value as string)}
                />
                {/*
                  Narrow on purpose: the curve is the message, the scale is the
                  footnote. `allowDecimals={false}` because every series here
                  counts whole things, and four ticks is the most that fits a
                  250 px plot without turning into a ruler.
                */}
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  allowDecimals={false}
                  tickCount={4}
                  tickFormatter={(value) => formatNumber(value as number)}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => formatDate(value as string)}
                      indicator="dot"
                    />
                  }
                />
                {series.map((entry) => (
                  <Area
                    key={entry.key}
                    dataKey={entry.key}
                    // The block draws `"natural"`. Its spline overshoots around
                    // a spike, and on a thin counting series that pulls the
                    // curve visibly below the zero line before a busy day -
                    // the chart claiming minus two conversations. Monotone
                    // interpolation cannot overshoot, so correctness wins over
                    // block fidelity at exactly this one line.
                    type="monotone"
                    fill={`url(#${gradientPrefix}-fill-${entry.key})`}
                    stroke={`var(--color-${entry.key})`}
                    stackId="a"
                  />
                ))}
                {/* One band needs no key: the title already names it. */}
                {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
              </AreaChart>
            </ChartContainer>
            <table className="sr-only">
              <caption>
                {title}
                {' — ' + RANGE_LABEL[activeRange]}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tag</th>
                  {series.map((entry) => (
                    <th key={entry.key} scope="col">
                      {entry.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((point) => (
                  <tr key={point.day}>
                    <th scope="row">{formatDate(point.day)}</th>
                    {series.map((entry) => (
                      <td key={entry.key}>{formatNumber(seriesValue(point, entry.key))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
