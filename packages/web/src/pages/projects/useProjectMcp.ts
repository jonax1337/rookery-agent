import { useCallback, useEffect, useState } from 'react';

import { toast } from 'sonner';

import { api } from '@/lib/api';
import { failureMessage, reportFailure } from '@/lib/errors';
import type { ProjectMcpInfo } from '@/lib/types';

export interface ProjectMcp {
  info: ProjectMcpInfo | null;
  loading: boolean;
  /** A trust change is in flight. */
  busy: boolean;
  error: string | null;
  trust(): Promise<void>;
  revoke(): Promise<void>;
}

/**
 * The `.mcp.json` of a project and whether it is trusted.
 *
 * Nothing is read until the project has a directory: without one there is
 * no file to look at.
 */
export function useProjectMcp(projectId: string | undefined, directory: string | undefined): ProjectMcp {
  const [info, setInfo] = useState<ProjectMcpInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!projectId || !directory) return;
    setLoading(true);
    try {
      setInfo(await api.projectMcp(projectId));
      setError(null);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [projectId, directory]);

  useEffect(() => {
    void load();
  }, [load]);

  const changeTrust = useCallback(
    async (change: (id: string) => Promise<unknown>, done: string, action: string): Promise<void> => {
      if (!projectId) return;
      setBusy(true);
      try {
        await change(projectId);
        await load();
        toast(done);
      } catch (caught) {
        reportFailure(action, caught);
      } finally {
        setBusy(false);
      }
    },
    [projectId, load],
  );

  const trust = useCallback(
    () => changeTrust(api.trustProjectMcp, 'MCP servers trusted', 'Trust'),
    [changeTrust],
  );
  const revoke = useCallback(
    () => changeTrust(api.revokeProjectMcp, 'MCP trust revoked', 'Revoke'),
    [changeTrust],
  );

  return { info, loading, busy, error, trust, revoke };
}
