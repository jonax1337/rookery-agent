import * as React from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
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
import { cn } from '@/lib/utils';

/**
 * A curve whose x axis is a version number, not a calendar day.
 *
 * `TrendChartCard` cannot do this, and the failure would be silent rather
 * than loud: it filters its rows against a window relative to `Date.now()`
 * and stacks its series. Version-indexed rows carry no timestamp that
 * survives that filter, so every row would be dropped and the card would
 * render its empty state - an empty card where a measured history exists is
 * the worst of the three possible outcomes, because nothing on screen says
 * anything went wrong. Hence a second, much smaller card: same head, same
 * `ChartContainer`, same screen-reader table, no range switch, no stacking.
 *
 * What it is for: a score in a fixed interval - normally 0..1 - read once per
 * version of one policy. Lines rather than areas, because the value is a
 * level and not an amount, and because two lines that cross must both stay
 * readable where they cross. `connectNulls` bridges a version a series has no
 * number for: a candidate nobody measured leaves a gap in one line, not a
 * drop to the floor of the chart.
 *
 * Motion is the block default the rest of the app uses: the head staggers,
 * the body joins one step later, and recharts draws its own line animation.
 */

/** One line: the field to read on each row, its label, its colour. */
export interface VersionSeries {
  /** Key on each row - also the `--color-*` variable the chart declares. */
  key: string;
  label: string;
  /** A CSS colour, usually `var(--chart-1)`. */
  color: string;
  /** Dashed, for a reference line such as the incumbent's baseline. */
  dashed?: boolean;
}

/** A row of the curve: one version, plus one number per series. */
export interface VersionPoint {
  /** The version number itself - the x value, and the row key. */
  version: number;
  /** What the axis prints for it. Defaults to `v` + the number. */
  label?: string;
}

export interface VersionCurveCardProps<T extends VersionPoint> {
  title: React.ReactNode;
  /** Says what the numbers rest on. Required in spirit: no number without a source. */
  description?: React.ReactNode;
  /** Shown instead of `description` on a narrow card, as the trend card does. */
  descriptionShort?: React.ReactNode;
  /** Oldest version first - the order the curve is read in. */
  data: readonly T[];
  series: readonly VersionSeries[];
  /**
   * The value range. Left out, the axis is fitted to the observed values with
   * a margin: scores live in 0..1, but the deltas that decide a promotion are
   * hundredths, and an axis anchored at zero draws every version as the same
   * flat line - which is exactly the comparison this card exists to show. The
   * card says so under its description, so a fitted axis is never silent.
   */
  domain?: [number, number];
  /** How a value reads on the axis and in the screen-reader table. */
  valueFormatter?: (value: number) => string;
  /** Rendered instead of the chart when there is no row at all. */
  empty?: React.ReactNode;
  /** Header content left of nothing in particular - a "capped" badge, usually. */
  badge?: React.ReactNode;
  className?: string;
}

/** Two decimals: these are scores in 0..1, where the third digit is noise. */
function defaultFormat(value: number): string {
  return value.toFixed(2);
}

/**
 * The value of one series in one row, as a number or `null`.
 *
 * `null` rather than `0` on purpose: recharts reads `null` as "no point here"
 * and, with `connectNulls`, bridges it. A missing measurement drawn as zero
 * would be a claim nobody made.
 */
