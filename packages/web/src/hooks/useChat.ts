import { useCallback, useRef, useState } from 'react';
import { TurnBlocks } from '../lib/blocks';
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
  MessageBlock,
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

/** `mcp__playwright__browser_navigate` reads as `playwright · browser_navigate`. */
export function prettyToolName(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  return match ? match[1] + ' · ' + match[2] : name;
}

export interface ChatState {
  messages: Message[];
  streaming: string;
  thinking: string;
  toolCalls: NonNullable<Message['toolCalls']>;
  /**
   * The turn as an ordered transcript - text, thinking and tool calls in
   * arrival order - beside the flat buckets above, which stay because the
   * voice screen (and its test) hang on `chat.activity`/`toolCalls`.
   */
  parts: MessageBlock[];
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
  // Identity of the only turn allowed to write state right now. `reset()` and
  // every new turn replace it, so the callbacks of an abandoned turn - whose
  // server side may still be running - turn into no-ops instead of writing
  // into whichever conversation is on screen by then.
  const turnToken = useRef<unknown>(null);
  // Synchronous mirror of `busy`: a second send in the same tick still sees
  // `busy === false` until React re-renders, so the guard has to be a ref -
  // the same `inFlight` idea as form-kit's `useFormSubmit`.
  const inFlight = useRef(false);
  // True while no turn is pending. `abort` settles a turn before the server
  // has confirmed it, so a late `done` or `error` for that turn must not
  // finish it a second time.
  const finishedRef = useRef(true);
  const bufferRef = useRef('');
  const toolCallsRef = useRef<NonNullable<Message['toolCalls']>>([]);
  const [toolCalls, setToolCalls] = useState<NonNullable<Message['toolCalls']>>([]);
  // The ordered transcript of the running turn. Same folder the core runtime
  // persists as `blocks`, so the placeholder below renders exactly what a
  // reload will read back.
  const partsRef = useRef(new TurnBlocks());
  const [parts, setParts] = useState<MessageBlock[]>([]);

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

  /** Folds one text/thinking/tool event into the ordered transcript. */
  const foldPart = useCallback((event: AgentEvent) => {
    partsRef.current.apply(event);
    setParts([...partsRef.current.blocks]);
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
          foldPart(event);
          break;

        case 'thinking':
          setThinking((current) => (current + event.delta).slice(-2000));
          foldPart(event);
          break;

        case 'tool':
          toolCallsRef.current = [...toolCallsRef.current, event];
          setToolCalls(toolCallsRef.current);
          foldPart(event);
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
    [foldPart, pushActivity],
  );

  const finish = useCallback(
    (text: string, onSpoken?: (text: string) => void, usage?: TurnUsage) => {
      // A turn settles exactly once; a second `finish` would append a
      // duplicate assistant message and re-fire `onSettled`.
      if (finishedRef.current) return;
      finishedRef.current = true;
      const answer = text || bufferRef.current;
      const completedTools = toolCallsRef.current;
      // The final text is a correction of what the deltas added up to, in the
      // one case where nothing was interleaved - the same reconcile the core
      // runtime applies before persisting, so the local row matches the
      // stored one.
      partsRef.current.reconcile(answer);
      const completedBlocks = [...partsRef.current.blocks];
      if (answer || completedTools.length) {
        setMessages((current) => [
          ...current,
          {
            id: nextId(),
            sessionId: sessionId ?? '',
            role: 'assistant',
            content: answer,
            toolCalls: completedTools,
            ...(completedBlocks.length ? { blocks: completedBlocks } : {}),
            createdAt: Date.now(),
            ...(usage ? { usage } : {}),
          },
        ]);
        onSpoken?.(answer);
      }
      bufferRef.current = '';
      toolCallsRef.current = [];
      setToolCalls([]);
      partsRef.current.clear();
      setParts([]);
      turnRef.current = null;
      setStreaming('');
      setThinking('');
      setBusy(false);
      inFlight.current = false;
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
    toolCallsRef.current = [];
    setToolCalls([]);
    partsRef.current.clear();
    setParts([]);
    setStreaming('');
    finishedRef.current = false;
    inFlight.current = true;
    setBusy(true);
    const token = {};
    turnToken.current = token;
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
    return token;
  }, []);

  const send = useCallback<ChatState['send']>(
    (payload, options) => {
      if (inFlight.current) return;
      const text = payload.text.trim();
      if (!text) return;

      const token = beginTurn(text);

      turnRef.current = socket.send(
        { ...payload, text, sessionId: sessionId ?? undefined },
        {
          // Frames of a turn that is no longer the active one belong to a
          // conversation that was reset away; they write nothing here.
          onEvent: (event) => {
            if (turnToken.current !== token) return;
            handleEvent(event);
          },
          onDone: (answer, usage) => {
            if (turnToken.current !== token) return;
            finish(answer, options?.onSpoken, usage);
          },
          onError: (message) => {
            if (turnToken.current !== token) return;
            setError(message);
            finish('');
          },
        },
      );
    },
    [beginTurn, finish, handleEvent, sessionId, socket],
  );

  const sendAssign = useCallback<ChatState['sendAssign']>(
    (payload) => {
      if (inFlight.current) return;
      const task = payload.task.trim();
      if (!task) return;

      const token = beginTurn(task);

      turnRef.current = socket.sendAssign(
        { ...payload, task, sessionId: payload.sessionId ?? sessionId ?? undefined },
        {
          onEvent: (event) => {
            if (turnToken.current !== token) return;
            handleEvent(event);
          },
          onDone: (answer, usage) => {
            if (turnToken.current !== token) return;
            finish(answer, undefined, usage);
          },
          onError: (message) => {
            if (turnToken.current !== token) return;
            setError(message);
            finish('');
          },
        },
      );
    },
    [beginTurn, finish, handleEvent, sessionId, socket],
  );

  const abort = useCallback(() => {
    if (turnRef.current) socket.abort(turnRef.current);
    // Keep whatever text already arrived rather than discarding the turn.
    finish(bufferRef.current);
  }, [finish, socket]);

  const reset = useCallback(() => {
    // Detach the running turn first: stop it on the server and drop its
    // socket entry, so its frames cannot follow the user into whichever
    // conversation replaces this one.
    if (turnRef.current) socket.abort(turnRef.current);
    bufferRef.current = '';
    toolCallsRef.current = [];
    setToolCalls([]);
    partsRef.current.clear();
    setParts([]);
    turnRef.current = null;
    turnToken.current = null;
    // Abandoning the conversation settles its turn too, so neither a stray
    // abort nor a late server frame finishes into the fresh transcript.
    finishedRef.current = true;
    inFlight.current = false;
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
  }, [socket]);

  return {
    messages,
    streaming,
    thinking,
    toolCalls,
    parts,
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
