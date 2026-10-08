import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { api, ApiError } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { readStored, writeStored } from '@/lib/storage';
import type { ProviderId } from '@/lib/types';
import {
  useAllSessionsState,
  useChatSession,
  useConnection,
  useSessionsState,
} from '@/providers/rookery-provider';

import { fetchOpenQuestions } from './useChat';
import { useOpenTerminal } from './useOpenTerminal';

/**
 * What the chat page keeps in step with the rest of the world: other tabs,
 * questions asked elsewhere, a turn that is already running, and the choice
 * between the chat view and Claude Code's own terminal.
 */

export type ChatMode = 'chat' | 'terminal';

const CHAT_MODE_KEY = 'rookery.chatMode.';

/** Remembered per conversation in this browser - a convenience, not state the server needs. */
function readChatMode(sessionId: string | null): ChatMode {
  if (!sessionId) return 'chat';
  return readStored(CHAT_MODE_KEY + sessionId) === 'terminal' ? 'terminal' : 'chat';
}

function writeChatMode(sessionId: string, mode: ChatMode): void {
  writeStored(CHAT_MODE_KEY + sessionId, mode === 'chat' ? null : mode);
}

/**
 * A rename or a deletion in another tab arrives as the session's `changed`
 * broadcast. The shared list refetches on every `changed` by itself; the
 * open thread does not, so it is rechecked here. A rename refreshes the
 * hub's own slice, a deletion leaves for `/chats` the way this page's own
 * delete does, rather than keep answering into a session the server no
 * longer has.
 */
