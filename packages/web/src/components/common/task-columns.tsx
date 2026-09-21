import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

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
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';
import { TASK_PRIORITY_RANK } from '@/lib/format';
import type { Agent, Task } from '@/lib/types';

/**
 * The task table, defined once.
 *
 * Three pages built it: the task list, the subtask table on a task's detail
 * page and the "Zuletzt" table on the dashboard. The first two were nearly
 * identical - same priority accessor under the same comment, same assignee
 * cell down to the `hover:underline`. The third was a poorer copy: plain text
 * headers instead of sortable ones, priority sorted by its German label
 * ("Hoch, Niedrig, Normal") instead of by rank, the assignee without a link to
 * the agent, and the word "Niemand" where the other two said "Noch offen".
 *
 * The list version wins, in every one of those four points. The dashboard
 * keeps its shape through options, not through a second definition: it asks
 * for fewer columns, not for different ones.
 */

export const TASK_COLUMN_LABELS: Record<string, string> = {
  title: 'Title',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  project: 'Project',
  subtasks: 'Subtasks',
  dependsOn: 'Depends on',
  createdAt: 'Created',
  updatedAt: 'Last updated',
};

/** What the list starts with: most urgent first, oldest of those on top. */
export const TASK_SORTING = [
  { id: 'priority', desc: false },
  { id: 'createdAt', desc: false },
];

/** Nobody is on it yet. One wording, because it is a state and not a person. */
export const TASK_UNASSIGNED = 'Unassigned';

export interface TaskColumnsOptions {
  /** Resolves the assignee. Every caller already holds the org state. */
  agentById(id: string | undefined): Agent | undefined;
  /** Prepends the checkbox column. */
  selectable?: boolean;
  /**
   * Makes the title open a drawer instead of navigating. Without it the title
   * is a link to `/tasks/:id`.
   */
  onOpenDetail?(task: Task): void;
  /** Adds the "Projekt" column. Return '' for a task without one. */
  projectName?(task: Task): string;
  /** Adds the "Teilaufgaben" column with its done/total count. */
  childrenOf?(id: string): readonly Task[];
  /**
   * Adds the "Hängt ab von" column. Returns the title of a dependency, or
   * `undefined` when that task is not in the loaded board - the badge then
   * shows the bare id rather than a made-up name.
   */
  titleOf?(id: string): string | undefined;
  /** Adds the trailing menu column. */
  rowActions?(task: Task): ReactNode;
  /** "Angelegt". Off by default - only the full list shows both timestamps. */
  showCreatedAt?: boolean;
  /** "Zuletzt". On by default; the subtask table turns it off. */
  showUpdatedAt?: boolean;
  /** Prints "Teilaufgabe" under the title of a subtask, for mixed lists. */
  showParentHint?: boolean;
}

