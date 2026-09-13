import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { ExternalOverview, ExternalSource } from '../lib/types';

/**
 * What the Claude Code and Codex on this machine have installed.
 *
 * Local state rather than the module-level store `useSkills` and `useTools`
 * keep: one page reads this, and it changes when somebody installs a plugin
 * in a terminal - not something the browser can be told about, which is why
 * there is a refresh that re-reads the two directories on the server.
 */
export function useExternal(): {
  overview: ExternalOverview | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => Promise<void>;
  rescan: () => Promise<void>;
  setSource: (source: ExternalSource, enabled: boolean) => Promise<void>;
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

  return { overview, loading, error, reload, rescan, setSource };
}
