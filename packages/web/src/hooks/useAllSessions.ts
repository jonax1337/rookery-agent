import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Nullable } from '../lib/api';
import type { RookerySocket } from '../lib/socket';
import type { Session } from '../lib/types';

/**
 * Every conversation there is, in one request.
 *
 * `useSessions` deliberately holds only the conversations of whoever the chat
 * hub is talking to right now - a thread keeps its counterpart for life, and
 * the chat needs exactly that slice. The conversations page needs the
 * opposite: assistant and agents, chat and voice, together. `GET /api/sessions`
 * already does that when `agent` and `kind` are left off, so this is one call
 * and no server change.
 *
 * Filtering by counterpart, kind, project or period happens on the client,
 * over this one list, so switching a tab keeps sorting, column visibility and
 * page size instead of refetching a different slice.
 */

/** The server's own ceiling. Anything beyond it is invisible - there is no paging. */
export const SESSION_PAGE_LIMIT = 500;

export interface AllSessionsState {
  sessions: Session[];
  loading: boolean;
  error: ApiError | null;
  /**
   * True when the list sits exactly on the limit, which means it is almost
   * certainly cut off. Every total derived from it has to say so.
   */
  capped: boolean;
  limit: number;
  refresh(): Promise<void>;
  sessionById(id: string | undefined): Session | undefined;
  /** Rename, move to a project, file away. Throws so a form can show the error. */
  update(id: string, patch: { title?: string; projectId?: Nullable<string>; archived?: boolean }): Promise<Session>;
  /** Drops the transcript but keeps the conversation. */
  reset(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface AllSessionsOptions {
  /** Lower it for a preview list; the page itself wants the full 500. */
  limit?: number;
  /** Archived conversations are left out unless a view actually shows them. */
  includeArchived?: boolean;
}

export function useAllSessions(
  socket: RookerySocket,
  options: AllSessionsOptions = {},
): AllSessionsState {
  const limit = options.limit ?? SESSION_PAGE_LIMIT;
  const includeArchived = options.includeArchived ?? false;

  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Sequence guard: parameter changes and socket nudges can overlap
  // refreshes; only the newest run may write state, so a slower old answer
  // cannot overwrite the newer list.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeq.current;
    try {
      const list = await api.sessions(limit, undefined, undefined, includeArchived);
      if (seq !== refreshSeq.current) return;
      setSessions(list);
      setError(null);
    } catch (caught) {
      if (seq !== refreshSeq.current) return;
      // An offline server has to reach the page as such - the old list page
      // swallowed the failure and showed an empty table instead.
      setError(caught instanceof ApiError ? caught : new ApiError(String(caught), 0));
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, [limit, includeArchived]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Anything structural in the company can rename or retire a project a
  // conversation points at, and a turn in the chat creates rows here.
  useEffect(() => socket.onChanged(() => void refresh()), [socket, refresh]);

  const sessionById = useCallback(
    (id: string | undefined) => (id ? sessions.find((session) => session.id === id) : undefined),
    [sessions],
  );

  const update = useCallback(
    async (
      id: string,
      patch: { title?: string; projectId?: Nullable<string>; archived?: boolean },
    ): Promise<Session> => {
      const updated = await api.patchSession(id, patch);
      setSessions((current) =>
        // A conversation filed away while the archive is hidden leaves the list.
        current
          .map((session) => (session.id === id ? updated : session))
          .filter((session) => includeArchived || !session.archived),
      );
      return updated;
    },
    [includeArchived],
  );

  const reset = useCallback(
    async (id: string): Promise<void> => {
      await api.resetSession(id);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(async (id: string): Promise<void> => {
    try {
      await api.deleteSession(id);
    } catch (caught) {
      // A 404 means it is already gone, which is the state we wanted.
      if (!(caught instanceof ApiError) || caught.status !== 404) throw caught;
    }
    setSessions((current) => current.filter((session) => session.id !== id));
  }, []);

  return useMemo(
    () => ({
      sessions,
      loading,
      error,
      capped: sessions.length >= limit,
      limit,
      refresh,
      sessionById,
      update,
      reset,
      remove,
    }),
    [sessions, loading, error, limit, refresh, sessionById, update, reset, remove],
  );
}
