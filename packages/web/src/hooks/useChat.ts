import { useCallback, useRef, useState } from 'react';
import { TurnBlocks } from '../lib/blocks';
import type { QuestionEvent, RookerySocket } from '../lib/socket';
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

/** What an answer carries back: chosen option indices and a free text. */
export interface QuestionReply {
  selected: number[];
  text?: string;
}

/**
 * Merge one asked question into the open list, by id.
 *
 * The same question reaches a client that started the turn twice - once on
 * the turn's own stream, once as the broadcast every connection gets - and a
 * reload adds a third copy from `GET /api/questions`. Merging by id keeps
 * exactly one card per question; the newest copy wins, so a re-broadcast with
 * a later `expiresAt` moves the deadline instead of adding a row.
 */
export function mergeQuestion(current: QuestionEvent[], event: QuestionEvent): QuestionEvent[] {
  const index = current.findIndex((entry) => entry.id === event.id);
  if (index === -1) return [...current, event];
  const next = [...current];
  next[index] = event;
  return next;
}

/** A row from `GET /api/questions` is only usable if it has what a card needs. */
function isQuestion(value: unknown): value is QuestionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<QuestionEvent>;
  return typeof row.id === 'string' && typeof row.question === 'string' && Array.isArray(row.options);
}

/**
 * The questions still waiting for an answer.
 *
 * A reload loses every frame that was sent before it, so the card has to come
 * back over REST - and a late listener (a second window, a phone that just
 * woke up) needs the same list. Answered from either shape the route may
 * take, a bare array or `{ questions }`, and `type` is filled in because the
 * stored question is a request, not an event.
 */
