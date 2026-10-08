import { useMemo } from 'react';
import { api, type ApiError } from '../lib/api';
import type { CustomToolInput, ToolServer, ToolServerAudience } from '../lib/types';
import { createSharedList } from './shared-list';

/**
 * The tool hub, held once for the whole app (see `shared-list.ts`).
 *
 * Tools hang on no socket broadcast: nothing tells the browser that a key was
 * set in a file or that a server finished installing. So the list refetches
 * after every mutation and whenever the tab becomes visible again - otherwise
 * the cards keep showing a number that stopped being true while the user was
 * in a terminal.
 */

const toolList = createSharedList<ToolServer>(api.tools);

function replace(tool: ToolServer): void {
  toolList.setItems(toolList.snapshot().items.map((entry) => (entry.id === tool.id ? tool : entry)));
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
      projectIds?: string[];
    },
  ): Promise<ToolServer>;
  addCustom(input: CustomToolInput): Promise<ToolServer>;
  remove(id: string): Promise<void>;
  /** The entry's one-off preparation, e.g. a browser download. Takes a while. */
  prepare(id: string): Promise<{ ok: boolean; output: string }>;
}

export function useTools(): ToolsState {
  const state = toolList.use();

  return useMemo<ToolsState>(
    () => ({
      tools: state.items,
      loading: state.loading,
      error: state.error,
      refresh: toolList.load,
      toolById: (id) => (id ? state.items.find((tool) => tool.id === id) : undefined),
      setEnabled: async (id, enabled) => {
        const previous = toolList.snapshot().items;
        toolList.setItems(previous.map((tool) => (tool.id === id ? { ...tool, enabled } : tool)));
        try {
          replace(await api.updateTool(id, { enabled }));
        } catch (caught) {
          toolList.setItems(previous);
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
        await toolList.load();
        return tool;
      },
      remove: async (id) => {
        await api.deleteTool(id);
        toolList.setItems(toolList.snapshot().items.filter((tool) => tool.id !== id));
      },
      prepare: async (id) => {
        const result = await api.prepareTool(id);
        // Preparation is what flips `installed`, so the row is now stale.
        await toolList.load();
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
