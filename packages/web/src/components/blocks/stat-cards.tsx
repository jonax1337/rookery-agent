import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The headline number row from `dashboard-01/components/section-cards.tsx`.
 *
 * Grid and typography are verbatim - the container-query column counts
 * (`@xl/main:grid-cols-2`, `@5xl/main:grid-cols-4`) and the card gradient are
 * what make the row read as the block it came from.
 *
 * What is NOT here is the trend badge. The original's "+12.5% gegenüber
 * Vormonat" needs a previous-period value, and the server has none: nothing
 * in the API returns a comparison window (see serverGaps). A percentage
 * invented on the client would be the most convincing lie on the page, so
 * `CardAction` takes only badges the calling page can actually prove - "3
 * laufen", "gedeckelt", "+4 in 7 Tagen" - and a card whose number rests on a
 * capped list says so in its footnote.
 */

export interface StatCardProps {
  /** The small line above the number. Plain text: it doubles as the link label. */
  label: string;
  /** The number itself, already formatted (`formatNumber` from `@/lib/stats`). */
  value: ReactNode;
  /** Provable badge only - a count, a state, "gedeckelt". Never a trend. */
  badge?: ReactNode;
  /** First footer line: the sentence the number tells. */
  headline?: ReactNode;
  /** Second footer line: where the number comes from, when that is not obvious. */
  footnote?: ReactNode;
  /** Turns the whole card into a link to the page that owns the number. */
  to?: string;
  className?: string;
}

export function StatCard({ label, value, badge, headline, footnote, to, className }: StatCardProps) {
  const hasFooter = headline !== undefined || footnote !== undefined;

  return (
    <Card className={cn('@container/card', to && 'relative', className)}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
          {value}
        </CardTitle>
        {badge ? <CardAction>{badge}</CardAction> : null}
      </CardHeader>
      {hasFooter ? (
        <CardFooter className="flex-col items-start gap-1.5 text-sm">
          {headline !== undefined ? (
            <div className="line-clamp-1 flex gap-2 font-medium">{headline}</div>
          ) : null}
          {footnote !== undefined ? <div className="text-muted-foreground">{footnote}</div> : null}
        </CardFooter>
      ) : null}
      {/*
        The link is an overlay rather than a wrapper: the grid styles its
        *direct* children (`*:data-[slot=card]:...`), so wrapping the card in a
        NavLink would quietly drop the gradient and the shadow.
      */}
      {to ? (
        <NavLink
          to={to}
          aria-label={label}
          className="absolute inset-0 z-10 rounded-xl transition-colors outline-none hover:bg-foreground/[0.03] focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      ) : null}
    </Card>
  );
}

export interface StatCardsProps {
  /** The cards, in reading order. */
  items?: readonly StatCardProps[];
  /** Alternative to `items` when a card needs markup a prop cannot carry. */
  children?: ReactNode;
  className?: string;
}

export function StatCards({ items, children, className }: StatCardsProps) {
  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card',
        className,
      )}
    >
      {items?.map((item) => <StatCard key={item.label} {...item} />)}
      {children}
    </div>
  );
}

/**
 * The badge a number wears when it is not the whole truth.
 *
 * Six cards typed `<Badge variant="outline">gedeckelt</Badge>` out by hand, in
 * two spellings - four as a conditional spread, two as `badge={… : undefined}`.
 * This is the one place the app admits that a count rests on a list that hit
 * the server limit, so it belongs in one place.
 *
 * Returns a spreadable object, which covers both call shapes:
 * `<StatCard … {...cappedBadge(loaded >= LIMIT)} />`.
 */
export function cappedBadge(capped: boolean): Pick<StatCardProps, 'badge'> {
  if (!capped) return {};
  return { badge: <Badge variant="outline">gedeckelt</Badge> };
}

/**
 * The stat row while it is still loading, in the geometry it will have.
 *
 * Three detail pages drew this by hand next to the real row. A skeleton that
 * lives anywhere but next to the component it imitates drifts away from it the
 * first time the card changes.
 */
export function StatCardsSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <StatCards>
      {Array.from({ length: cards }, (_, index) => (
        <Card key={index} className="@container/card">
          <CardHeader>
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-2 h-8 w-20" />
          </CardHeader>
          <CardFooter>
            <Skeleton className="h-4 w-32" />
          </CardFooter>
        </Card>
      ))}
    </StatCards>
  );
}
