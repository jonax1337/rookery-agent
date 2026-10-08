import { useMemo } from 'react';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { EmptyState } from '@/components/common/empty-state';
import { LiveRunList } from '@/components/common/live-run-list';
import { RunTerminal } from '@/components/common/run-terminal';
import { ResultMarkdown } from '@/components/result-markdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ASSIGNMENT_COLUMN_LABELS,
  ASSIGNMENT_ROW_LABEL,
  ASSIGNMENT_SORTING,
  buildAssignmentColumns,
} from '@/pages/assignments/assignment-columns';
import { SendEmptyIcon } from '@/pages/tasks/empty-state-icons';
import type { TaskRuns } from '@/pages/tasks/useTaskRuns';

interface TaskRunsTabProps {
  runs: TaskRuns;
  /** The text of the run this page started, while it streams; empty otherwise. */
  streamText: string;
  onCancelRun(assignmentId: string): void;
  onRun(): void;
}

export function TaskRunsTab({ runs, streamText, onCancelRun, onRun }: TaskRunsTabProps) {
  const columns = useMemo(
    () => buildAssignmentColumns({ selectable: false, onCancel: (row) => onCancelRun(row.id) }),
    [onCancelRun],
  );

  return (
    <>
      {runs.liveViews.length > 0 ? <LiveRuns runs={runs} onCancelRun={onCancelRun} /> : null}

      {streamText ? (
        <Card>
          <CardHeader>
            <CardTitle>During the run</CardTitle>
          </CardHeader>
          <CardContent>
            <ResultMarkdown text={streamText} />
          </CardContent>
        </Card>
      ) : null}

      <DataTable
        flush
        idPrefix="task-runs"
        data={runs.rows}
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
            title="No runs yet"
            description="Run sends the task to its assigned agents. Each run is then listed here."
            actionLabel="Run"
            onAction={onRun}
            variant="plain"
            size="sm"
          />
        }
      />
    </>
  );
}

function LiveRuns({ runs, onCancelRun }: { runs: TaskRuns; onCancelRun(id: string): void }) {
  const { liveViews, rehydrated, watched, watch } = runs;

  return (
    <div className="flex flex-col gap-2">
      <LiveRunList
        assignments={liveViews}
        onCancel={onCancelRun}
        onWatch={watch}
        title={rehydrated ? 'Currently running' : 'This run'}
      />
      {watched ? (
        // The terminal attaches to the server's own live buffer of the
        // still-running assignment, so its text is current even after a
        // reload rebuilt the rows above without theirs.
        <RunTerminal assignmentId={watched.id} status={watched.status} />
      ) : null}
      {rehydrated && !watched ? (
        // Honest about the gap instead of showing an empty box: the
        // transcript is journalled and outlives the run; it is just not
        // streamed into this page after a reload.
        <p className="text-xs text-muted-foreground">
          Live text appears here while a run is going. Open the run to read its full
          transcript, during or after.
        </p>
      ) : null}
    </div>
  );
}
