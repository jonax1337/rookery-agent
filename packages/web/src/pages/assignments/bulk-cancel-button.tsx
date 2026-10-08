import { BanIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import type { CancelAssignmentHandle } from '@/components/common/entity-actions';
import { formatNumber } from '@/lib/stats';

import { isOpenStatus, type AssignmentRow } from './assignment-row';

/** The table's bulk action: cancels the open runs among the selected rows. */
export function BulkCancelButton({
  selected,
  clearSelection,
  cancelAssignments,
}: {
  selected: AssignmentRow[];
  clearSelection: () => void;
  cancelAssignments: CancelAssignmentHandle['cancelAssignments'];
}) {
  const openIds = selected.filter((row) => isOpenStatus(row.status)).map((row) => row.id);

  const cancelSelected = async (): Promise<void> => {
    const stopped = await cancelAssignments(openIds);
    // `null` means the reader declined; keep the selection for another try.
    if (stopped !== null) clearSelection();
  };

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={openIds.length === 0}
      onClick={() => void cancelSelected()}
    >
      <BanIcon data-icon="inline-start" />
      {formatNumber(openIds.length)} cancel
    </Button>
  );
}
