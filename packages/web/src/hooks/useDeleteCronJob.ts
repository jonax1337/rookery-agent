import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import type { ConfirmHandle } from '@/components/common/confirm-dialog';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { CronJob } from '@/lib/types';

/**
 * Ask, delete, and leave for the schedule list.
 *
 * Shared by the detail and the form page, which differ only in what has to
 * happen between the server's answer and the toast (`afterDelete`).
 */
export function useDeleteCronJob(
  confirm: ConfirmHandle['confirm'],
  afterDelete?: () => Promise<unknown>,
): (job: Pick<CronJob, 'id' | 'name'>) => Promise<void> {
  const navigate = useNavigate();

  return useCallback(
    async (job) => {
      const ok = await confirm({
        title: 'Delete schedule?',
        description:
          'The schedule “' + job.name + '” will no longer run. Existing assignments and conversations will remain.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      try {
        await api.deleteCronJob(job.id);
        await afterDelete?.();
        toast('Schedule deleted', { description: job.name });
        void navigate('/cron');
      } catch (caught) {
        reportFailure('Delete', caught);
      }
    },
    [afterDelete, confirm, navigate],
  );
}
