import type { ReactNode } from 'react';

import { DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  relativeTimeCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import type { RookeryColumnDef } from '@/components/blocks/data-table/table-features';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { MEMORY_KIND_LABEL, ORIGIN_LABEL } from '@/lib/format';
import { formatNumber, formatPercent } from '@/lib/stats';
import type { MemoryRecord } from '@/lib/types';

/**
 * The memory table, defined once.
 *
 * Two pages showed the same rows - the memory list and the agent's memory tab -
 * and all four shared cells looked different: the kind as an outline badge
 * against a secondary one, the origin as a badge against a bare span, and,
 * worst, the same number under two names in two units. `importance` was
 * "Wichtigkeit" at "73 %" on one page and "Gewicht" at "0,73" on the other.
 *
 * "Wichtigkeit" at a percentage wins. The field is a 0..1 weight the reader
 * never sets by hand, so the only question it answers is "how much does this
 * count", and a percentage answers that; "0,73" asks the reader to know the
 * scale. The outline badges win because that is the badge this project uses
 * for a classification it did not assign itself.
 */

export const MEMORY_COLUMN_LABELS: Record<string, string> = {
  content: 'Content',
  kind: 'Type',
  importance: 'Importance',
  origin: 'Source',
  accessCount: 'Accesses',
  lastAccessedAt: 'Last used',
  createdAt: 'Learned',
  state: 'Status',
  score: 'Matches',
  feedback: 'Feedback',
};

/** Newest weight first - the list opens on what matters most. */
export const MEMORY_SORTING = [{ id: 'importance', desc: true }];

export interface MemoryColumnsOptions {
  /** Prepends the checkbox column. */
  selectable?: boolean;
  /** Makes the content cell open the drawer. Without it it is plain text. */
  onOpen?(memory: MemoryRecord): void;
  /** Ids the last recall surfaced; those rows read as emphasised. */
  highlighted?: ReadonlySet<string>;
  /**
   * The agent page's short form: kind, content, weight, origin and when it was
   * learned. No usage counts, no state badges.
   */
  compact?: boolean;
  /** Renders the page's own state badges (dormant, pinned, superseded). */
  state?(memory: MemoryRecord): ReactNode;
  /**
   * Adds the "Treffer" column. Only a search produces a score, so an
   * always-empty column would read as a ranking that failed.
   */
  score?(memory: MemoryRecord): { value: number; reason: string } | null;
  /**
   * Adds the "Feedback" column: a "was the point / was ballast" control on
   * each row this turn's recall highlighted (concept 4.2b, S6). Returning
   * `null` renders the column's own empty cell - a row recall did not just
   * surface gets no vote.
   */
  feedback?(memory: MemoryRecord): ReactNode;
  /** Adds the trailing menu column. */
  rowActions?(memory: MemoryRecord): ReactNode;
}

export function buildMemoryColumns(
  options: MemoryColumnsOptions = {},
): RookeryColumnDef<MemoryRecord>[] {
  const {
    selectable = false,
    onOpen,
    highlighted,
    compact = false,
    state,
    score,
    feedback,
    rowActions,
  } = options;

  const column = createRookeryColumnHelper<MemoryRecord>();
  const columns: RookeryColumnDef<MemoryRecord>[] = [];

  if (selectable) {
    columns.push(selectionColumn<MemoryRecord>({ rowLabel: () => 'Select memory' }));
  }

  const kindColumn = column.accessor('kind', {
    id: 'kind',
    header: ({ column: col }) => <DataTableColumnHeader column={col} title="Type" />,
    cell: ({ row }) => (
      <Badge variant="outline" className="font-normal">
        {MEMORY_KIND_LABEL[row.original.kind]}
      </Badge>
    ),
  });

  const contentColumn = column.accessor('content', {
    id: 'content',
    header: ({ column: col }) => <DataTableColumnHeader column={col} title="Content" />,
    enableHiding: false,
    cell: ({ row }) => {
      const memory = row.original;
      const emphasis = highlighted?.has(memory.id) ? 'font-medium text-primary' : '';
      if (!onOpen) {
        return <span className={'block min-w-48 max-w-[52ch] whitespace-normal break-words leading-snug ' + emphasis}>{memory.content}</span>;
      }
      return (
        <DetailDrawerTrigger
          className="h-auto max-w-[52ch] py-0 whitespace-normal"
          onClick={() => onOpen(memory)}
        >
          <span className={'line-clamp-2 text-left ' + emphasis}>{memory.content}</span>
        </DetailDrawerTrigger>
      );
    },
  });

  // The agent tab leads with the kind, the list with the text it is about.
  columns.push(...(compact ? [kindColumn, contentColumn] : [contentColumn, kindColumn]));

  columns.push(
    column.accessor('importance', {
      id: 'importance',
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Importance" align="end" />
      ),
      cell: ({ row }) => {
        const percent = Math.round(row.original.importance * 100);
        return (
          <div className="flex items-center justify-end gap-2">
            <Progress value={percent} aria-hidden="true" className="h-1 w-16 shrink-0" />
            <span className="w-12 text-right text-sm tabular-nums">{formatPercent(percent)}</span>
          </div>
        );
      },
    }),

    column.accessor('origin', {
      id: 'origin',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {ORIGIN_LABEL[row.original.origin]}
        </Badge>
      ),
    }),
  );

  if (compact) {
    columns.push(
      column.accessor('createdAt', {
        id: 'createdAt',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Learned" />,
        cell: ({ row }) => relativeTimeCell(row.original.createdAt),
      }),
    );
  } else {
    columns.push(
      column.accessor('accessCount', {
        id: 'accessCount',
        header: ({ column: col }) => (
          <DataTableColumnHeader column={col} title="Accesses" align="end" />
        ),
        cell: ({ row }) => (
          <div className="text-right tabular-nums">{formatNumber(row.original.accessCount)}</div>
        ),
      }),

      column.accessor((memory) => memory.lastAccessedAt ?? 0, {
        id: 'lastAccessedAt',
        header: ({ column: col }) => (
          <DataTableColumnHeader column={col} title="Last used" />
        ),
        cell: ({ row }) => relativeTimeCell(row.original.lastAccessedAt),
      }),
    );
  }

  if (state) {
    columns.push(
      column.display({
        id: 'state',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
        cell: ({ row }) => state(row.original),
      }),
    );
  }

  if (score) {
    columns.push(
      column.accessor((memory) => score(memory)?.value ?? 0, {
        id: 'score',
        header: ({ column: col }) => (
          <DataTableColumnHeader column={col} title="Matches" align="end" />
        ),
        cell: ({ row }) => {
          const hit = score(row.original);
          if (!hit) return emptyCell('end');
          return (
            <div className="flex flex-col items-end">
              <span className="text-sm tabular-nums">{hit.value.toFixed(2)}</span>
              <span className="max-w-[20ch] truncate text-xs text-muted-foreground">
                {hit.reason}
              </span>
            </div>
          );
        },
      }),
    );
  }

  if (feedback) {
    columns.push(
      column.display({
        id: 'feedback',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Feedback" />,
        cell: ({ row }) => feedback(row.original) ?? emptyCell('start'),
      }),
    );
  }

  if (rowActions) columns.push(actionsColumn<MemoryRecord>(rowActions));

  return columns;
}
