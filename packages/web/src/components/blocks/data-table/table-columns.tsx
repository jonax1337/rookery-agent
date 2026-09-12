import type { ReactNode } from 'react';
import type { RowData } from '@tanstack/react-table';

import { Checkbox } from '@/components/ui/checkbox';
import { formatDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';

import { createRookeryColumnHelper, type RookeryColumnDef, type RookeryRow } from './table-features';

/**
 * The three pieces every Rookery table repeated by hand.
 *
 * The selection column stood in nine pages, the actions column in fourteen and
 * the relative-time cell in ten - each copy a little different from the last.
 * They live here rather than in `table-features.ts` because that file is plain
 * `.ts` and holds no JSX.
 *
 * Nothing here invents behaviour: `DEFAULT_IGNORED_COLUMNS` in `data-table.tsx`
 * already knows the ids `select` and `actions`, so a row click keeps skipping
 * both.
 */

/* ------------------------------- selection ------------------------------- */

export interface SelectionColumnOptions<TData> {
  /**
   * Accessible name of a row's checkbox. Defaults to the block's own
   * "Zeile wählen"; pass one when the row has a name worth reading out
   * ("Aktenzeichen 42 wählen").
   */
  rowLabel?: (row: TData) => string;
  /** Accessible name of the header checkbox. */
  allLabel?: string;
}

/**
 * The checkbox column, in the centred shape `dashboard-01` ships.
 *
 * The nine hand-written copies agreed on everything but the labels - except
 * the conversations list, which had lost the centring wrapper and drew its
 * checkbox flush left. That copy is the one that changes: the block's centred
 * version wins, because eight of nine pages already look like it.
 */
export function selectionColumn<TData extends RowData>(
  options: SelectionColumnOptions<TData> = {},
): RookeryColumnDef<TData> {
  const column = createRookeryColumnHelper<TData>();
  const { rowLabel, allLabel = 'Select all rows' } = options;

  return column.display({
    id: 'select',
    header: ({ table }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label={allLabel}
        />
      </div>
    ),
    cell: ({ row }) => (
      <div className="flex items-center justify-center">
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={(value) => row.toggleSelected(!!value)}
          aria-label={rowLabel ? rowLabel((row as RookeryRow<TData>).original) : 'Select row'}
        />
      </div>
    ),
    enableSorting: false,
    enableHiding: false,
  });
}

/* -------------------------------- actions -------------------------------- */

export interface ActionsColumnOptions {
  /**
   * What a screen reader hears instead of the empty head. "Aktionen" for a row
   * menu, "Bericht" where the column holds a single report button.
   */
  header?: string;
  /** The column id, for the rare page that stacks two action columns. */
  id?: string;
}

/**
 * The trailing column that holds a row's menu or its one button.
 *
 * Always last, never sortable, never hideable - a column the reader cannot see
 * has no menu to reach.
 */
export function actionsColumn<TData extends RowData>(
  cell: (row: TData) => ReactNode,
  options: ActionsColumnOptions = {},
): RookeryColumnDef<TData> {
  const column = createRookeryColumnHelper<TData>();
  const { header = 'Actions', id = 'actions' } = options;

  return column.display({
    id,
    header: () => <span className="sr-only">{header}</span>,
    cell: ({ row }) => cell((row as RookeryRow<TData>).original),
    enableSorting: false,
    enableHiding: false,
  });
}

/* --------------------------------- cells --------------------------------- */

/**
 * The one character a table cell uses when it has nothing to show.
 *
 * A half-em dash, the way ten of eleven lists already write it. Whole
 * sentences ("Keine Beschreibung") belong in an `EmptyState`, not in a cell.
 */
export const EMPTY_CELL = '–';

/** The empty value as a cell, muted and aligned with the rest of the column. */
export function emptyCell(align: 'start' | 'end' = 'start'): ReactNode {
  return (
    <span className={cn('text-muted-foreground', align === 'end' && 'block text-right')}>
      {EMPTY_CELL}
    </span>
  );
}

export interface RelativeTimeCellOptions {
  /** What stands there when the timestamp is missing. */
  fallback?: string;
  /** `end` right-aligns the value; the header carries the same `align`. */
  align?: 'start' | 'end';
}

/**
 * A timestamp as "vor 5 Min." would be too long for a column, so the cell keeps
 * the bare span `relativeTime` gives it - and puts the exact date in the title,
 * which is what four of the ten hand-written copies did and six forgot.
 *
 * `tabular-nums` keeps a column of spans from jittering; a missing timestamp
 * gets the fallback word and no title, because there is no date to reveal.
 */
export function relativeTimeCell(
  at: number | null | undefined,
  options: RelativeTimeCellOptions = {},
): ReactNode {
  const { fallback = 'never', align = 'start' } = options;
  const className = cn(
    'whitespace-nowrap text-muted-foreground tabular-nums',
    align === 'end' && 'block text-right',
  );

  if (!at) return <span className={className}>{fallback}</span>;
  return (
    <span className={className} title={formatDateTime(at)}>
      {relativeTime(at)}
    </span>
  );
}
