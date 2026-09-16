import * as React from 'react';


import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import {
  GripVerticalIcon as EllipsisVertical,
  GripVerticalIcon as EllipsisVerticalIcon,
} from "@/components/icons";
/**
 * The three-dot trigger, in the two places it actually belongs.
 *
 * It was typed out seventeen times and had split into five looks. Two of those
 * places are genuinely different, so this keeps two and drops the other three:
 *
 * - `tone="row"` - the quiet glyph at the end of a table row. Eleven lists,
 *   32 px, muted, and it takes the muted background while the menu is open.
 *   Dense rows keep the plain lucide glyph - no per-row motion.
 * - `tone="header"` - the overflow next to a detail page's `ButtonGroup`. It
 *   has to read as part of that group, so it is outlined like its neighbours.
 *   This one glyph is the animate-ui twin: it swings its dots in once when it
 *   enters the view (`animateOnView`, the button mutes pointer events on its
 *   svg, so hover or tap triggers could never fire) and lands on the same
 *   three dots, because they are rotation-symmetric.
 *
 * One glyph for the gesture: `EllipsisVerticalIcon`. `MoreVerticalIcon` draws
 * the same three dots under a second name and is retired here.
 *
 * The name is always spoken: `aria-label` rather than an `sr-only` span, and
 * it names the record ("Aktionen für Nachtlauf"), because a table of fifty
 * rows that says "Menü öffnen" fifty times tells a screen reader nothing.
 */

export interface RowMenuButtonProps
  extends Omit<React.ComponentProps<typeof Button>, 'variant' | 'size' | 'children'> {
  /** Spoken name. Write it as "Aktionen für " + the record's name. */
  label: string;
  /** Which of the two places this trigger sits in. */
  tone?: 'row' | 'header';
  /** Swaps the glyph for a spinner while the row's own action runs. */
  busy?: boolean;
}

export function RowMenuButton({
  label,
  tone = 'row',
  busy = false,
  className,
  ...props
}: RowMenuButtonProps) {
  return (
    <Button
      variant={tone === 'header' ? 'outline' : 'ghost'}
      size="icon-sm"
      aria-label={label}
      className={cn(
        tone === 'row' && 'text-muted-foreground data-[state=open]:bg-muted',
        className,
      )}
      {...props}
    >
      {busy ? (
        <Spinner />
      ) : tone === 'header' ? (
        <EllipsisVertical className="size-4" />
      ) : (
        <EllipsisVerticalIcon />
      )}
    </Button>
  );
}
