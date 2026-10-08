import { MetaList } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import {
  BriefcaseBusinessIcon,
  CpuIcon,
  ShieldCheckIcon,
  UsersIcon,
} from '@/components/icons';
import { PERMISSION_LABEL } from '@/lib/format';
import type { Agent } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

import { useEffectivePermission } from './useEffectivePermission';

/** Team, manager, provider and permission of the agent. */
export function AgentFacts({ agent }: { agent: Agent }) {
  const org = useOrgState();
  const permission = useEffectivePermission(agent);
  const team = org.teams.find((entry) => entry.id === agent.teamId);
  const manager = org.agentById(agent.managerId);

  return (
    <MetaList
      columns={2}
      items={[
        {
          label: 'Team',
          value: team?.name ?? 'No team',
          icon: BriefcaseBusinessIcon,
          ...(team ? { to: '/org/teams' } : {}),
        },
        {
          label: 'Manager',
          value: manager?.name ?? 'The assistant',
          icon: UsersIcon,
          ...(manager ? { to: '/org/agents/' + manager.id } : {}),
        },
        {
          label: 'Provider',
          value: (
            <ProviderCell
              layout="inline"
              {...(agent.provider ? { provider: agent.provider } : {})}
              {...(agent.model ? { model: agent.model } : {})}
            />
          ),
          icon: CpuIcon,
        },
        {
          label: 'Permission',
          value: permission ? PERMISSION_LABEL[permission] : 'Default',
          icon: ShieldCheckIcon,
        },
      ]}
    />
  );
}
