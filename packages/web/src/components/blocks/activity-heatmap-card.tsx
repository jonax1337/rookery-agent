import { useMemo } from 'react';

import * as HeatGraph from 'heat-graph';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { dayKey, formatDate, formatNumber } from '@/lib/stats';
import type { StatsDay } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * A contribution graph of the company's activity, drawn by `heat-graph`
 * (assistant-ui's headless heatmap package - the same house as the chat
 * primitives, so the dependency is not a new direction, just a new room).
 *
 * The package computes the week grid, the levels and the tooltip wiring and
 * deliberately leaves every colour, size and label to the host. That is what
 * buys a heatmap that reads as Rookery rather than as GitHub: level 0 is
 * `--secondary`, the four intensity steps are `--chart-1` - the amber the
 * app's charts draw with - mixed with rising opacity, so light and dark mode
 * come along without a second palette.
 *
 * Decisions worth writing down:
 *
 * - The intensity is `messages` per day. Sessions and assignments move by
 *   ones and twos; a grid whose busiest day is "3" shades like an empty one.
 *   Message volume is the one count that tells a quiet Tuesday from a loud
 *   one, and the tooltip still reads out all three.
 * - The window is exactly the series the page already fetched - no second
 *   request. The package snaps the start back to a Monday, so the first
 *   column can reach a few days before the window; those cells carry no
 *   count and draw as empty, which is the honest reading of "nothing was
 *   counted here".
 * - Levels use the package default (`autoLevels(5)`): each day is scaled
 *   against the busiest day of the window, the way GitHub does it. Absolute
 *   thresholds would need a calibration this data does not argue for.
 * - The cells are perfect squares, the way GitHub's and ChatGPT's are: the
 *   grid keeps its natural width - fifty-three week columns at a fixed cell
 *   edge - and is centred in the card. A screen too narrow for a whole year
 *   scrolls instead of stretching, because a wide flat cell reads as a bar,
 *   not as a day.
 * - The graph is `aria-hidden`, and the card carries its own screen-reader
 *   table under it - the same per-day numbers, so the calendar never has to
 *   be parsed by ear to be known.
 */

/** Cell edge in px - every cell is a square of this size. */
const CELL = 12;
const GAP = 3;
const STEP = CELL + GAP;

/**
 * The weekday gutter the labels live in. The month labels sit on the same
 * offset, one flex gap further right, so both columns start on the grid.
 */
const DAY_GUTTER = 30;
const GRID_LEFT = DAY_GUTTER + 8;

const HEAT_COLORS = [
  'var(--secondary)',
  'color-mix(in oklab, var(--chart-1) 30%, transparent)',
  'color-mix(in oklab, var(--chart-1) 55%, transparent)',
  'color-mix(in oklab, var(--chart-1) 80%, transparent)',
  'var(--chart-1)',
];

export interface ActivityHeatmapCardProps {
  /** The gap-filled day series (`fillDayGaps` over `GET /api/stats`). */
  data: readonly StatsDay[];
  className?: string;
}

