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
  MessageBlock,
  PermissionLevel,
  ProviderId,
  Session,
} from '../lib/types';

/** The slice of `useSessions` the thread list needs. */
export interface RookerySessions {
  sessions: Session[];
  activeId: string | null;
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
  /** The ordered transcript, when the turn produced one. Old rows have none. */
  blocks?: MessageBlock[];
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

  // The ordered transcript: text, thinking and tool calls interleaved the way
  // they actually arrived, instead of every tool clumped in front of the
  // text. Same part vocabulary as the fallback below; only the order differs,
  // and only the last text block carries sources, because earlier ones are
  // mid-turn prose the tools already answered to.
  if (message.blocks?.length) {
    const blocks = message.blocks;
    let lastText = -1;
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i]?.type === 'text') {
        lastText = i;
        break;
      }
    }

    const content: Part[] = [];
    const calls = new Map<string, Part>();
    blocks.forEach((block, index) => {
      if (block.type === 'thinking') {
        if (block.text) content.push({ type: 'reasoning', text: block.text });
        return;
      }
      if (block.type === 'text') {
        if (index !== lastText) {
          if (block.text) content.push({ type: 'text', text: block.text });
          return;
        }
        const answer = message.running
          ? { text: block.text, sources: [] }
          : splitMessageSources(block.text);
        if (answer.text || content.length === 0) {
          content.push({ type: 'text', text: answer.text });
        }
        content.push(...answer.sources);
        return;
      }
      const event = block.call;
      const pending = event.status === 'end' && !event.id
        ? [...calls.entries()].find(([, part]) => part.type === 'tool-call' && part.result === undefined && part.toolName === prettyToolName(event.name))?.[0]
        : undefined;
      const id = event.id ?? pending ?? `${event.name}:${calls.size}`;
      const previous = calls.get(id);
      const prior = previous?.type === 'tool-call' ? previous : undefined;
      const part: Part = {
        type: 'tool-call', toolCallId: id,
        toolName: prior?.toolName ?? prettyToolName(event.name),
        args: {}, argsText: event.detail ?? prior?.argsText ?? '',
        ...(event.status === 'end' ? { result: event.result ?? 'Completed', isError: event.isError } : {}),
      };
      calls.set(id, part);
      content.push(part);
    });

    return {
      id: message.id,
      role: 'assistant',
      content,
      metadata: { custom: { originalMarkdown: message.content } },
      status: message.running ? { type: 'running' } : { type: 'complete', reason: 'stop' },
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
      blocks: message.blocks,
    }));
    if (chat.busy || chat.streaming) {
      base.push({
        id: 'm' + chat.messages.length,
        role: 'assistant',
        content: chat.streaming,
        thinking: chat.thinking,
        toolCalls: chat.toolCalls,
        // The placeholder renders the same ordered transcript the finished
        // message will carry - empty parts fall through to the flat path.
        blocks: chat.parts.length ? chat.parts : undefined,
        running: true,
      });
    }
    return base;
  }, [chat.messages, chat.streaming, chat.thinking, chat.toolCalls, chat.parts, chat.busy]);

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

      chat.send(
        {
          text,
          provider,
          permission,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(projectId ? { projectId } : {}),
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
