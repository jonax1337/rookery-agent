import { useMemo } from 'react';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { EmptyState } from '@/components/common/empty-state';
import type { Assignment } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

import {
  ASSIGNMENT_COLUMN_LABELS,
  ASSIGNMENT_ROW_LABEL,
  ASSIGNMENT_SORTING,
  buildAssignmentColumns,
} from './assignment-columns';
import { toAssignmentRow } from './assignment-row';
import { SendEmptyIcon } from './send-empty-icon';

/** The runs this assignment handed on to other agents, in the shared assignment columns. */
export function DelegatedRunsTable({
  runs,
  onCancelRun,
}: {
  runs: Assignment[];
  onCancelRun: (id: string) => void;
}) {
  const org = useOrgState();

  const columns = useMemo(
    () => buildAssignmentColumns({ selectable: false, onCancel: (row) => onCancelRun(row.id) }),
    [onCancelRun],
  );

  const rows = useMemo(
    () =>
      runs.map((run) => toAssignmentRow(run, org.agentById(run.agentId), org.live[run.id])),
    [runs, org],
  );

  return (
    <DataTable
      flush
      idPrefix="assignment-children"
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      searchable
      searchPlaceholder="Search runs"
      searchText={(row) => row.task}
      initialSorting={ASSIGNMENT_SORTING}
      paginate={false}
      columnLabels={ASSIGNMENT_COLUMN_LABELS}
      rowLabel={ASSIGNMENT_ROW_LABEL}
      empty={
        <EmptyState
          icon={SendEmptyIcon}
          title="Nothing was handed on from this run"
          description="An agent can delegate parts of the work to others; this agent completed everything directly."
          variant="plain"
          size="sm"
        />
      }
    />
  );
}
