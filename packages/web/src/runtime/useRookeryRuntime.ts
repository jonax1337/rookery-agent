import { useMemo } from 'react';
import {
  useExternalStoreRuntime,
  WebSpeechDictationAdapter,
  WebSpeechSynthesisAdapter,
  type AppendMessage,
  type ExternalStoreThreadData,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { prettyToolName } from '../hooks/useChat';
import { splitMessageSources } from './message-sources';
import type { ChatState } from '../hooks/useChat';
import type {
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
  toolCalls?: Message['toolCalls'];
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
  const calls = new Map<string, Part>();
  for (const event of message.toolCalls ?? []) {
    const pending = event.status === 'end' && !event.id
      ? [...calls.entries()].find(([, part]) => part.type === 'tool-call' && part.result === undefined && part.toolName === prettyToolName(event.name))?.[0]
      : undefined;
    const id = event.id ?? pending ?? `${event.name}:${calls.size}`;
    const previous = calls.get(id);
    const prior = previous?.type === 'tool-call' ? previous : undefined;
    calls.set(id, {
      type: 'tool-call', toolCallId: id,
      toolName: prior?.toolName ?? prettyToolName(event.name),
      args: {}, argsText: event.detail ?? prior?.argsText ?? '',
      ...(event.status === 'end' ? { result: event.result ?? 'Completed', isError: event.isError } : {}),
    });
  }
  content.push(...calls.values());
  const answer = message.running ? { text: message.content, sources: [] } : splitMessageSources(message.content);
  if (answer.text || content.length === 0) {
    content.push({ type: 'text', text: answer.text });
  }
  content.push(...answer.sources);

  return {
    id: message.id,
    role: 'assistant',
    content,
    metadata: { custom: { originalMarkdown: message.content } },
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
      toolCalls: message.toolCalls,
    }));
    if (chat.busy || chat.streaming) {
      base.push({
        id: 'm' + chat.messages.length,
        role: 'assistant',
        content: chat.streaming,
        thinking: chat.thinking,
        toolCalls: chat.toolCalls,
        running: true,
      });
    }
    return base;
  }, [chat.messages, chat.streaming, chat.thinking, chat.toolCalls, chat.busy]);

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
