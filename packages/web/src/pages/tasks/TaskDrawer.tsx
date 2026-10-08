import { NavLink } from 'react-router';

import { TASK_STATUS_LABEL } from '@/lib/format';
import type { Task } from '@/lib/types';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { Button } from '@/components/ui/button';
import { TaskDrawerBody } from '@/pages/tasks/TaskDrawerBody';

interface TaskDrawerProps {
  /** The task on show; `null` keeps the drawer closed. */
  task: Task | null;
  onClose(): void;
}

export function TaskDrawer({ task, onClose }: TaskDrawerProps) {
  return (
    <DetailDrawer
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={task?.title ?? 'Task'}
      description={task ? TASK_STATUS_LABEL[task.status] : undefined}
      footer={
        task ? (
          <Button asChild>
            <NavLink to={'/tasks/' + task.id}>Open task</NavLink>
          </Button>
        ) : undefined
      }
    >
      {task ? <TaskDrawerBody task={task} /> : null}
    </DetailDrawer>
  );
}
