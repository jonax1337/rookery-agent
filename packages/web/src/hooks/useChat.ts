import { useCallback, useRef, useState } from 'react';
import type { RookerySocket } from '../lib/socket';
import type {
  ActivityItem,
  AgentEvent,
  AgentMessage,
  AssignmentView,
  AssignPayload,
  ChatPayload,
  MemoryRecord,
  Message,
  ProviderQuota,
  Task,
  TurnUsage,
} from '../lib/types';

/**
 * Drives one conversation over the socket.
 *
 * The streaming reply lives in its own state slot rather than inside
 * `messages`, so appending a delta re-renders only the live bubble and not
 * the whole transcript.
 *
 * Assignments the assistant hands out during a turn arrive as events on that
 * turn's own stream. They are kept in first-appearance order and merged by id,
 * so a row updates in place while the list never reshuffles under the reader.
 */

/** Per-browser switch for showing tool calls in the chat; off unless the user asks for it. */
export const SHOW_TOOL_CALLS_KEY = 'rookery.showToolCalls';

export function showToolCalls(): boolean {
  try {
    return localStorage.getItem(SHOW_TOOL_CALLS_KEY) === '1';
  } catch {
    return false;
  }
}

/** `mcp__playwright__browser_navigate` reads as `playwright · browser_navigate`. */
export function prettyToolName(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return match ? match[1] + ' · ' + match[2] : name;
}

export interface ChatState {
  messages: Message[];
  streaming: string;
  thinking: string;
  busy: boolean;
  activity: ActivityItem[];
  recalled: MemoryRecord[];
  /** Assignments this turn started, in the order they first appeared. */
  assignments: AssignmentView[];
  /** Notes agents and the assistant exchanged during this turn. */
  agentMessages: AgentMessage[];
  /** Board tasks this turn created or moved, merged by id. */
  tasks: Task[];
  /** Newest subscription usage the provider reported mid-turn, if any. */
  quota: ProviderQuota | null;
  error: string | null;
  send(payload: ChatPayload, options?: { onSpoken?(text: string): void }): void;
  sendAssign(payload: AssignPayload): void;
  abort(): void;
  setMessages(messages: Message[]): void;
  reset(): void;
}

let localId = 0;
const nextId = (): string => 'local-' + (localId += 1);

const ASSIGNMENT_ACTIVITY_DONE = new Set(['done', 'failed', 'cancelled']);

