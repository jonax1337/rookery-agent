import { useMemo } from 'react';
import {
  useExternalStoreRuntime,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import type { ChatState } from '../hooks/useChat';
import type {
  ActivityItem,
  EffortLevel,
  Message,
  PermissionLevel,
  ProviderId,
  Session,
} from '../lib/types';

/** The slice of `useSessions` the thread list needs. */
export interface RookerySessions {
  sessions: Session[];
  activeId: string | null;
  /** Who the hub is talking to. Null means the assistant. */
  counterpartId: string | null;
  loading: boolean;
  setActiveId(id: string | null): void;
  load(id: string): Promise<{ session: Session; messages: Message[] } | null>;
  remove(id: string): Promise<void>;
  rename(id: string, title: string): Promise<void>;
}

/** assistant-ui groups the list by this date when it is present. */
type ThreadData = ExternalStoreThreadData<'regular'> & { lastMessageAt?: Date };

export interface RookeryRuntimeInputs {
  chat: ChatState;
  sessions: RookerySessions;
  provider: ProviderId;
  /** Undefined means the provider default. */
  model: string | undefined;
  effort: EffortLevel | undefined;
  permission: PermissionLevel;
  /** Project every turn is filed under. Undefined means no project. */
  projectId: string | undefined;
  /** Speech-recognition language for the composer's dictation button. */
  lang: string;
  /** Reads the finished answer aloud, when hands-free mode is on. */
  onSpoken?: ((text: string) => void) | undefined;
  /**
   * Called after the active thread changed, with the thread's id or null for
   * a blank one, e.g. to put the conversation into the URL.
   */
  onThreadSwitch?: ((id: string | null) => void) | undefined;
}

interface RookeryThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  activity?: ActivityItem[];
  running?: boolean;
}

type Part = Exclude<ThreadMessageLike['content'], string>[number];

function convertMessage(message: RookeryThreadMessage): ThreadMessageLike {
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'user',
      content: [{ type: 'text', text: message.content }],
    };
  }

  const content: Part[] = [];
  if (message.thinking) content.push({ type: 'reasoning', text: message.thinking });
  for (const item of message.activity ?? []) {
    if (item.kind !== 'tool') continue;
    content.push({
      type: 'tool-call',
      toolCallId: item.id,
      toolName: item.label,
      args: {},
      argsText: item.detail ?? '',
      result: item.done ? (item.detail ?? 'ok') : undefined,
    });
  }
  if (message.content || content.length === 0) {
    content.push({ type: 'text', text: message.content });
  }

  return {
    id: message.id,
    role: 'assistant',
    content,
    status: message.running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
  };
}

/**
 * Adapts the socket-driven `ChatState` and the session list to assistant-ui's
 * `useExternalStoreRuntime`, so the stock `<Thread>` and `<ThreadList>` render
 * them unchanged. The app keeps owning the conversation.
 *
 * Ids are positional on purpose: the streaming placeholder and the finished
 * message that replaces it at the same array slot must be the same message to
 * assistant-ui, otherwise every reply shows a spurious branch picker.
 */
export function useRookeryRuntime({
  chat,
  sessions,
  provider,
  model,
  effort,
  permission,
  projectId,
  lang,
  onSpoken,
  onThreadSwitch,
}: RookeryRuntimeInputs) {
  const messages = useMemo<RookeryThreadMessage[]>(() => {
    const base: RookeryThreadMessage[] = chat.messages.map((message, index) => ({
      id: 'm' + index,
      role: message.role === 'user' ? 'user' : 'assistant',
      content: message.content,
    }));
    if (chat.busy || chat.streaming) {
      base.push({
        id: 'm' + chat.messages.length,
        role: 'assistant',
        content: chat.streaming,
        thinking: chat.thinking,
        activity: chat.activity,
        running: true,
      });
    }
    return base;
  }, [chat.messages, chat.streaming, chat.thinking, chat.activity, chat.busy]);

  const threads = useMemo<ThreadData[]>(
    () =>
      sessions.sessions.map((session) => ({
        status: 'regular',
        id: session.id,
        title: session.title || 'New conversation',
        lastMessageAt: new Date(session.updatedAt),
      })),
    [sessions.sessions],
  );

  const speechAdapters = useMemo(
    () => ({
      speech: new WebSpeechSynthesisAdapter(),
      dictation: new WebSpeechDictationAdapter({ language: lang }),
    }),
    [lang],
  );

  return useExternalStoreRuntime<RookeryThreadMessage>({
    messages,
    isRunning: chat.busy,
    convertMessage,
    onNew: async (message: AppendMessage) => {
      const part = message.content.find((entry) => entry.type === 'text');
      const text = part?.type === 'text' ? part.text.trim() : '';
      if (!text) return;

      // The counterpart only matters for a brand-new session; the server
      // ignores it once the conversation exists.
      chat.send(
        {
          text,
          provider,
          permission,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(projectId ? { projectId } : {}),
          ...(sessions.counterpartId ? { agentId: sessions.counterpartId } : {}),
        },
        onSpoken ? { onSpoken } : undefined,
      );
    },
    onCancel: async () => chat.abort(),
    adapters: {
      ...speechAdapters,
      threadList: {
        threadId: sessions.activeId ?? undefined,
        isLoading: sessions.loading,
        threads,
        onSwitchToThread: async (id) => {
          const loaded = await sessions.load(id);
          chat.reset();
          if (!loaded) {
            // Gone server-side: fall back to a blank chat rather than an
            // empty transcript that would write into a dead session.
            sessions.setActiveId(null);
            onThreadSwitch?.(null);
            return;
          }
          chat.setMessages(loaded.messages);
          onThreadSwitch?.(id);
        },
        onSwitchToNewThread: () => {
          chat.reset();
          sessions.setActiveId(null);
          onThreadSwitch?.(null);
        },
        onRename: (id, title) => sessions.rename(id, title),
        onDelete: (id) => sessions.remove(id),
      },
    },
  });
}