export async function fetchOpenQuestions(): Promise<QuestionEvent[]> {
  const response = await fetch('/api/questions');
  if (!response.ok) throw new Error('Open questions could not be loaded.');
  const body: unknown = await response.json();
  const rows: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { questions?: unknown }).questions)
      ? ((body as { questions: unknown[] }).questions)
      : [];
  return rows.filter(isQuestion).map((row) => ({ ...row, type: 'question' as const }));
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
  /**
   * Questions waiting for a human answer, oldest first. They are not part of
   * the turn: one may well come from a turn another window or the phone
   * started, and a turn that asked stays `busy` while it waits.
   */
  questions: QuestionEvent[];
  error: string | null;
  send(payload: ChatPayload, options?: { onSpoken?(text: string): void }): void;
  sendAssign(payload: AssignPayload): void;
  /**
   * Show a question that did not arrive on this turn's stream - the broadcast
   * every connection gets, or the reload's `GET /api/questions`.
   */
  openQuestion(event: QuestionEvent): void;
  /** Take one away again, whoever answered it and wherever. */
  closeQuestion(id: string): void;
  /**
   * Answer one. Resolves once the answer is on its way - over the socket, or
   * over REST when the socket is down - and rejects if neither got through,
   * so the card can stay and say so instead of vanishing into nothing.
   */
  answerQuestion(id: string, reply: QuestionReply): Promise<void>;
  /**
   * Rejoin this conversation's running turn after a reload - or to watch it
   * from a second tab: rebuild the journal's events into the live state,
   * then continue the stream from where the replay ended.
   */
  attach(sessionId: string): Promise<void>;
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
  const [questions, setQuestions] = useState<QuestionEvent[]>([]);
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

  /**
   * The streamed state is painted at most once per frame.
   *
   * A provider sends one event per token, and rendering each of them on its
   * own made a turn cost quadratic work: every delta re-rendered the whole
   * answer so far, so a long one fell further and further behind the stream
   * and arrived in jerks - while a reload, which renders the finished text
   * once, looked perfectly smooth. Every event is still applied in arrival
   * order and none is dropped; only the paint is coalesced, which is all a
   * reader can see anyway.
   */
  const thinkingRef = useRef('');
  const frameRef = useRef<number | null>(null);

  const paint = useCallback(() => {
    frameRef.current = null;
    setStreaming(bufferRef.current);
    setThinking(thinkingRef.current);
    setParts([...partsRef.current.blocks]);
  }, []);

  /** Drop a frame owed to a turn that is being settled or replaced. */
  const cancelPaint = useCallback(() => {
    if (frameRef.current === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  /**
   * Ask for a paint on the next frame; repeated calls within one frame are
   * free. Where there are no frames - a test harness, a server render -
   * there is nothing to coalesce either, so the paint happens at once and
   * the hook behaves exactly as it did before.
   */
  const schedulePaint = useCallback(() => {
    if (frameRef.current !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      paint();
      return;
    }
    frameRef.current = requestAnimationFrame(paint);
  }, [paint]);

  /** Paint now and drop a pending frame: for the rare structural events. */
  const paintNow = useCallback(() => {
    cancelPaint();
    paint();
  }, [paint]);

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

  /**
   * Folds one text/thinking/tool event into the ordered transcript. The fold
   * happens per event, in order; the paint it asks for is coalesced.
   */
  const foldPart = useCallback(
    (event: AgentEvent) => {
      partsRef.current.apply(event);
      schedulePaint();
    },
    [schedulePaint],
  );

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case 'session':
          onSessionRef.current?.(event.sessionId);
          break;

        case 'text':
          bufferRef.current += event.delta;
          foldPart(event);
          break;

        case 'thinking':
          thinkingRef.current = (thinkingRef.current + event.delta).slice(-2000);
          foldPart(event);
          break;

        case 'tool':
          toolCallsRef.current = [...toolCallsRef.current, event];
          setToolCalls(toolCallsRef.current);
          // A tool call is structural and rare: it shows up at once rather
          // than waiting for the next frame behind a wall of deltas.
          partsRef.current.apply(event);
          paintNow();
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

        case 'question': {
          // `busy` stays true on purpose: the turn has not finished, it is
          // standing still in front of the question until someone answers.
          const asked = event;
          setQuestions((current) => mergeQuestion(current, asked));
          break;
        }

        case 'question-closed': {
          // Answered here, on the phone, or run out of time - either way the
          // turn moved on and the card has nothing left to collect.
          const closed = event;
          setQuestions((current) => current.filter((entry) => entry.id !== closed.id));
          break;
        }

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
      // The turn is over, so a frame still owed to it would paint the state
      // this settle is about to clear - and paint it after the clearing.
      cancelPaint();
      bufferRef.current = '';
      thinkingRef.current = '';
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
  const resetTurnState = useCallback(() => {
    setError(null);
    setActivity([]);
    setRecalled([]);
    setAssignments([]);
    setAgentMessages([]);
    setTasks([]);
    // Same reason as in `finish`: a frame owed to the turn being replaced
    // would paint its leftovers over the one starting here.
    cancelPaint();
    bufferRef.current = '';
    thinkingRef.current = '';
    toolCallsRef.current = [];
    setToolCalls([]);
    partsRef.current.clear();
    setParts([]);
    setStreaming('');
    setThinking('');
    finishedRef.current = false;
    inFlight.current = true;
    setBusy(true);
    const token = {};
    turnToken.current = token;
    return token;
  }, []);

  const beginTurn = useCallback(
    (prompt: string) => {
      const token = resetTurnState();
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
    },
    [resetTurnState],
  );

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

  /**
   * Rejoin whatever turn is running in this conversation.
   *
   * A reload - or a second tab opening the conversation - starts here: the
   * journal's events come back over REST and run through the same reduction
   * the live stream feeds, so the rebuilt screen is the screen before the
   * reload, streaming text and old tool calls included. The socket attach
   * that follows continues from the journal's numbering, and whatever began
   * after the fetch - on another screen, say - is joined the same way when
   * its `attached` reply arrives.
   */
  const attach = useCallback<ChatState['attach']>(
    async (id) => {
      // Arming comes before the busy guard, deliberately: the effect that
      // calls this re-runs whenever its inputs change identity, and its
      // cleanup has just disarmed the socket again. A turn already on screen
      // needs no rebuild, but the conversation must never stop being armed -
      // a reconnect after a silent disarm would lose the live tail for good.
      socket.attachConversation(id, (frame) => {
        // The busy guard inside `rejoin` keeps a re-arm of the conversation
        // from rebuilding what is already on screen.
        if (frame.id) void rejoin();
      });
      if (inFlight.current) return;

      const readRunning = async (): Promise<{
        turn: { id: string; status: string } | null;
        events: { seq: number; event: AgentEvent }[];
      } | null> => {
        try {
          const response = await fetch('/api/sessions/' + encodeURIComponent(id) + '/running');
          if (!response.ok) return null;
          return (await response.json()) as {
            turn: { id: string; status: string } | null;
            events: { seq: number; event: AgentEvent }[];
          };
        } catch {
          return null;
        }
      };

      const rejoin = async (prefetched?: Awaited<ReturnType<typeof readRunning>>): Promise<void> => {
        if (inFlight.current) return;
        const body = prefetched ?? (await readRunning());
        if (!body?.turn) return;

        const token = resetTurnState();
        for (const entry of body.events) {
          if (turnToken.current !== token) return;
          handleEvent(entry.event);
        }
        // A turn interrupted by a server restart has no live tail and will
        // never say done: what the journal holds is the whole answer, so it
        // settles here and now with the text it had reached.
        if (body.turn.status === 'interrupted') {
          finish('');
          return;
        }

        const cursor = body.events.at(-1)?.seq ?? 0;
        turnRef.current = body.turn.id;
        socket.adopt(
          body.turn.id,
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
          cursor,
        );
      };

      const body = await readRunning();
      if (body?.turn) await rejoin(body);
    },
    [finish, handleEvent, resetTurnState, socket],
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

  const openQuestion = useCallback((event: QuestionEvent) => {
    setQuestions((current) => mergeQuestion(current, event));
  }, []);

  const closeQuestion = useCallback((id: string) => {
    setQuestions((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const answerQuestion = useCallback<ChatState['answerQuestion']>(
    async (id, reply) => {
      const text = reply.text?.trim();
      const body = { selected: reply.selected, ...(text ? { text } : {}) };
      // The socket is the short way: the server is already holding the tool
      // call open on the other end of it. A closed socket is no reason to
      // lose a typed answer, so the REST route carries it instead - it is the
      // same door the phone and any SSE client use.
      if (!socket.answer(id, body)) {
        const response = await fetch('/api/questions/' + encodeURIComponent(id) + '/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error('The answer could not be delivered.');
      }
      // Sent is enough to take the card away; `question-closed` follows and
      // removes it everywhere else too.
      setQuestions((current) => current.filter((entry) => entry.id !== id));
    },
    [socket],
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
    cancelPaint();
    bufferRef.current = '';
    thinkingRef.current = '';
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
    // Questions outlive the conversation they were asked in: `reset` does not
    // clear them, because the turn waiting on one may have been started
    // somewhere else entirely. They go when they are closed or expire.
    questions,
    error,
    send,
    sendAssign,
    attach,
    openQuestion,
    closeQuestion,
    answerQuestion,
    abort,
    setMessages,
    reset,
  };
}
