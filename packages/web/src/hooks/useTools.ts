import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, ApiError } from '../lib/api';
import type { CustomToolInput, ToolServer, ToolServerAudience } from '../lib/types';

/**
 * The tool hub, held once for the whole app.
 *
 * Tools hang on no socket broadcast: nothing tells the browser that a key was
 * set in a file or that a server finished installing. So the list refetches
 * after every mutation and whenever the tab becomes visible again - otherwise
 * the cards keep showing a number that stopped being true while the user was
 * in a terminal.
 *
 * The state is module-level rather than per-component because the list page
 * and the detail page want the same rows; the detail page used to pull the
 * whole catalogue a second time just to find one entry.
 */

interface ToolsSnapshot {
  tools: ToolServer[];
  loading: boolean;
  error: ApiError | null;
  /** False until the first response, so a second mount does not refetch. */
  loaded: boolean;
}

let snapshot: ToolsSnapshot = { tools: [], loading: true, error: null, loaded: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: Partial<ToolsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One request at a time; concurrent callers share the flight. */
function load(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const tools = await api.tools();
      publish({ tools, error: null, loading: false, loaded: true });
    } catch (caught) {
      publish({
        error: caught instanceof ApiError ? caught : new ApiError(String(caught), 0),
        loading: false,
        loaded: true,
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function replace(tool: ToolServer): void {
  publish({ tools: snapshot.tools.map((entry) => (entry.id === tool.id ? tool : entry)) });
}

export interface ToolsState {
  tools: ToolServer[];
  loading: boolean;
  error: ApiError | null;
  refresh(): Promise<void>;
  toolById(id: string | undefined): ToolServer | undefined;
  /** Switch a server on or off; rolls back if the server refuses. */
  setEnabled(id: string, enabled: boolean): Promise<void>;
  update(
    id: string,
    patch: {
      enabled?: boolean;
      audience?: ToolServerAudience;
      options?: Record<string, string>;
      env?: Record<string, string>;
    },
  ): Promise<ToolServer>;
  addCustom(input: CustomToolInput): Promise<ToolServer>;
  remove(id: string): Promise<void>;
  /** The entry's one-off preparation, e.g. a browser download. Takes a while. */
  prepare(id: string): Promise<{ ok: boolean; output: string }>;
}

export function useTools(): ToolsState {
  const state = useSyncExternalStore(subscribe, () => snapshot);

  useEffect(() => {
    if (!snapshot.loaded) void load();
  }, []);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  return useMemo<ToolsState>(
    () => ({
      tools: state.tools,
      loading: state.loading,
      error: state.error,
      refresh: load,
      toolById: (id) => (id ? state.tools.find((tool) => tool.id === id) : undefined),
      setEnabled: async (id, enabled) => {
        const previous = snapshot.tools;
        publish({
          tools: previous.map((tool) => (tool.id === id ? { ...tool, enabled } : tool)),
        });
        try {
          replace(await api.updateTool(id, { enabled }));
        } catch (caught) {
          publish({ tools: previous });
          throw caught;
        }
      },
      update: async (id, patch) => {
        const tool = await api.updateTool(id, patch);
        replace(tool);
        return tool;
      },
      addCustom: async (input) => {
        const tool = await api.addCustomTool(input);
        await load();
        return tool;
      },
      remove: async (id) => {
        await api.deleteTool(id);
        publish({ tools: snapshot.tools.filter((tool) => tool.id !== id) });
      },
      prepare: async (id) => {
        const result = await api.prepareTool(id);
        // Preparation is what flips `installed`, so the row is now stale.
        await load();
        return result;
      },
    }),
    [state],
  );
}

export interface ToolState extends ToolsState {
  /** Undefined while loading, and for an id the catalogue does not know. */
  tool: ToolServer | undefined;
}

/**
 * One entry out of the shared list. There is no `GET /api/tools/:id`, and
 * with the list already in memory there is no reason to want one.
 */
export function useTool(id: string | undefined): ToolState {
  const state = useTools();
  return useMemo(() => ({ ...state, tool: state.toolById(id) }), [state, id]);
}
