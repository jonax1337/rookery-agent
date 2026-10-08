import { NavLink } from 'react-router';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { EMPTY_CELL, relativeTimeCell } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { EmptyState } from '@/components/common/empty-state';
import { StatusBadge } from '@/components/common/status-badge';
import { DownloadIcon as InboxIcon } from '@/components/icons';
import { formatDuration, shorten } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { Agent, Assignment } from '@/lib/types';

import { ASSIGNMENT_LIMIT, isAtLimit } from './agentLimits';

const TITLE_MAX_LENGTH = 90;

function buildAssignmentColumns() {
  const column = createRookeryColumnHelper<Assignment>();
  return column.columns([
    column.accessor('task', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Run" />,
      cell: ({ row }) => (
        <NavLink to={'/assignments/' + row.original.id} className="font-medium hover:underline">
          {shorten(row.original.title, TITLE_MAX_LENGTH)}
        </NavLink>
      ),
      enableHiding: false,
    }),
    column.accessor('status', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Status" />,
      cell: ({ row }) => <StatusBadge kind="assignment" status={row.original.status} />,
    }),
    column.accessor((row) => row.durationMs ?? 0, {
      id: 'durationMs',
      header: ({ column: head }) => (
        <DataTableColumnHeader column={head} title="Duration" align="end" />
      ),
      cell: ({ row }) => (
        <span className="numeric block text-right text-muted-foreground">
          {formatDuration(row.original.durationMs) || EMPTY_CELL}
        </span>
      ),
    }),
    column.accessor('chars', {
      header: ({ column: head }) => (
        <DataTableColumnHeader column={head} title="Characters" align="end" />
      ),
      cell: ({ row }) => (
        <span className="numeric block text-right text-muted-foreground">
          {row.original.chars > 0 ? formatNumber(row.original.chars) : EMPTY_CELL}
        </span>
      ),
    }),
    column.accessor('createdAt', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Assigned" />,
      cell: ({ row }) => relativeTimeCell(row.original.createdAt),
    }),
  ]);
}

const ASSIGNMENT_COLUMNS = buildAssignmentColumns();

/** The runs handed to the agent, newest first. */
export function AssignmentsTab({
  agent,
  assignments,
  onAssign,
}: {
  agent: Agent;
  assignments: Assignment[];
  onAssign: () => void;
}) {
  return (
    <DataTable
      flush
      idPrefix="agent-runs"
      data={assignments}
      columns={ASSIGNMENT_COLUMNS}
      searchable
      searchPlaceholder="Search runs"
      searchText={(row) => row.task}
      initialSorting={[{ id: 'createdAt', desc: true }]}
      groupTime={(row) => row.createdAt}
      groupSortId="createdAt"
      capped={isAtLimit(assignments, ASSIGNMENT_LIMIT)}
      rowLabel={{ singular: 'Assignment', plural: 'assignments' }}
      columnLabels={{
        task: 'Assignment',
        status: 'Status',
        durationMs: 'Duration',
        chars: 'Characters',
        createdAt: 'Assigned',
      }}
      empty={
        <EmptyState
          icon={InboxIcon}
          title={'Nothing has run for ' + agent.name + ' yet'}
          description="Work runs in a separate process, independently of the conversation."
          actionLabel="Hand over a task"
          onAction={onAssign}
          variant="plain"
          size="sm"
        />
      }
    />
  );
}