export function buildTaskColumns(options: TaskColumnsOptions): RookeryColumnDef<Task>[] {
  const {
    agentById,
    selectable = false,
    onOpenDetail,
    projectName,
    childrenOf,
    titleOf,
    rowActions,
    showCreatedAt = false,
    showUpdatedAt = true,
    showParentHint = false,
  } = options;

  const column = createRookeryColumnHelper<Task>();
  const columns: RookeryColumnDef<Task>[] = [];

  if (selectable) {
    columns.push(selectionColumn<Task>({ rowLabel: (task) => 'Select ' + task.title }));
  }

  columns.push(
    column.accessor('title', {
      id: 'title',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Title" />,
      enableHiding: false,
      cell: ({ row }) => {
        const task = row.original;
        const hint =
          showParentHint && task.parentId ? (
            <div className="text-xs text-muted-foreground">Subtask</div>
          ) : null;

        if (onOpenDetail) {
          return (
            <div className="min-w-0">
              <DetailDrawerTrigger
                className="max-w-[28ch] font-medium"
                onClick={() => onOpenDetail(task)}
              >
                {/* The clamp belongs on the text, not on the button: the
                    trigger is a flex box, so a `truncate` on it centres the
                    overflow and cuts the title at BOTH ends instead of
                    ellipsising it. Same span the memory and session columns
                    already use. */}
                <span className="truncate">{task.title}</span>
              </DetailDrawerTrigger>
              {hint}
            </div>
          );
        }
        return (
          <div className="min-w-0">
            <NavLink
              to={'/tasks/' + task.id}
              className="block max-w-[28ch] truncate font-medium hover:underline"
            >
              {task.title}
            </NavLink>
            {hint}
          </div>
        );
      },
    }),

    column.accessor('status', {
      id: 'status',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
      cell: ({ row }) => <StatusBadge kind="task" status={row.original.status} />,
    }),

    // The accessor is the rank, not the label: sorting by "Hoch, Niedrig,
    // Normal" alphabetically would be nonsense, and the rank is the order the
    // old board used.
    column.accessor((task) => TASK_PRIORITY_RANK[task.priority], {
      id: 'priority',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Priority" />,
      cell: ({ row }) => <StatusBadge kind="priority" status={row.original.priority} />,
    }),

    column.accessor((task) => agentById(task.assigneeId)?.name ?? TASK_UNASSIGNED, {
      id: 'assignee',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Assignee" />,
      cell: ({ row }) => {
        const agent = agentById(row.original.assigneeId);
        return agent ? (
          <NavLink to={'/org/agents/' + agent.id} className="hover:underline">
            {agent.name}
          </NavLink>
        ) : (
          <span className="text-muted-foreground">{TASK_UNASSIGNED}</span>
        );
      },
    }),
  );

  if (projectName) {
    columns.push(
      column.accessor((task) => projectName(task), {
        id: 'project',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Project" />,
        cell: ({ getValue }) => {
          const name = getValue() as string;
          return name ? (
            <Badge variant="outline" className="font-normal">
              {name}
            </Badge>
          ) : (
            emptyCell()
          );
        },
      }),
    );
  }

  if (childrenOf) {
    columns.push(
      column.accessor((task) => childrenOf(task.id).length, {
        id: 'subtasks',
        header: ({ column: col }) => (
          <DataTableColumnHeader column={col} title="Subtasks" align="end" />
        ),
        cell: ({ row }) => {
          const children = childrenOf(row.original.id);
          if (children.length === 0) return emptyCell('end');
          const done = children.filter((child) => child.status === 'done').length;
          return (
            <div className="numeric text-right">
              {done}/{children.length}
            </div>
          );
        },
      }),
    );
  }

  if (titleOf) {
    columns.push(
      column.display({
        id: 'dependsOn',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Depends on" />,
        cell: ({ row }) =>
          row.original.dependsOn.length === 0 ? (
            emptyCell()
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.original.dependsOn.map((dependency) => {
                const label = titleOf(dependency);
                return (
                  <Badge
                    key={dependency}
                    variant="outline"
                    // A dependency whose task is not in the loaded board shows
                    // its id rather than a made-up name.
                    className={label ? 'font-normal' : 'font-mono text-2xs font-normal'}
                  >
                    {label ?? dependency}
                  </Badge>
                );
              })}
            </div>
          ),
      }),
    );
  }

  if (showCreatedAt) {
    columns.push(
      column.accessor('createdAt', {
        id: 'createdAt',
        header: ({ column: col }) => (
          <DataTableColumnHeader column={col} title="Created" align="end" />
        ),
        cell: ({ row }) => relativeTimeCell(row.original.createdAt, { align: 'end' }),
      }),
    );
  }

  if (showUpdatedAt) {
    columns.push(
      column.accessor('updatedAt', {
        id: 'updatedAt',
        header: ({ column: col }) => (
          <DataTableColumnHeader column={col} title="Last updated" align="end" />
        ),
        cell: ({ row }) => relativeTimeCell(row.original.updatedAt, { align: 'end' }),
      }),
    );
  }

  if (rowActions) columns.push(actionsColumn<Task>(rowActions));

  return columns;
}
