import { BadgeAlertIcon as TriangleAlertIcon, RotateCcwIcon } from '@/components/icons';

import { CRON_TRIGGER_LABEL } from '@/lib/cron';
import { formatDuration } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { SleepRun } from '@/lib/types';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { EMPTY_CELL, actionsColumn } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

import { NIGHT_COUNTERS, counterValue, reportText, undoable } from './night-run';

const column = createRookeryColumnHelper<SleepRun>();

export const NIGHT_COLUMN_LABELS: Record<string, string> = {
  startedAt: 'Night',
  trigger: 'Trigger',
  duration: 'Duration',
  ...Object.fromEntries(NIGHT_COUNTERS.map(({ key, label }) => [key, label])),
  status: 'Status',
};

export const NIGHT_INITIAL_VISIBILITY: Record<string, boolean> = Object.fromEntries(
  NIGHT_COUNTERS.filter((counter) => counter.hiddenByDefault).map(({ key }) => [key, false]),
);

interface NightColumnOptions {
  /** The run whose undo is in flight, so its button can show it. */
  undoing: string | null;
  onReport(run: SleepRun): void;
  onUndo(run: SleepRun): void;
}

export function nightColumns({ undoing, onReport, onUndo }: NightColumnOptions) {
  return column.columns([
    column.accessor('startedAt', {
      id: 'startedAt',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Night" />,
      enableHiding: false,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span className="whitespace-nowrap tabular-nums">
            {formatDateTime(row.original.startedAt)}
          </span>
          {row.original.undoneAt ? (
            <span className="text-xs text-muted-foreground">
              undone {formatDateTime(row.original.undoneAt)}
            </span>
          ) : null}
        </div>
      ),
    }),
    column.accessor((run) => CRON_TRIGGER_LABEL[run.trigger], {
      id: 'trigger',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Trigger" />,
      cell: ({ getValue }) => <span className="text-muted-foreground">{getValue() as string}</span>,
    }),
    column.accessor((run) => run.durationMs ?? 0, {
      id: 'duration',
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Duration" align="end" />
      ),
      cell: ({ row }) => (
        <div className="text-right tabular-nums">
          {formatDuration(row.original.durationMs) || EMPTY_CELL}
        </div>
      ),
    }),
    ...NIGHT_COUNTERS.map(({ key, label }) => countColumn(key, label)),
    column.accessor('status', {
      id: 'status',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
      cell: ({ row }) => <StatusCell run={row.original} />,
    }),
    actionsColumn<SleepRun>((run) => (
      <div className="flex items-center justify-end gap-1">
        {reportText(run) ? (
          <DetailDrawerTrigger onClick={() => onReport(run)}>Report</DetailDrawerTrigger>
        ) : null}
        {undoable(run) ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={undoing === run.id}
            onClick={() => onUndo(run)}
          >
            {undoing === run.id ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <RotateCcwIcon data-icon="inline-start" />
            )}
            Undo
          </Button>
        ) : null}
      </div>
    )),
  ]);
}

function StatusCell({ run }: { run: SleepRun }) {
  const unresolved = run.conflictCount - run.resolvedCount;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusBadge kind="sleepRun" status={run.status} />
      {run.undoneAt ? <Badge variant="outline">undone</Badge> : null}
      {unresolved > 0 ? (
        <Badge variant="destructive" className="gap-1">
          <TriangleAlertIcon aria-hidden="true" />
          {unresolved === 1
            ? '1 unresolved conflict'
            : formatNumber(unresolved) + ' unresolved conflicts'}
        </Badge>
      ) : null}
    </div>
  );
}

/** Every counter is the same column - right-aligned, sortable, tabular. */
function countColumn(key: (typeof NIGHT_COUNTERS)[number]['key'], title: string) {
  return column.accessor((run) => counterValue(run, key), {
    id: key,
    header: ({ column: col }) => <DataTableColumnHeader column={col} title={title} align="end" />,
    cell: ({ getValue }) => (
      <div className="text-right tabular-nums">{formatNumber(getValue() as number)}</div>
    ),
  });
}
