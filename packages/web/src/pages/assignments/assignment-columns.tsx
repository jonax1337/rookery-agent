import { NavLink } from 'react-router';

import { DataTableColumnHeader, type SortableColumn } from '@/components/blocks/data-table/column-header';
import { DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import {
  actionsColumn,
  EMPTY_CELL,
  relativeTimeCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import {
  createRookeryColumnHelper,
  type RookeryColumnDef,
} from '@/components/blocks/data-table/table-features';
import { ProviderCell } from '@/components/common/provider-cell';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { formatDuration } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { AssignmentStatus } from '@/lib/types';

import { AssignmentRowActions } from './assignment-row-actions';
import { shortTitle, type AssignmentRow } from './assignment-row';

/** Column names for the visibility menu, keyed by column id (hideable columns only). */
export const ASSIGNMENT_COLUMN_LABELS: Record<string, string> = {
  agentName: 'Agent',
  provider: 'Provider',
  chars: 'Characters',
  durationMs: 'Duration',
  depth: 'Level',
  createdAt: 'Time',
};

/** Level is noise on a flat list, so it starts hidden and stays in the menu. */
export const ASSIGNMENT_HIDDEN_COLUMNS = { depth: false };

export const ASSIGNMENT_SORTING = [{ id: 'createdAt', desc: true }];

export const ASSIGNMENT_ROW_LABEL = { singular: 'Assignment', plural: 'assignments' };

export interface AssignmentColumnOptions {
  /** Opens the row drawer. Left out where the table has no drawer. */
  onOpenDetail?: (row: AssignmentRow) => void;
  /** Given: pending and running rows offer "Cancel". */
  onCancel?: (row: AssignmentRow) => void;
  /** Drops the checkbox column, for the read-only children table. */
  selectable?: boolean;
}

const column = createRookeryColumnHelper<AssignmentRow>();

/**
 * The assignment columns, shared by this page's table and the "Delegated"
 * table on the detail page - two views of the same kind of record should not
 * drift into two different sets of columns.
 */
export function buildAssignmentColumns({
  onOpenDetail,
  onCancel,
  selectable = true,
}: AssignmentColumnOptions = {}): RookeryColumnDef<AssignmentRow>[] {
  const columns: RookeryColumnDef<AssignmentRow>[] = [];

  if (selectable) {
    columns.push(
      selectionColumn<AssignmentRow>({
        rowLabel: (row) => shortTitle(row.title) + ' selected',
      }),
    );
  }

  columns.push(
    column.accessor('status', {
      header: sortableHeader('Status'),
      cell: ({ row }) => <StatusCell status={row.original.status} />,
      enableHiding: false,
    }),

    column.accessor('agentName', {
      header: sortableHeader('Agent'),
      cell: ({ row }) => <AgentCell row={row.original} />,
    }),

    // The name, never the brief: three runs of the same errand start with
    // the same twenty words, and a column of those tells nobody them apart.
    column.accessor('title', {
      header: sortableHeader('Run'),
      cell: ({ row }) => <TitleCell row={row.original} onOpenDetail={onOpenDetail} />,
      enableHiding: false,
    }),

    column.accessor('provider', {
      header: sortableHeader('Provider'),
      cell: ({ row }) => (
        <ProviderCell
          {...(row.original.provider ? { provider: row.original.provider } : {})}
          {...(row.original.model ? { model: row.original.model } : {})}
        />
      ),
    }),

    column.accessor('chars', {
      header: sortableHeader('Characters', 'end'),
      cell: ({ row }) => (
        <div className="text-right text-sm tabular-nums">
          {row.original.chars > 0 ? formatNumber(row.original.chars) : EMPTY_CELL}
        </div>
      ),
    }),

    column.accessor('durationMs', {
      header: sortableHeader('Duration', 'end'),
      cell: ({ row }) => (
        <div className="text-right text-sm tabular-nums">
          {formatDuration(row.original.durationMs) || EMPTY_CELL}
        </div>
      ),
    }),

    column.accessor('depth', {
      header: sortableHeader('Level'),
      cell: ({ row }) => <DepthCell depth={row.original.depth} />,
    }),

    column.accessor('createdAt', {
      header: sortableHeader('Time', 'end'),
      cell: ({ row }) => relativeTimeCell(row.original.createdAt, { align: 'end' }),
    }),

    actionsColumn<AssignmentRow>((row) => <AssignmentRowActions row={row} onCancel={onCancel} />),
  );

  return column.columns(columns);
}

function sortableHeader(title: string, align?: 'end') {
  return ({ column: sortable }: { column: SortableColumn }) => (
    <DataTableColumnHeader column={sortable} title={title} align={align} />
  );
}

/**
 * A running row gets the spinner alone: the badge next to it would say
 * "running" in a table where motion already says it, and the column stays
 * narrow enough for the task text to keep its two lines.
 */
function StatusCell({ status }: { status: AssignmentStatus }) {
  if (status !== 'running') return <StatusBadge kind="assignment" status={status} />;

  return (
    <span className="flex items-center gap-1.5 text-sm">
      <Spinner className="size-4 text-primary" aria-hidden="true" />
      <span className="sr-only">running</span>
    </span>
  );
}

function AgentCell({ row }: { row: AssignmentRow }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <NavLink
        to={'/org/agents/' + row.agentId}
        className="truncate text-sm font-medium hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        {row.agentName}
      </NavLink>
      {row.agentSlug ? (
        <Badge variant="outline" className="font-mono text-2xs font-normal">
          {row.agentSlug}
        </Badge>
      ) : null}
    </div>
  );
}

function TitleCell({
  row,
  onOpenDetail,
}: {
  row: AssignmentRow;
  onOpenDetail?: (row: AssignmentRow) => void;
}) {
  if (!onOpenDetail) {
    return (
      <NavLink
        to={'/assignments/' + row.id}
        className="line-clamp-2 max-w-xl text-sm hover:underline"
      >
        {row.title}
      </NavLink>
    );
  }

  return (
    <DetailDrawerTrigger
      className="line-clamp-2 h-auto max-w-xl py-0 text-sm whitespace-normal"
      onClick={() => onOpenDetail(row)}
    >
      {row.title}
    </DetailDrawerTrigger>
  );
}

/** Depth 0 is the normal case - a badge on every row would say nothing. */
function DepthCell({ depth }: { depth: number }) {
  if (depth <= 0) return null;

  return (
    <Badge variant="outline" className="tabular-nums">
      Level {depth}
    </Badge>
  );
}
