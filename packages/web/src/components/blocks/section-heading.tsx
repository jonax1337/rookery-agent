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
  className?: string;
}

export function SectionHeading({
  title,
  hint,
  children,
  flush = false,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <Fade className={flush ? undefined : 'px-4 lg:px-6'} delay={50}>
        <h2 className="text-base font-medium">{title}</h2>
        {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      </Fade>
      {children}
    </div>
  );
}