function seriesValue(point: VersionPoint, key: string): number | null {
  const raw = (point as unknown as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function axisLabel(point: VersionPoint): string {
  return point.label ?? 'v' + point.version;
}

export function VersionCurveCard<T extends VersionPoint>({
  title,
  description,
  descriptionShort,
  data,
  series,
  domain,
  valueFormatter = defaultFormat,
  empty,
  badge,
  className,
}: VersionCurveCardProps<T>) {
  const chartConfig = React.useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    for (const entry of series) config[entry.key] = { label: entry.label, color: entry.color };
    return config;
  }, [series]);

  // The axis reads a string, so the tick is `v3` rather than `3` and two
  // The fitted axis, and the sentence that discloses it. A caller that passes
  // its own `domain` gets that one and no note.
  const fitted = React.useMemo<[number, number] | null>(() => {
    if (domain) return null;
    const values: number[] = [];
    for (const point of data) {
      for (const entry of series) {
        const value = seriesValue(point, entry.key);
        if (value !== null) values.push(value);
      }
    }
    if (values.length === 0) return null;
    const low = Math.min(...values);
    const high = Math.max(...values);
    // A margin of a tenth of the spread, but never less than half a tenth of
    // the scale, so a single version does not sit on a zero-height axis.
    const margin = Math.max((high - low) * 0.1, 0.05);
    return [
      Math.max(0, Math.floor((low - margin) * 100) / 100),
      Math.min(1, Math.ceil((high + margin) * 100) / 100),
    ];
  }, [data, series, domain]);

  // versions never blur into a decimal axis on a narrow card.
  const rows = React.useMemo(
    () =>
      data.map((point) => ({
        ...point,
        tick: axisLabel(point),
      })),
    [data],
  );

  return (
    <Card className={cn('@container/card', className)}>
      <CardHeader>
        <Fade asChild>
          <CardTitle>{title}</CardTitle>
        </Fade>
        {description !== undefined ? (
          <Fade asChild delay={50}>
            <CardDescription>
              {descriptionShort !== undefined ? (
                <>
                  <span className="hidden @[540px]/card:block">{description}</span>
                  <span className="@[540px]/card:hidden">{descriptionShort}</span>
                </>
              ) : (
                description
              )}
              {fitted ? (
                <span className="block">
                  The axis is fitted to the observed range ({fitted[0].toFixed(2)} to{' '}
                  {fitted[1].toFixed(2)}), not anchored at zero.
                </span>
              ) : null}
            </CardDescription>
          </Fade>
        ) : null}
        {badge ? (
          <Fade asChild delay={100}>
            <CardAction className="flex items-center gap-2">{badge}</CardAction>
          </Fade>
        ) : null}
      </CardHeader>
      <Fade asChild delay={150}>
        <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
          {rows.length === 0 ? (
            <Fade>{empty}</Fade>
          ) : (
            <>
              {/*
                The same split the trend card makes: the drawing is a set of
                <path> elements and says nothing out loud, so it is hidden from
                screen readers and the table below is its text version. Nothing
                in the chart is operable, so nothing is lost by hiding it.
              */}
              <ChartContainer
                config={chartConfig}
                aria-hidden="true"
                className="aspect-auto h-[250px] w-full"
              >
                <LineChart data={rows} margin={{ left: 4, right: 12 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="tick" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={40}
                    domain={domain ?? fitted ?? [0, 1]}
                    tickCount={4}
                    tickFormatter={(value) => valueFormatter(value as number)}
                  />
                  {/*
                    The stock tooltip, on purpose: a `formatter` of our own
                    replaces the whole row in `ChartTooltipContent`, colour
                    swatch included, and with two lines per slot sharing one
                    colour the swatch is what tells a line from its neighbour.
                    `valueFormatter` therefore shapes the axis and the table,
                    and the tooltip prints the stock value.
                  */}
                  <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
                  {series.map((entry) => (
                    <Line
                      key={entry.key}
                      dataKey={entry.key}
                      // A level, read once per version: straight segments
                      // between the points, no interpolation that invents a
                      // shape between two measurements.
                      type="linear"
                      stroke={`var(--color-${entry.key})`}
                      strokeWidth={2}
                      strokeDasharray={entry.dashed ? '4 4' : undefined}
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                      connectNulls
                    />
                  ))}
                  {series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
                </LineChart>
              </ChartContainer>
              <table className="sr-only">
                <caption>{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    {series.map((entry) => (
                      <th key={entry.key} scope="col">
                        {entry.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((point) => (
                    <tr key={point.version}>
                      <th scope="row">{point.tick}</th>
                      {series.map((entry) => {
                        const value = seriesValue(point, entry.key);
                        return (
                          <td key={entry.key}>{value === null ? 'not measured' : valueFormatter(value)}</td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </CardContent>
      </Fade>
    </Card>
  );
}
