import { XIcon } from "@/components/icons";
import type { ReactNode } from 'react';


import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * A chosen value as a chip it can be taken back out of again.
 *
 * "Value plus X" was spelled three ways - a Badge with a bare button, a Badge
 * with a sized button, once two spans and a click target - so the hit area and
 * the hover colour differed per page. One spelling now, built on the Badge so
 * the chip keeps the badge's own inline-icon padding: the X carries
 * `data-icon="inline-end"`, which the Badge answers with `pr-1.5`, and the X
 * glyph itself needs no size class - it draws in the middle of its box, so it
 * reads right inside the badge's fixed height.
 *
 * The spoken name matters more than the glyph: a table of chips whose buttons
 * all say "X" tells a screen reader nothing, so the label defaults to
 * "Remove " + label and `removeLabel` takes over whenever the label is not
 * plain text.
 */

export function RemovableChip({
  label,
  onRemove,
  removeLabel,
  className,
}: {
  label: ReactNode;
  onRemove: () => void;
  /** Spoken when the label itself is not plain text ("Remove " + label otherwise). */
  removeLabel?: string;
  className?: string;
}) {
  return (
    <Badge variant="secondary" className={cn('gap-1', className)}>
      {label}
      <button
        type="button"
        aria-label={removeLabel ?? (typeof label === 'string' ? `Remove ${label}` : undefined)}
        className="rounded-full hover:text-destructive"
        onClick={onRemove}
      >
        <XIcon data-icon="inline-end" />
      </button>
    </Badge>
  );
}
