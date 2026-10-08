import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { useConfirm } from '@/components/common/confirm-dialog';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Agent } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

/**
 * Archive and restore for the agent the form is editing.
 *
 * Archiving asks first and leaves for the agent list afterwards - the agent
 * vanishes from every selection list, so there is nothing left to edit.
 * Restoring is harmless and stays on the page.
 */
export function useAgentArchiveActions(agent: Agent | undefined) {
  const navigate = useNavigate();
  const org = useOrgState();
  const { confirm, dialog } = useConfirm();

  const archive = useCallback(async (): Promise<void> => {
    if (!agent) return;
    const confirmed = await confirm({
      title: 'Agent archive?',
      description:
        agent.name +
        ' will no longer receive new assignments and will disappear from selection lists. Previous assignments and memories will remain.',
      confirmLabel: 'Archive',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await api.updateAgent(agent.id, { archived: true });
      await org.refresh();
      toast(agent.name + ' archived');
      void navigate('/org/agents');
    } catch (caught) {
      reportFailure('Update', caught);
    }
  }, [agent, confirm, navigate, org]);

  const restore = useCallback(async (): Promise<void> => {
    if (!agent) return;
    try {
      await api.updateAgent(agent.id, { archived: false });
      await org.refresh();
      toast(agent.name + ' is active again');
    } catch (caught) {
      reportFailure('Update', caught);
    }
  }, [agent, org]);

  return { archive, restore, dialog };
}
