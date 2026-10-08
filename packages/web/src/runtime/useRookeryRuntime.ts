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
import { MEMORY_RECALL_TOOL } from '../lib/memory-recall';
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
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: Message['toolCalls'];
  /** The ordered transcript, when the turn produced one. Old rows have none. */
  blocks?: MessageBlock[];
  running?: boolean;
}

type Part = Exclude<ThreadMessageLike['content'], string>[number];
type ToolCallPart = Extract<Part, { type: 'tool-call' }>;
type ToolEvent = NonNullable<Message['toolCalls']>[number];

/**
 * The one line a report-back shows as: its first sentence, without the
 * marker the model reads. The full notice stays in the stored message.
 */
function systemSummary(content: string): string {
  const first = content.split('\n')[0] ?? '';
  return first.replace(/^\[Rookery\]\s*/, '').trim() || 'Rookery';
}

/**
 * Folds one tool event into the calls seen so far, by id, and returns the
 * part it produced: an `end` completes its `start`, keeping the name and
 * detail the start carried. An `end` without an id closes the oldest open
 * call of the same name.
 */
function foldToolCall(calls: Map<string, ToolCallPart>, event: ToolEvent): ToolCallPart {
  const open =
    event.status === 'end' && !event.id
      ? [...calls.entries()].find(
          ([, part]) => part.result === undefined && part.toolName === prettyToolName(event.name),
        )?.[0]
      : undefined;
  const id = event.id ?? open ?? `${event.name}:${calls.size}`;
  const prior = calls.get(id);
  const part: ToolCallPart = {
    type: 'tool-call',
    toolCallId: id,
    toolName: prior?.toolName ?? prettyToolName(event.name),
    args: {},
    argsText: event.detail ?? prior?.argsText ?? '',
    ...(event.status === 'end' ? { result: event.result ?? 'Completed', isError: event.isError } : {}),
  };
  calls.set(id, part);
  return part;
}

/**
 * The answer text as parts: the text itself - always when nothing else is
 * shown - with the trailing sources list split off into source parts. A
 * running answer is still being written, so nothing is split yet.
 */
function pushAnswer(content: Part[], text: string, running: boolean | undefined): void {
  const answer = running ? { text, sources: [] } : splitMessageSources(text);
  if (answer.text || content.length === 0) content.push({ type: 'text', text: answer.text });
  content.push(...answer.sources);
}

/**
 * The ordered transcript: text, thinking and tool calls interleaved the way
 * they actually arrived, instead of every tool clumped in front of the
 * text. Same part vocabulary as the flat fallback; only the order differs,
 * and only the last text block carries sources, because earlier ones are
 * mid-turn prose the tools already answered to.
 */
function partsFromBlocks(message: RookeryThreadMessage, blocks: MessageBlock[]): Part[] {
  const lastText = blocks.findLastIndex((block) => block.type === 'text');
  const content: Part[] = [];
  const calls = new Map<string, ToolCallPart>();
  blocks.forEach((block, index) => {
    if (block.type === 'thinking') {
      if (block.text) content.push({ type: 'reasoning', text: block.text });
    } else if (block.type === 'memory') {
      // The recall reaches the thread as a tool call under a reserved name,
      // because a part with a component of its own is what assistant-ui
      // renders; `memory-call.tsx` registers what draws it. An old row has
      // no such block and so shows nothing at all.
      content.push({
        type: 'tool-call',
        toolCallId: message.id + ':memory:' + index,
        toolName: MEMORY_RECALL_TOOL,
        args: { memories: block.memories, ...(block.turnId ? { turnId: block.turnId } : {}) },
        argsText: '',
        result: block.memories.length,
      });
    } else if (block.type === 'text') {
      if (index === lastText) pushAnswer(content, block.text, message.running);
      else if (block.text) content.push({ type: 'text', text: block.text });
    } else {
      content.push(foldToolCall(calls, block.call));
    }
  });
  return content;
}

/** Rows without blocks: thinking, then every tool call, then the answer. */
function partsFromFlat(message: RookeryThreadMessage): Part[] {
  const content: Part[] = [];
  if (message.thinking) content.push({ type: 'reasoning', text: message.thinking });
  const calls = new Map<string, ToolCallPart>();
  for (const event of message.toolCalls ?? []) foldToolCall(calls, event);
  content.push(...calls.values());
  pushAnswer(content, message.content, message.running);
  return content;
}

function convertMessage(message: RookeryThreadMessage): ThreadMessageLike {
  if (message.role === 'system') {
    return {
      id: message.id,
      role: 'system',
      content: [{ type: 'text', text: systemSummary(message.content) }],
    };
  }
  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'user',
      content: [{ type: 'text', text: message.content }],
    };
  }

  return {
    id: message.id,
    role: 'assistant',
    content: message.blocks?.length ? partsFromBlocks(message, message.blocks) : partsFromFlat(message),
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
      role: message.role === 'user' ? 'user' : message.role === 'system' ? 'system' : 'assistant',
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
