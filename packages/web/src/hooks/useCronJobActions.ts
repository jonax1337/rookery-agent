import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import type { ConfirmHandle } from '@/components/common/confirm-dialog';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';

interface CronJobActionsInput {
  /** The schedule's id; every action is a no-op until it is known. */
  id: string | undefined;
  /** Whether the schedule carries an imported script that can be reviewed. */
  hasScript: boolean;
  confirm: ConfirmHandle['confirm'];
  /** Refetches the detail after an action the socket does not announce. */
  reload(): Promise<void>;
}

export interface CronJobActions {
  /** True while any of the actions below is waiting for the server. */
  busy: boolean;
  runNow(): Promise<void>;
  toggle(enabled: boolean): Promise<void>;
  reviewScript(): Promise<void>;
  /** Creates the webhook URL, or - when `rotating` - replaces the existing one. */
  mintWebhook(rotating: boolean): Promise<void>;
  removeWebhook(): Promise<void>;
}

/**
 * The buttons of one schedule's detail page. They share one `busy` flag so no
 * two requests for the same schedule are in flight at once.
 */
export function useCronJobActions({
  id,
  hasScript,
  confirm,
  reload,
}: CronJobActionsInput): CronJobActions {
  const [busy, setBusy] = useState(false);

  const withBusy = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }, []);

  const reviewScript = useCallback(async (): Promise<void> => {
    if (!id || !hasScript) return;
    const approved = await confirm({
      title: 'Grant this script Full access?',
      description:
        'The script runs directly on this computer with your user permissions. Review the source below, its dependencies and any external actions before granting access. This does not start or enable the schedule.',
      confirmLabel: 'Grant Full access',
    });
    if (!approved) return;
    await withBusy(async () => {
      try {
        await api.updateCronJob(id, { permission: 'full' });
        await reload();
      } catch (caught) {
        reportFailure('Review script', caught);
      }
    });
  }, [confirm, hasScript, id, reload, withBusy]);

  const runNow = useCallback(async (): Promise<void> => {
    if (!id) return;
    await withBusy(async () => {
      try {
        await api.runCronJob(id);
        toast('Schedule started');
      } catch (caught) {
        reportFailure('Start', caught);
      }
    });
  }, [id, withBusy]);

  const toggle = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!id) return;
      await withBusy(async () => {
        try {
          await api.updateCronJob(id, { enabled });
          toast(enabled ? 'Schedule enabled' : 'Schedule paused');
        } catch (caught) {
          reportFailure('Update', caught);
        }
      });
    },
    [id, withBusy],
  );

  // Minting and rotating are the same call: a rotation is a new secret in the
  // place of the old one, and there is nothing else to ask the server for.
  const mintWebhook = useCallback(
    async (rotating: boolean): Promise<void> => {
      if (!id) return;
      if (rotating) {
        const ok = await confirm({
          title: 'Rotate the webhook URL?',
          description:
            'The current URL stops working immediately. Anything still calling it has to be given the new one.',
          confirmLabel: 'Rotate',
        });
        if (!ok) return;
      }
      await withBusy(async () => {
        try {
          await api.enableCronWebhook(id);
          await reload();
          toast(rotating ? 'Webhook URL rotated' : 'Webhook URL created');
        } catch (caught) {
          reportFailure('Webhook', caught);
        }
      });
    },
    [confirm, id, reload, withBusy],
  );

  const removeWebhook = useCallback(async (): Promise<void> => {
    if (!id) return;
    const ok = await confirm({
      title: 'Remove the webhook URL?',
      description: 'The URL stops working. Events can no longer start this schedule through it.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    await withBusy(async () => {
      try {
        await api.disableCronWebhook(id);
        await reload();
        toast('Webhook URL removed');
      } catch (caught) {
        reportFailure('Webhook', caught);
      }
    });
  }, [confirm, id, reload, withBusy]);

  return { busy, runNow, toggle, reviewScript, mintWebhook, removeWebhook };
}
