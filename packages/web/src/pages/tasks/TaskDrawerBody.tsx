import { BanIcon } from '@/components/icons';
import { relativeTime } from '@/lib/format';
import type { Task } from '@/lib/types';
import { useOrgState, useTasksState } from '@/providers/rookery-provider';
import { MetaList } from '@/components/common/meta-list';
import { StatusBadge } from '@/components/common/status-badge';
import { TASK_UNASSIGNED } from '@/components/common/task-columns';
import { ResultMarkdown } from '@/components/result-markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** What the row drawer shows: the facts, then the text the task was given. */
export function TaskDrawerBody({ task }: { task: Task }) {
  const org = useOrgState();
  const tasks = useTasksState();
  const children = tasks.childrenOf(task.id);
  const assignee = org.agentById(task.assigneeId);
  const project = org.projects.find((entry) => entry.id === task.projectId);

  return (
    <>
      <MetaList
        columns={1}
        items={[
          { label: 'Status', value: <StatusBadge kind="task" status={task.status} /> },
          { label: 'Priority', value: <StatusBadge kind="priority" status={task.priority} /> },
          {
            label: 'Assignee',
            value: assignee?.name ?? TASK_UNASSIGNED,
            ...(assignee ? { to: '/org/agents/' + assignee.id } : {}),
          },
          { label: 'Project', value: project?.name },
          {
            label: 'Subtasks',
            value: children.length
              ? children.filter((child) => child.status === 'done').length + '/' + children.length
              : undefined,
          },
          { label: 'Created', value: relativeTime(task.createdAt) },
          { label: 'Last updated', value: relativeTime(task.updatedAt) },
        ]}
      />

      {task.description ? <ResultMarkdown text={task.description} /> : null}

      {task.error ? (
        <Alert variant="destructive">
          <BanIcon />
          <AlertTitle>The task failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{task.error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}
