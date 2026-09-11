import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { Item, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';

/**
 * One line of "what hangs on this record", as the three company drawers draw
 * it: a framed row that is entirely a link, the name above, one muted line
 * below, and whatever badge the caller wants on the right.
 *
 * Deliberately only the row. The drawers keep their own `.map` and their own
 * `EmptyState`, because only one of the three has anything to load - a generic
 * list with loading and error states would force two pages into states they do
 * not have.
 */

export interface RelatedItemProps {
  to: string;
  title: ReactNode;
  description?: ReactNode;
  /** Right-hand slot: a `StatusBadge`, a count, a timestamp. */
  trailing?: ReactNode;
}

export function RelatedItem({ to, title, description, trailing }: RelatedItemProps) {
  return (
    <Item variant="outline" size="sm" asChild>
      <NavLink to={to}>
        <ItemContent>
          <ItemTitle className="font-normal">{title}</ItemTitle>
          {description === undefined ? null : <ItemDescription>{description}</ItemDescription>}
        </ItemContent>
        {trailing}
      </NavLink>
    </Item>
  );
}
