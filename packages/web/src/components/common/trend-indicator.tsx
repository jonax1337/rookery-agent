import { ArrowRightIcon, TrendingDownIcon, TrendingUpIcon } from "@/components/icons";

import { cn } from '@/lib/utils';
import type { IconComponent } from "@/components/icons";

/**
 * The rolling trend of an agent's reviews: one arrow, one signed number.
 *
 * Two pages had typed this out by hand and the copies had drifted - the HR
 * table coloured the rising case `emerald-600/400` while the performance card
 * already used the palette's status green, and each re-decided the threshold.
 * Both decisions live here now: more than ±0.05 is movement, everything inside
 * that band is noise and renders as a muted flat arrow.
 *
 * `trend === null` renders nothing. The empty case stays the caller's job
 * because the two pages say it differently - a dash in the table's cell, no
 * baseline row on the card at all.
 */

export function TrendIndicator({
  trend,
  size = 'default',
  align = 'start',
}: {
  trend: number | null;
  /** `sm` for a dense table cell, `default` for the performance card's baseline row. */
  size?: 'sm' | 'default';
  /** `end` right-aligns the whole indicator, as a numeric table column needs. */
  align?: 'start' | 'end';
}) {
  if (trend === null) return null;

  // Flat is a right arrow: the registry has no plain minus, and an arrow
  // pointing neither up nor down says "stagnant" the way dashboards do.
  const Icon: IconComponent =
    trend > 0.05 ? TrendingUpIcon : trend < -0.05 ? TrendingDownIcon : ArrowRightIcon;
  const tone =
    trend > 0.05
      ? 'text-status-ok'
      : trend < -0.05
        ? 'text-destructive'
        : 'text-muted-foreground';

  return (
    <span
      className={cn(
        'flex items-center gap-1 tabular-nums',
        tone,
        size === 'default' && 'text-sm',
        align === 'end' && 'justify-end',
      )}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} aria-hidden="true" />
      {(trend >= 0 ? '+' : '') + trend.toFixed(1)}
    </span>
  );
}
