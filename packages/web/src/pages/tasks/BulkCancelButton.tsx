import { BanIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/stats';
import type { Task } from '@/lib/types';
import type { BulkActionHandle } from '@/components/common/confirm-dialog';
import { Button } from '@/components/ui/button';

interface BulkCancelButtonProps {
  selected: Task[];
  bulk: BulkActionHandle;
  onCancelled(): Promise<unknown>;
  clearSelection(): void;
}

/**
 * Cancel is the only bulk action this API knows (there is no DELETE for
 * tasks), and it is the same act as "Cancel" in the row menu.
 */
export function BulkCancelButton({
  selected,
  bulk,
  onCancelled,
  clearSelection,
}: BulkCancelButtonProps) {
  const cancellable = selected.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled',
  );

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={cancellable.length === 0}
      onClick={() =>
        void bulk.run({
          rows: cancellable,
          noun: { singular: 'task', plural: 'tasks' },
          nameOf: (task) => task.title,
          verb: 'cancel',
          done: 'cancelled',
          confirmLabel: 'Cancel',
          cancelLabel: 'Keep running',
          icon: BanIcon,
          description: 'Their running assignments will be stopped. This cannot be undone.',
          run: (task) => api.updateTask(task.id, { status: 'cancelled' }),
          after: onCancelled,
          clear: clearSelection,
        })
      }
    >
      <BanIcon data-icon="inline-start" />
      Cancel {formatNumber(cancellable.length)}
    </Button>
  );
}
