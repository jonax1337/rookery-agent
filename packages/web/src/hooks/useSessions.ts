import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Message, Session } from '../lib/types';

/**
 * Session list plus the active session and its transcript.
 *
 * A session belongs to exactly one counterpart: the assistant, or one agent.
 * `counterpartId` (null = the assistant) is what the chat hub is talking to
 * right now, and the list only ever holds that counterpart's conversations -
 * changing it refetches. Opening an existing thread adopts that thread's own
 * counterpart, because a conversation keeps who it is with for life.
 */
export function useSessions(onOffline?: (offline: boolean) => void) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [counterpartId, setCounterpartId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<Session[]> => {
    try {
      // Nur die Chats des aktuellen Gegenübers. Die Sprachgespräche wurden hier
      // einmal zusätzlich geholt; seit /chats sie über die geteilte Gesamtliste
      // zeigt, hatte dieser zweite Abruf keinen Leser mehr.
      const list = await api.sessions(50, counterpartId ?? 'assistant', 'chat');
      setSessions(list);
      onOffline?.(false);
      return list;
    } catch (error) {
      if (error instanceof ApiError && error.offline) onOffline?.(true);
      return [];
    } finally {
      setLoading(false);
    }
  }, [counterpartId, onOffline]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(async (): Promise<Session | null> => {
    try {
      const session = await api.createSession(counterpartId ? { agentId: counterpartId } : {});
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
      return session;
    } catch {
      return null;
    }
  }, [counterpartId]);

  const remove = useCallback(
    async (id: string): Promise<void> => {
      try {
        await api.deleteSession(id);
      } catch {
        // Already gone server-side; drop it locally either way.
      }
      setSessions((current) => current.filter((session) => session.id !== id));
      setActiveId((current) => (current === id ? null : current));
    },
    [],
  );

  /**
   * Open a thread. Resolves to null when the server no longer knows it, so
   * a stale link can fall back to a fresh chat instead of an empty one.
   */
  const load = useCallback(
    async (id: string): Promise<{ session: Session; messages: Message[] } | null> => {
      try {
        const { session, messages } = await api.session(id);
        setActiveId(id);
        // The thread decides the counterpart, not the other way round.
        setCounterpartId(session.agentId ?? null);
        return { session, messages };
      } catch {
        return null;
      }
    },
    [],
  );

  const rename = useCallback(async (id: string, title: string): Promise<void> => {
    const next = title.trim();
    if (!next) return;
    await api.patchSession(id, { title: next });
    setSessions((current) =>
      current.map((session) => (session.id === id ? { ...session, title: next } : session)),
    );
  }, []);

  /** Switch who the chat hub is talking to and start from a blank thread. */
  const selectCounterpart = useCallback((id: string | null): void => {
    setCounterpartId(id);
    setActiveId(null);
  }, []);

  return {
    sessions,
    activeId,
    setActiveId,
    counterpartId,
    selectCounterpart,
    loading,
    refresh,
    create,
    remove,
    load,
    rename,
  };
}

export type SessionsState = ReturnType<typeof useSessions>;