export function ActivityHeatmapCard({ data, className }: ActivityHeatmapCardProps) {
  // Per-day numbers for the tooltip. The package hands out only the cell's
  // own count, so the rest of the day is looked up here, keyed the way the
  // series is keyed.
  const byDay = useMemo(
    () => new Map(data.map((day) => [day.day, day])),
    [data],
  );

  // Week columns the grid will draw: the package snaps the window start back
  // to Monday before laying out, so the lead days of the first week count.
  const weeks = useMemo(() => {
    if (data.length === 0) return 0;
    const [year, month, day] = data[0]?.day.split('-').map(Number) ?? [];
    const start = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
    const lead = (start.getDay() + 6) % 7; // days since Monday, the chosen week start
    return Math.ceil((lead + data.length) / 7);
  }, [data]);

  const total = useMemo(
    () => data.reduce((sum, day) => sum + day.messages, 0),
    [data],
  );

  // A year-long window reads better as "the last year"; a young database's
  // short series keeps its day count.
  const windowLabel = data.length >= 330 ? 'the last year' : `the last ${data.length} days`;

  // An empty series would draw a card with no grid in it; the trend card
  // above already carries the empty state for that case.
  if (weeks === 0) return null;

  return (
    <Card className={cn('@container/card', className)}>
      <CardHeader>
        <Fade asChild>
          <CardTitle>Activity heatmap</CardTitle>
        </Fade>
        <Fade asChild delay={50}>
          <CardDescription>
            <span className="hidden @[540px]/card:block">
              Message volume per day, {windowLabel}. Hover a day for its numbers.
            </span>
            <span className="@[540px]/card:hidden">Message volume per day</span>
          </CardDescription>
        </Fade>
      </CardHeader>
      <Fade asChild delay={100}>
        <CardContent className="px-2 sm:px-6">
          <HeatGraph.Root
            data={data.map((day) => ({ date: day.day, count: day.messages }))}
            start={data[0]?.day}
            end={data[data.length - 1]?.day}
            weekStart="monday"
            colorScale={HEAT_COLORS}
            aria-hidden="true"
          >
            <div className="flex flex-col gap-1.5">
              {/*
                The calendar keeps its natural width and is centred, the way
                GitHub's is: a whole year of squares is a fixed-size object,
                not something to pour into whatever width the card has. A
                screen too narrow for it scrolls - centred with `mx-auto`
                rather than flex centring, so a scroll never clips the left
                edge off.
              */}
              <div className="overflow-x-auto w-full">
                <div className="w-full">
                  {/*
                    Month names over the columns they begin in. The row is
                    laid out by hand rather than by grid because the labels
                    mark positions, not slots - the same trick GitHub's own
                    graph uses. Below a half-card wide, the block scrolls
                    under the card's overflow and the labels would smear, so
                    the row steps aside there.
                  */}
                  <div
                    className="relative h-4 hidden @[540px]/card:block"
                    style={{ marginLeft: GRID_LEFT }}
                  >
                    <HeatGraph.MonthLabels>
                      {({ label }) => (
                        <span
                          key={`${label.month}-${label.column}`}
                          className="absolute top-0 text-[10px] leading-4 font-medium text-muted-foreground"
                          style={{ left: label.column * STEP }}
                        >
                          {HeatGraph.MONTH_SHORT[label.month] ?? ''}
                        </span>
                      )}
                    </HeatGraph.MonthLabels>
                  </div>
                  <div className="flex items-center justify-center gap-2 w-full">
                    {/*
                      Weekday initials in the gutter, every other row - Monday,
                      Wednesday, Friday, like the graph this layout imitates.
                      The labels sit in a grid with the same row template as
                      the cells, so rows line up by construction.
                    */}
                    <div
                      className="grid shrink-0 justify-items-end"
                      style={{
                        width: DAY_GUTTER,
                        gridTemplateRows: `repeat(7, ${CELL}px)`,
                        rowGap: GAP,
                      }}
                    >
                      <HeatGraph.DayLabels>
                        {({ label }) =>
                          label.row % 2 === 0 && label.row < 5 ? (
                            <span
                              style={{ gridRow: label.row + 1 }}
                              className="text-[10px] leading-none text-muted-foreground"
                            >
                              {HeatGraph.DAY_SHORT[label.dayOfWeek] ?? ''}
                            </span>
                          ) : null
                        }
                      </HeatGraph.DayLabels>
                    </div>
                    <HeatGraph.Grid
                      style={{
                        gridTemplateColumns: `repeat(${weeks}, ${CELL}px)`,
                        gridTemplateRows: `repeat(7, ${CELL}px)`,
                        gap: GAP,
                      }}
                    >
                      {() => <HeatGraph.Cell className="rounded-[2px]" />}
                    </HeatGraph.Grid>
                  </div>
                </div>
              </div>
              <div
                className="flex items-center justify-between pt-1 text-[10px] text-muted-foreground"
                style={{ paddingLeft: GRID_LEFT }}
              >
                <span>
                  {formatNumber(total)} messages in {windowLabel}
                </span>
                <div className="flex items-center gap-1.5">
                  <span>Less</span>
                  <HeatGraph.Legend>
                    {({ item }) => (
                      <HeatGraph.LegendLevel
                        key={item.level}
                        className="size-[11px] rounded-[2px]"
                        style={{ backgroundColor: item.color }}
                      />
                    )}
                  </HeatGraph.Legend>
                  <span>More</span>
                </div>
              </div>
            </div>
            {/*
              Radix popper content, unstyled by the package - the popover
              look comes from the card tokens. Rendered without a portal, it
              stays inside the card and dies with the hover that opened it.
            */}
            <HeatGraph.Tooltip className="z-50 rounded-lg border bg-popover px-3 py-2 shadow-md">
              {({ cell }) => {
                const entry = byDay.get(dayKey(cell.date));
                const messages = entry?.messages ?? 0;
                const sessions = entry?.sessions ?? 0;
                const assignments = entry?.assignments ?? 0;
                return (
                  <div className="flex flex-col gap-0.5">
                    <div className="text-xs font-medium">{formatDate(cell.date)}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {messages + sessions + assignments > 0
                        ? `${formatNumber(messages)} messages · ${formatNumber(sessions)} conversations · ${formatNumber(assignments)} assignments`
                        : 'No activity'}
                    </div>
                  </div>
                );
              }}
            </HeatGraph.Tooltip>
          </HeatGraph.Root>
          {/*
            The numbers the calendar shades. The graph above is aria-hidden,
            so this table is the only thing a screen reader gets - the same
            bargain the trend cards on the other pages strike.
          */}
          <table className="sr-only">
            <caption>Activity heatmap - message volume per day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Messages</th>
                <th scope="col">Conversations</th>
                <th scope="col">Assignments</th>
              </tr>
            </thead>
            <tbody>
              {data.map((day) => (
                <tr key={day.day}>
                  <th scope="row">{formatDate(day.day)}</th>
                  <td>{formatNumber(day.messages)}</td>
                  <td>{formatNumber(day.sessions)}</td>
                  <td>{formatNumber(day.assignments)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Fade>
    </Card>
  );
}
