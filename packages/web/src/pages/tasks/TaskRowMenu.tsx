import {
  BanIcon,
  ExternalLinkIcon,
  PenToolIcon as PencilIcon,
  PlayIcon,
  SparklesIcon as WandSparklesIcon,
} from '@/components/icons';
import { isSettableTaskStatus, TASK_STATUS_LABEL, TASK_STATUS_ORDER } from '@/lib/format';
import type { Task, TaskStatus } from '@/lib/types';
import { RowMenuButton } from '@/components/common/row-menu-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface TaskRowMenuProps {
  task: Task;
  onOpen(): void;
  onEdit(): void;
  onPlan(): void;
  onRun(): void;
  onStatus(status: TaskStatus): void;
  onCancel(): void;
}

export function TaskRowMenu({
  task,
  onOpen,
  onEdit,
  onPlan,
  onRun,
  onStatus,
  onCancel,
}: TaskRowMenuProps) {
  const settled = task.status === 'done' || task.status === 'cancelled';
  const cannotStart = settled || task.status === 'running';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Actions for ' + task.title} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onOpen}>
          <ExternalLinkIcon />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <PencilIcon />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem disabled={cannotStart} onSelect={onPlan}>
          <WandSparklesIcon />
          Plan
        </DropdownMenuItem>
        <DropdownMenuItem disabled={cannotStart} onSelect={onRun}>
          <PlayIcon />
          Run
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Change status</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={task.status}
              onValueChange={(value) => onStatus(value as TaskStatus)}
            >
              {TASK_STATUS_ORDER.map((status) => (
                <DropdownMenuRadioItem
                  key={status}
                  value={status}
                  // `planned`, `running` and `failed` belong to the runner -
                  // PATCH rejects them - so they are shown to place the
                  // current state, not to be picked.
                  disabled={!isSettableTaskStatus(status)}
                >
                  {TASK_STATUS_LABEL[status]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={settled} onSelect={onCancel}>
          <BanIcon />
          Cancel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
