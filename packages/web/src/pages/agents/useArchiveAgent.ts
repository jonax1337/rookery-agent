import { useCallback } from 'react';
import { toast } from 'sonner';

import { useConfirm } from '@/components/common/confirm-dialog';
import { ArchiveIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Agent } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

/**
 * Archive the agent on screen after asking, then refresh the company and the
 * page. Render `dialog` once, anywhere inside the owning component.
 */
export function useArchiveAgent(agent: Agent | null, reload: () => Promise<void>) {
  const org = useOrgState();
  const { confirm, dialog } = useConfirm();

  const archive = useCallback(async (): Promise<void> => {
    if (!agent) return;
    const confirmed = await confirm({
      title: agent.name + ' archive?',
      description:
        'Archived agents no longer accept assignments. Their previous assignments and ' +
        'memories will remain.',
      confirmLabel: 'Archive',
      destructive: true,
      icon: ArchiveIcon,
    });
    if (!confirmed) return;
    try {
      await api.updateAgent(agent.id, { archived: true });
      await org.refresh();
      await reload();
      toast(agent.name + ' archived');
    } catch (caught) {
      reportFailure('Archive', caught);
    }
  }, [agent, confirm, org, reload]);

  return { archive, dialog };
}