export function useChat(
  socket: RookerySocket,
  sessionId: string | null,
  /** Fires when the server names the session a turn ended up in (new chats). */
  onSession?: (sessionId: string) => void,
  /** Fires once a turn has settled, however it ended. */
  onSettled?: () => void,
): ChatState {
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [thinking, setThinking] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [recalled, setRecalled] = useState<MemoryRecord[]>([]);
  const [assignments, setAssignments] = useState<AssignmentView[]>([]);
  const [agentMessages, setAgentMessages] = useState<AgentMessage[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [quota, setQuota] = useState<ProviderQuota | null>(null);
  const [error, setError] = useState<string | null>(null);

  const turnRef = useRef<string | null>(null);
  const bufferRef = useRef('');

  const pushActivity = useCallback((item: Omit<ActivityItem, 'at'>) => {
    setActivity((current) => {
      // A tool's 'end' closes the matching 'start' rather than adding a row.
      if (item.done) {
        const index = current.findIndex((entry) => entry.id === item.id && !entry.done);
        if (index !== -1) {
          const next = [...current];
          next[index] = { ...(next[index] as ActivityItem), done: true };
          return next;
        }
      }
      return [...current, { ...item, at: Date.now() }].slice(-60);
    });
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'session':
          onSessionRef.current?.(event.sessionId);
          break;

        case 'text':
          bufferRef.current += event.delta;
          setStreaming(bufferRef.current);
          break;

        case 'thinking':
          setThinking((current) => (current + event.delta).slice(-2000));
          break;

        case 'tool':
          // Tool calls are plumbing. They stay out of the conversation unless
          // this browser opted in (Einstellungen, "Werkzeugaufrufe anzeigen").
          if (!showToolCalls()) break;
          pushActivity({
            id: event.id ?? event.name + ':' + Date.now(),
            kind: 'tool',
            label: prettyToolName(event.name),
            detail: event.detail,
            done: event.status === 'end',
          });
          break;

        case 'status':
          pushActivity({
            id: 'status:' + Date.now(),
            kind: 'status',
            label: event.label,
            detail: event.detail,
          });
          break;

        case 'assignment': {
          const view = event.assignment;
          // Assignments arrive repeatedly as they progress; merge by id so the
          // row updates in place rather than the list growing.
          setAssignments((current) => {
            const index = current.findIndex((entry) => entry.id === view.id);
            if (index === -1) return [...current, view];
            const next = [...current];
            next[index] = { ...(next[index] as AssignmentView), ...view };
            return next;
          });
          pushActivity({
            id: 'assignment:' + view.id,
            kind: 'assignment',
            label: view.agentName,
            detail: view.task,
            done: ASSIGNMENT_ACTIVITY_DONE.has(view.status),
          });
          break;
        }

        case 'task':
          // Same merge rule as assignments: a task reports itself repeatedly
          // as it is planned and run, so the row updates instead of repeating.
          setTasks((current) => {
            const index = current.findIndex((entry) => entry.id === event.task.id);
            if (index === -1) return [...current, event.task];
            const next = [...current];
            next[index] = event.task;
            return next;
          });
          break;

        case 'message':
          setAgentMessages((current) =>
            current.some((entry) => entry.id === event.message.id)
              ? current
              : [...current, event.message],
          );
          break;

        case 'quota':
          setQuota(event.quota);
          break;

        case 'memory':
          if (event.action === 'recalled' && event.items) {
            setRecalled(event.items);
            pushActivity({
              id: 'memory:' + Date.now(),
              kind: 'memory',
              label: 'Memories',
              detail: event.count + ' retrieved',
              done: true,
            });
          }
          break;

        case 'error':
          setError(event.message);
          break;

        default:
          break;
      }
    },
    [pushActivity],
  );

  const finish = useCallback(
    (text: string, onSpoken?: (text: string) => void, usage?: TurnUsage) => {
      const answer = text || bufferRef.current;
      if (answer) {
        setMessages((current) => [
          ...current,
          {
            id: nextId(),
            sessionId: sessionId ?? '',
            role: 'assistant',
            content: answer,
            createdAt: Date.now(),
            ...(usage ? { usage } : {}),
          },
        ]);
        onSpoken?.(answer);
      }
      bufferRef.current = '';
      turnRef.current = null;
      setStreaming('');
      setThinking('');
      setBusy(false);
      onSettledRef.current?.();
    },
    [sessionId],
  );

  /** Everything a fresh turn resets, whether it is a chat or an assignment. */
  const beginTurn = useCallback((prompt: string) => {
    setError(null);
    setActivity([]);
    setRecalled([]);
    setAssignments([]);
    setAgentMessages([]);
    setTasks([]);
    bufferRef.current = '';
    setStreaming('');
    setBusy(true);
    setMessages((current) => [
      ...current,
      {
        id: nextId(),
        sessionId: '',
        role: 'user' as const,
        content: prompt,
        createdAt: Date.now(),
      },
    ]);
  }, []);

  const send = useCallback<ChatState['send']>(
    (payload, options) => {
      if (busy) return;
      const text = payload.text.trim();
      if (!text) return;

      beginTurn(text);

      turnRef.current = socket.send(
        { ...payload, text, sessionId: sessionId ?? undefined },
        {
          onEvent: handleEvent,
          onDone: (answer, usage) => finish(answer, options?.onSpoken, usage),
          onError: (message) => {
            setError(message);
            finish('');
          },
        },
      );
    },
    [beginTurn, busy, finish, handleEvent, sessionId, socket],
  );

  const sendAssign = useCallback<ChatState['sendAssign']>(
    (payload) => {
      if (busy) return;
      const task = payload.task.trim();
      if (!task) return;

      beginTurn(task);

      turnRef.current = socket.sendAssign(
        { ...payload, task, sessionId: payload.sessionId ?? sessionId ?? undefined },
        {
          onEvent: handleEvent,
          onDone: (answer, usage) => finish(answer, undefined, usage),
          onError: (message) => {
            setError(message);
            finish('');
          },
        },
      );
    },
    [beginTurn, busy, finish, handleEvent, sessionId, socket],
  );

  const abort = useCallback(() => {
    if (turnRef.current) socket.abort(turnRef.current);
    // Keep whatever text already arrived rather than discarding the turn.
    finish(bufferRef.current);
  }, [finish, socket]);

  const reset = useCallback(() => {
    bufferRef.current = '';
    turnRef.current = null;
    setMessages([]);
    setStreaming('');
    setThinking('');
    setActivity([]);
    setRecalled([]);
    setAssignments([]);
    setAgentMessages([]);
    setTasks([]);
    setError(null);
    setBusy(false);
  }, []);

  return {
    messages,
    streaming,
    thinking,
    busy,
    activity,
    recalled,
    assignments,
    agentMessages,
    tasks,
    quota,
    error,
    send,
    sendAssign,
    abort,
    setMessages,
    reset,
  };
}
