import type * as React from 'react';
import { NavLink } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Key and value, the way the detail pages should have said it all along.
 *
 * Every detail page currently glues its facts into one muted line with
 * `' · '` between them - unreadable past three facts, unlabelled, and
 * impossible to link. This lays them out as `Item` rows instead: the label
 * small above, the value below, one row per fact.
 *
 * A fact with nothing in it is dropped rather than printed as a dash, so a
 * page can hand over its full list and let the data decide what shows.
 */

export interface MetaItem {
  label: string;
  /**
   * Anything renderable. `null`, `undefined` and the empty string drop the
   * row entirely - that is how an optional field opts out.
   */
  value: React.ReactNode;
  icon?: LucideIcon;
  /** Turns the value into a link to a route. */
  to?: string;
  /** Ids, paths and cron expressions read better in the mono face. */
  mono?: boolean;
}

export interface MetaListProps {
  items: readonly MetaItem[];
  /**
   * How many facts sit side by side on a wide screen. One column is the
   * drawer, two the detail page, three a header strip.
   */
  columns?: 1 | 2 | 3;
  /** `outline` frames each fact; `plain` lets them float on the card. */
  variant?: 'plain' | 'outline' | 'muted';
  size?: 'default' | 'sm';
  className?: string;
}

const COLUMNS: Record<1 | 2 | 3, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 @md/main:grid-cols-2',
  3: 'grid-cols-1 @md/main:grid-cols-2 @3xl/main:grid-cols-3',
};

export function MetaList({
  items,
  columns = 2,
  variant = 'outline',
  size = 'sm',
  className,
}: MetaListProps) {
  const shown = items.filter(
    (item) => item.value !== null && item.value !== undefined && item.value !== '',
  );
  if (shown.length === 0) return null;

  return (
    <Fade asChild>
      <ItemGroup className={cn('grid gap-2', COLUMNS[columns], className)}>
        {shown.map((item) => (
          <Item key={item.label} variant={variant === 'plain' ? 'default' : variant} size={size} className="min-w-0">
            {item.icon && (
              <ItemMedia variant="icon">
                <item.icon className="text-muted-foreground" />
              </ItemMedia>
            )}
            <ItemContent className="min-w-0">
              <ItemDescription className="text-xs">{item.label}</ItemDescription>
              <ItemTitle className={cn('max-w-full min-w-0 break-words font-normal', item.mono && 'font-mono text-xs')}>
                {item.to ? (
                  <NavLink to={item.to} className="hover:underline">
                    {item.value}
                  </NavLink>
                ) : (
                  item.value
                )}
              </ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </Fade>
  );
}

/**
 * The fact rows while the record is still loading.
 *
 * Three detail pages drew this grid by hand, character for character. Keeping
 * it next to `MetaList` is what stops the placeholder from drifting away from
 * the thing it stands in for - the column counts have to match, or the header
 * jumps the moment the request comes back.
 */
export function MetaListSkeleton({
  rows = 4,
  columns = 2,
  className,
}: {
  rows?: number;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  return (
    <Fade asChild>
      <div className={cn('grid gap-2', COLUMNS[columns], className)} aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </Fade>
  );
}
