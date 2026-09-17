import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { RookerySocket } from '../lib/socket';
import type { Agent, AssignmentView, OrgSnapshot, Project, Team } from '../lib/types';

/** How long structural changes are collected before one refetch runs. */
const REFRESH_DEBOUNCE_MS = 300;

export interface OrgState {
  snapshot: OrgSnapshot | null;
  loading: boolean;
  error: string | null;
  /** Newest state of every assignment seen on the socket, keyed by id. */
  live: Record<string, AssignmentView>;
  /** Assignments the company is working on right now. */
  running: AssignmentView[];
  agents: Agent[];
  teams: Team[];
  projects: Project[];
  agentById(id: string | undefined): Agent | undefined;
  refresh(): Promise<void>;
}

const RUNNING = new Set(['pending', 'running']);

/**
 * The company, kept fresh.
 *
 * Structure changes rarely but from many places (the pages here, the CLI, and
 * the assistant's own tools), so the source of truth stays the server: any
 * `changed` broadcast triggers one debounced refetch instead of the UI trying
 * to patch its own copy. Assignment broadcasts are different - they arrive
 * many times per second while work runs, so those are merged in memory.
 */
export function useOrg(socket: RookerySocket): OrgState {
  const [snapshot, setSnapshot] = useState<OrgSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, AssignmentView>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.org();
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.offline) {
        setError('No connection to the Rookery server.');
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshSoon = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => socket.onChanged(() => refreshSoon()), [socket, refreshSoon]);

  useEffect(
    () =>
      socket.onAssignment((assignment) => {
        setLive((current) => ({
          ...current,
          [assignment.id]: { ...current[assignment.id], ...assignment },
        }));
        // A finished assignment changes what `active` contains.
        if (!RUNNING.has(assignment.status)) refreshSoon();
      }),
    [socket, refreshSoon],
  );

  /**
   * What is running right now: the server's own `active` list, overlaid with
   * anything the socket has told us since the last refetch.
   */
  const running = useMemo<AssignmentView[]>(() => {
    const byId = new Map<string, AssignmentView>();
    const nameOf = (agentId: string): Agent | undefined =>
      snapshot?.agents.find((agent) => agent.id === agentId);

    for (const assignment of snapshot?.active ?? []) {
      const agent = nameOf(assignment.agentId);
      byId.set(assignment.id, {
        id: assignment.id,
        agentId: assignment.agentId,
        agentSlug: agent?.slug ?? assignment.agentId,
        agentName: agent?.name ?? 'Agent',
        title: assignment.title,
        task: assignment.task,
        status: assignment.status,
        projectId: assignment.projectId,
        parentId: assignment.parentId,
        depth: assignment.depth,
        provider: assignment.provider,
        chars: assignment.chars,
        durationMs: assignment.durationMs,
        error: assignment.error,
      });
    }

    for (const view of Object.values(live)) {
      if (RUNNING.has(view.status)) byId.set(view.id, view);
      else byId.delete(view.id);
    }

    return [...byId.values()];
  }, [snapshot, live]);

  const agents = snapshot?.agents ?? [];
  const teams = snapshot?.teams ?? [];
  const projects = snapshot?.projects ?? [];

  const agentById = useCallback(
    (id: string | undefined) => (id ? agents.find((agent) => agent.id === id) : undefined),
    [agents],
  );

  return { snapshot, loading, error, live, running, agents, teams, projects, agentById, refresh };
}
