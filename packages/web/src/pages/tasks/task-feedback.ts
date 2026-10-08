import { toast } from 'sonner';

import { ApiError } from '@/lib/api';
import { BanIcon } from '@/components/icons';
import type { ConfirmOptions } from '@/components/common/confirm-dialog';

/** The question both the list and the detail page ask before stopping a task. */
export const CANCEL_TASK_CONFIRMATION: ConfirmOptions = {
  title: 'Cancel task?',
  description: 'Any running assignment will be stopped. This cannot be undone.',
  confirmLabel: 'Cancel',
  cancelLabel: 'Keep running',
  destructive: true,
  icon: BanIcon,
};

/** 409: the task is held by the runner, or a manual change disagrees with its state. */
export function isTaskConflict(caught: unknown): caught is ApiError {
  return caught instanceof ApiError && caught.status === 409;
}

/** The explanation for the 409 a status change gets while a run is active. */
export function notifyTaskRunning(): void {
  toast.error('The task is currently running', {
    description: 'While a run is active, the task can only be cancelled.',
  });
}
