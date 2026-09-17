import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type {
  ExternalAgentRef,
  ExternalHookSet,
  ExternalOverview,
  ExternalPluginState,
  ExternalSource,
  ToolServerAudience,
} from '../lib/types';

/** What a switch on the page decides: yes or no, and for whom. */
export interface ExternalApprovalPatch {
  enabled?: boolean;
  audience?: ToolServerAudience;
}

/**
 * What the Claude Code on this machine has installed.
 *
 * Local state rather than the module-level store `useSkills` and `useTools`
 * keep: one page reads this, and it changes when somebody installs a plugin
 * in a terminal - not something the browser can be told about, which is why
 * there is a refresh that re-reads the two directories on the server.
 *
 * Every setter moves its own switch first and then reloads: the server
 * decides what a switch actually means (a fingerprint that no longer matches
 * leaves a row approved but inactive), so the optimistic move is only ever
 * the switch itself, never the `active` beside it.
 */
export function useExternal(): {
  overview: ExternalOverview | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => Promise<void>;
  rescan: () => Promise<void>;
  setSource: (source: ExternalSource, enabled: boolean) => Promise<void>;
  setAgent: (agent: ExternalAgentRef, patch: ExternalApprovalPatch) => Promise<void>;
  setHook: (set: ExternalHookSet, patch: ExternalApprovalPatch) => Promise<void>;
  setPlugin: (
    plugin: ExternalPluginState,
    patch: { loadWhole?: boolean; audience?: ToolServerAudience },
  ) => Promise<void>;
} {
  const [overview, setOverview] = useState<ExternalOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setOverview(await api.external());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(String(caught), 0));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const rescan = useCallback(async () => {
    await api.refreshExternal();
    await reload();
  }, [reload]);

  const setSource = useCallback(
    async (source: ExternalSource, enabled: boolean) => {
      // Show the switch moving before the round trip; `reload` settles it.
      setOverview((current) =>
        current
          ? {
              ...current,
              sources: current.sources.map((entry) => (entry.id === source.id ? { ...entry, enabled } : entry)),
            }
          : current,
      );
      await api.setExternalSource(source.id, enabled);
      await reload();
    },
    [reload],
  );

  const setAgent = useCallback(
    async (agent: ExternalAgentRef, patch: ExternalApprovalPatch) => {
      setOverview((current) =>
        current
          ? {
              ...current,
              agents: (current.agents ?? []).map((entry) =>
                entry.id === agent.id ? { ...entry, ...patch } : entry,
              ),
            }
          : current,
      );
      await api.setExternalAgent(agent.id, patch);
      await reload();
    },
    [reload],
  );

  const setHook = useCallback(
    async (set: ExternalHookSet, patch: ExternalApprovalPatch) => {
      setOverview((current) =>
        current
          ? {
              ...current,
              hooks: (current.hooks ?? []).map((entry) =>
                entry.sourceId === set.sourceId ? { ...entry, ...patch } : entry,
              ),
            }
          : current,
      );
      await api.setExternalHook(set.sourceId, patch);
      await reload();
    },
    [reload],
  );

  const setPlugin = useCallback(
    async (plugin: ExternalPluginState, patch: { loadWhole?: boolean; audience?: ToolServerAudience }) => {
      setOverview((current) =>
        current
          ? {
              ...current,
              plugins: (current.plugins ?? []).map((entry) =>
                entry.sourceId === plugin.sourceId ? { ...entry, ...patch } : entry,
              ),
            }
          : current,
      );
      await api.setExternalPlugin(plugin.sourceId, patch);
      await reload();
    },
    [reload],
  );

  return { overview, loading, error, reload, rescan, setSource, setAgent, setHook, setPlugin };
}