export function useRemoteSessionChanges(activeId: string | null): void {
  const navigate = useNavigate();
  const { socket } = useConnection();
  const { refresh: refreshThreads, setActiveId: dropActiveThread } = useSessionsState();
  const { reset: resetTranscript } = useChatSession().chat;

  useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    const unsubscribe = socket.onChanged((change) => {
      if (change.kind !== 'session' || change.id !== activeId) return;
      void api
        .session(activeId)
        .then(() => {
          if (!disposed) void refreshThreads();
        })
        .catch((caught: unknown) => {
          // Anything but a definite "gone" is no reason to leave, and once
          // this page is gone there is nothing left to navigate.
          if (disposed) return;
          if (!(caught instanceof ApiError) || caught.status !== 404) return;
          dropActiveThread(null);
          resetTranscript();
          // Replace, not push: in the tab that deleted, this races its own
          // navigation to `/chats`, and a second entry for the same path
          // would dead-end the Back button.
          void navigate('/chats', { replace: true });
        });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [activeId, dropActiveThread, navigate, refreshThreads, resetTranscript, socket]);
}

/**
 * A question belongs to no one conversation. The turn waiting on it may
 * have been started in another window or on the phone, so it arrives as a
 * broadcast beside the turn's own stream, and answering it here is what
 * lets that turn carry on.
 *
 * A reload has missed every frame sent before it, which is what
 * `GET /api/questions` is for. It runs again on each reconnect: a socket
 * that was away may have missed the question outright, and one that was
 * never open has nothing to have missed.
 */
export function useQuestionFeed(): void {
  const { socket } = useConnection();
  const { openQuestion, closeQuestion } = useChatSession().chat;

  useEffect(() => {
    let disposed = false;
    const loadOpenQuestions = (): void => {
      void fetchOpenQuestions()
        .then((open) => {
          if (disposed) return;
          for (const question of open) openQuestion(question);
        })
        .catch(() => {
          // An unreachable server says so loudly enough elsewhere, and a
          // failed load means only that no card appears.
        });
    };
    // `onStatus` reports the current status straight away, so an open socket
    // loads at once and every later reconnect loads again.
    const stopStatus = socket.onStatus((status) => {
      if (status === 'open') loadOpenQuestions();
    });
    const stopQuestion = socket.onQuestion(openQuestion);
    const stopClosed = socket.onQuestionClosed((event) => closeQuestion(event.id));
    return () => {
      disposed = true;
      stopStatus();
      stopQuestion();
      stopClosed();
    };
  }, [closeQuestion, openQuestion, socket]);
}

/**
 * Whatever turn is already running in this conversation keeps running, and
 * a reload - or opening it in a second tab - joins it rather than staring
 * at an idle screen next to background work: the journal rebuilds what
 * already happened, the socket attach continues the stream from there. The
 * socket re-arms the attach itself on reconnect; leaving the conversation
 * stops the following, never the turn.
 */
export function useRejoinedTurn(activeId: string | null): void {
  const { socket } = useConnection();
  const { attach } = useChatSession().chat;

  useEffect(() => {
    if (!activeId) return;
    void attach(activeId);
    return () => socket.detachConversation(activeId);
  }, [activeId, attach, socket]);
}

/**
 * Chat or Claude Code's own terminal, per conversation. Both carry on the
 * same provider session, so the switch loses nothing: the terminal resumes
 * what the chat said, and every exchange in the terminal is stored in the
 * conversation, where the chat finds it when it takes over again.
 *
 * Which view is shown is the person's choice and nothing else.
 */
export function useChatMode(activeId: string | null) {
  const { openConversation, chat } = useChatSession();
  const allSessions = useAllSessionsState();
  const { load: loadSession } = useSessionsState();
  const openTerminalSession = useOpenTerminal();
  const [mode, setMode] = useState<ChatMode>(() => readChatMode(activeId));
  const [opening, setOpening] = useState(false);
  const { setMessages } = chat;

  useEffect(() => setMode(readChatMode(activeId)), [activeId]);
  useTerminalModelSync(activeId, mode);

  const openTerminal = useCallback(async (): Promise<void> => {
    setOpening(true);
    try {
      const opened = await openTerminalSession(activeId ?? undefined);
      writeChatMode(opened.sessionId, 'terminal');
      setMode('terminal');
      // A terminal opened on the start screen made its own conversation.
      if (opened.sessionId !== activeId) openConversation(opened.sessionId);
      void allSessions.refresh();
    } catch (caught) {
      reportFailure('Open terminal', caught);
    } finally {
      setOpening(false);
    }
  }, [activeId, allSessions, openConversation, openTerminalSession]);

  // The terminal stays: it is the process the chat is answered in, too.
  // Only the view changes.
  const backToChat = useCallback(async (): Promise<void> => {
    setMode('chat');
    if (!activeId) return;
    writeChatMode(activeId, 'chat');
    // What was said in the terminal is in the conversation now; the thread on
    // screen still shows how it looked before the switch.
    const loaded = await loadSession(activeId);
    if (loaded) setMessages(loaded.messages);
  }, [activeId, loadSession, setMessages]);

  return { mode, opening, openTerminal, backToChat };
}

/**
 * One conversation, one model choice: whatever `/model` picked inside the
 * terminal is what the composer shows - and sends - when the chat takes
 * over again. The terminal reports the model that answered with every
 * turn; an alias and its full name (`opus`, `claude-opus-5-5`) count as
 * the same pick, so an unchanged model does not jump in the composer.
 */
function useTerminalModelSync(activeId: string | null, mode: ChatMode): void {
  const { socket } = useConnection();
  const { turn } = useChatSession();
  const { chooseModel, provider: composerProvider, model: composerModel } = turn;

  useEffect(() => {
    if (!activeId || mode !== 'terminal') return;
    return socket.onChanged((change) => {
      if (change.kind !== 'session' || change.id !== activeId) return;
      void api
        .session(activeId)
        .then(({ session }) => {
          if (!session.provider) return;
          if (session.provider === composerProvider && isSameModel(session.provider, session.model, composerModel)) return;
          chooseModel(session.provider, session.model || undefined);
        })
        .catch(() => {
          // The composer keeps its pick; the next change of the session retries.
        });
    });
  }, [activeId, chooseModel, composerModel, composerProvider, mode, socket]);
}

function isSameModel(provider: ProviderId, reported: string | undefined, composer: string | undefined): boolean {
  if (!reported && !composer) return true;
  if (reported === composer) return true;
  return provider === 'claude' && Boolean(composer) && Boolean(reported?.includes(composer ?? ''));
}
