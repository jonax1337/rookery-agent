import { relativeTimeCell } from '@/components/blocks/data-table/table-columns';
import {
  createRookeryColumnHelper,
  type RookeryColumnDef,
} from '@/components/blocks/data-table/table-features';
import { ProviderCell } from '@/components/common/provider-cell';
import { StatusBadge } from '@/components/common/status-badge';
import { shorten } from '@/lib/format';
import type { Assignment } from '@/lib/types';

const TASK_TEXT_MAX = 90;

const column = createRookeryColumnHelper<Assignment>();

/** The dashboard's short form of the runs table: what ran, for whom, and how it went. */
export function buildRecentRunColumns(
  agentName: (id: string | undefined) => string,
): RookeryColumnDef<Assignment>[] {
  return column.columns([
    column.accessor('task', {
      header: 'Assignment',
      cell: ({ row }) => (
        <div className="max-w-[42ch] truncate font-medium">
          {shorten(row.original.task, TASK_TEXT_MAX)}
        </div>
      ),
    }),
    column.accessor('agentId', {
      header: 'Agent',
      cell: ({ row }) => <span className="text-sm">{agentName(row.original.agentId)}</span>,
    }),
    column.accessor('status', {
      header: 'Status',
      cell: ({ row }) => <StatusBadge kind="assignment" status={row.original.status} />,
    }),
    column.accessor('provider', {
      header: 'Model',
      cell: ({ row }) => (
        <ProviderCell
          {...(row.original.provider ? { provider: row.original.provider } : {})}
          {...(row.original.model ? { model: row.original.model } : {})}
        />
      ),
    }),
    column.accessor('createdAt', {
      header: () => <div className="w-full text-right">Started</div>,
      cell: ({ row }) => relativeTimeCell(row.original.createdAt, { align: 'end' }),
    }),
  ]);
}
