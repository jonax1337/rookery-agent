import { useCallback, useEffect, useState } from 'react';
import { api, toApiError, type ApiError } from '../lib/api';
import type {
  ExternalAgentRef,
  ExternalHookSet,
  ExternalOverview,
  ExternalPluginState,
  ExternalSource,
  ToolServerAudience,
} from '../lib/types';

/** The rows with `patch` laid over the one `isTarget` picks; a missing shelf is an empty one. */
function patchRows<Row>(rows: Row[] | undefined, isTarget: (row: Row) => boolean, patch: object): Row[] {
  return (rows ?? []).map((row) => (isTarget(row) ? { ...row, ...patch } : row));
}

/** What a switch on the page decides: yes or no, and for whom. */
export interface ExternalApprovalPatch {
  enabled?: boolean;
  audience?: ToolServerAudience;
  /** Hook sets only: keys of the matcher groups left out. */
  skip?: string[];
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
      setError(toApiError(caught));
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

  /**
   * Moves the switch at once, then lets the server have the last word - also
   * when it refuses, so a refused switch does not stay where the click put it.
   */
  const applyOptimistically = useCallback(
    async (move: (overview: ExternalOverview) => ExternalOverview, send: () => Promise<unknown>) => {
      setOverview((current) => (current ? move(current) : current));
      try {
        await send();
      } finally {
        await reload();
      }
    },
    [reload],
  );

  const setSource = useCallback(
    (source: ExternalSource, enabled: boolean) =>
      applyOptimistically(
        (current) => ({ ...current, sources: patchRows(current.sources, (entry) => entry.id === source.id, { enabled }) }),
        () => api.setExternalSource(source.id, enabled),
      ),
    [applyOptimistically],
  );

  const setAgent = useCallback(
    (agent: ExternalAgentRef, patch: ExternalApprovalPatch) =>
      applyOptimistically(
        (current) => ({ ...current, agents: patchRows(current.agents, (entry) => entry.id === agent.id, patch) }),
        () => api.setExternalAgent(agent.id, patch),
      ),
    [applyOptimistically],
  );

  const setHook = useCallback(
    (set: ExternalHookSet, patch: ExternalApprovalPatch) =>
      applyOptimistically(
        (current) => ({ ...current, hooks: patchRows(current.hooks, (entry) => entry.sourceId === set.sourceId, patch) }),
        () => api.setExternalHook(set.sourceId, patch),
      ),
    [applyOptimistically],
  );

  const setPlugin = useCallback(
    (plugin: ExternalPluginState, patch: { loadWhole?: boolean; audience?: ToolServerAudience }) =>
      applyOptimistically(
        (current) => ({
          ...current,
          plugins: patchRows(current.plugins, (entry) => entry.sourceId === plugin.sourceId, patch),
        }),
        () => api.setExternalPlugin(plugin.sourceId, patch),
      ),
    [applyOptimistically],
  );

  return { overview, loading, error, reload, rescan, setSource, setAgent, setHook, setPlugin };
}
