/**
 * The conversation's state as the status line shows it, and the ways a turn
 * moves it along.
 */

import { useCallback, useRef, useState } from 'react';
import type { Assistant, ProviderQuota, TurnUsage } from '@rookery/core';
import { addUsage } from '../types.js';
import type { SessionState } from '../types.js';

export interface SessionApi {
  session: SessionState;
  /**
   * The newest session, for callbacks that outlive any single render - the
   * turn runner's, for one.
   */
  sessionRef: { readonly current: SessionState };
  setSession: (update: (current: SessionState) => SessionState) => void;
  /** The runtime told us which session the turn belongs to. */
  onSession: (sessionId: string) => void;
  /** The provider reported the account's own limit windows. */
  onQuota: (quota: ProviderQuota) => void;
  /** A turn ended: pick up the title core may have written, and add its usage. */
  recordTurn: (usage: TurnUsage | undefined) => void;
}

export function useSession(assistant: Assistant, initial: SessionState): SessionApi {
  const [session, setSession] = useState<SessionState>(initial);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const onSession = useCallback(
    (sessionId: string) => {
      setSession((current) => {
        const title = assistant.getSession(sessionId)?.title ?? current.title;
        return { ...current, sessionId, title };
      });
    },
    [assistant],
  );

  const onQuota = useCallback((quota: ProviderQuota) => {
    setSession((current) => ({ ...current, quota }));
  }, []);

  const recordTurn = useCallback(
    (usage: TurnUsage | undefined) => {
      const { sessionId } = sessionRef.current;
      const stored = sessionId ? assistant.getSession(sessionId) : undefined;
      if (stored) setSession((state) => ({ ...state, title: stored.title }));
      if (!usage) return;
      setSession((state) => ({
        ...state,
        usage: addUsage(state.usage, usage),
        ...(usage.contextTokens !== undefined ? { contextTokens: usage.contextTokens } : {}),
        ...(usage.contextWindow !== undefined ? { contextWindow: usage.contextWindow } : {}),
      }));
    },
    [assistant],
  );

  return { session, sessionRef, setSession, onSession, onQuota, recordTurn };
}
