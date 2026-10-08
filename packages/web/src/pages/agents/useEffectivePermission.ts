import type { Agent, PermissionLevel } from '@/lib/types';
import { useConfig } from '@/providers/rookery-provider';

/** The agent's own permission, or the one Settings hands out when it has none. */
export function useEffectivePermission(agent: Agent): PermissionLevel | undefined {
  const { config } = useConfig();
  return agent.permission ?? config?.defaultPermission;
}
