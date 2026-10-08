import { useMemo } from 'react';
import { NavLink } from 'react-router';

import {
  ClipboardCheckIcon,
  ExternalLinkIcon,
  PenToolIcon as PencilIcon,
  SendIcon,
} from '@/components/icons';
import type { Task } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { EmptyState } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { buildTaskColumns, TASK_COLUMN_LABELS } from '@/components/common/task-columns';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface TaskSubtasksTabProps {
  subtasks: Task[];
  titleOf(taskId: string): string | undefined;
  onPlan(): void;
}

export function TaskSubtasksTab({ subtasks, titleOf, onPlan }: TaskSubtasksTabProps) {
  const org = useOrgState();

  const columns = useMemo(
    () =>
      buildTaskColumns({
        agentById: org.agentById,
        titleOf,
        showUpdatedAt: false,
        rowActions: (child) => <SubtaskRowMenu child={child} />,
      }),
    [org, titleOf],
  );

  return (
    <DataTable
      flush
      idPrefix="subtasks"
      data={subtasks}
      columns={columns}
      getRowId={(child) => child.id}
      searchable
      searchPlaceholder="Search subtasks"
      searchText={(child) => child.title + ' ' + child.description}
      initialSorting={[{ id: 'priority', desc: false }]}
      paginate={false}
      columnLabels={TASK_COLUMN_LABELS}
      rowLabel={{ singular: 'subtask', plural: 'subtasks' }}
      empty={
        <EmptyState
          icon={ClipboardCheckIcon}
          title="No subtasks yet"
          description="The planner reviews the available agents and breaks the task down, or assigns it to one person."
          actionLabel="Plan"
          onAction={onPlan}
          variant="plain"
          size="sm"
        />
      }
    />
  );
}

function SubtaskRowMenu({ child }: { child: Task }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Actions for ' + child.title} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <NavLink to={'/tasks/' + child.id}>
            <ExternalLinkIcon data-icon="inline-start" />
            Open
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <NavLink to={'/tasks/' + child.id + '/edit'}>
            <PencilIcon data-icon="inline-start" />
            Edit
          </NavLink>
        </DropdownMenuItem>
        {child.assignmentId ? (
          <DropdownMenuItem asChild>
            <NavLink to={'/assignments/' + child.assignmentId}>
              <SendIcon data-icon="inline-start" />
              Open assignment
            </NavLink>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
