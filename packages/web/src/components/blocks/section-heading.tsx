import type { ReactNode } from 'react';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { cn } from '@/lib/utils';

/**
 * The heading over a second table on a page.
 *
 * A page that stacks two tables has to say which is which. Three pages did
 * that in three sizes - `text-base font-medium`, `text-lg font-semibold
 * tracking-tight`, and once not at all. The first wins: it is the quieter of
 * the two, and a section head inside a page must not compete with the page
 * title in the header strip.
 *
 * `size="sm"` is the drawer-section spelling. Four pages had typed that out
 * as an `<h3 className="text-sm font-medium">` - once with `mb-2`, once
 * bare, once through this component at full size - so a drawer body came out
 * in three rhythms. The smaller title comes with a tighter column (`gap-2`
 * instead of `gap-4`), because a drawer is half the width and the full gap
 * reads as empty space between its sections.
 *
 * `level` keeps the drawer variant honest in the heading map: a drawer's own
 * title is vaul's `DrawerTitle`, an `<h2>`, so sections inside it must be
 * `h3` to stay one level below. Pages keep the default `h2`.
 *
 * The `px-4 lg:px-6` is the block's own gutter, so the heading lines up with
 * the table underneath it; `flush` drops it inside a card.
 */

export interface SectionHeadingProps {
  title: string;
  /** One line under the title. What this table is, not that it is a table. */
  hint?: string;
  /** The table (or whatever else) the heading introduces. */
  children?: ReactNode;
  flush?: boolean;
  /** `sm` is the drawer-section style: smaller title, tighter column. */
  size?: 'default' | 'sm';
  /** Heading level. `h3` in drawers: their `DrawerTitle` is an `h2`. */
  level?: 'h2' | 'h3';
  className?: string;
}

export function SectionHeading({
  title,
  hint,
  children,
  flush = false,
  size = 'default',
  level = 'h2',
  className,
}: SectionHeadingProps) {
  const small = size === 'sm';
  const Heading = level;
  return (
    <div className={cn('flex flex-col', small ? 'gap-2' : 'gap-4', className)}>
      <Fade className={flush ? undefined : 'px-4 lg:px-6'} delay={50}>
        <Heading className={small ? 'text-sm font-medium' : 'text-base font-medium'}>{title}</Heading>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </Fade>
      {children}
    </div>
  );
}
