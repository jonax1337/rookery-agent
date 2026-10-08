import type {
  AgentEvent,
  AgentMessage,
  AssignmentView,
  AssignPayload,
  ChatPayload,
  ClientFrame,
  EffortLevel,
  MemoryRecord,
  Notification,
  OrgChange,
  PermissionLevel,
  ProviderId,
  ProviderQuota,
  RunTaskPayload,
  ServerFrame,
  Task,
  TaskEvent,
  TurnUsage,
} from './types';

/**
 * One reconnecting WebSocket for the whole app.
 *
 * Turns are multiplexed over it by id, so several requests could be in flight
 * without their event streams interleaving. Broadcasts (memory, assignment,
 * message, changed) belong to no turn and go to their own listener sets.
 * Reconnection backs off exponentially and gives up on nothing - the UI shows
 * the status instead.
 */

export type SocketStatus = 'connecting' | 'open' | 'closed';

/** The `cron` broadcast: the job as it is now, and the run that changed, if one did. */
export type CronEvent = Extract<AgentEvent, { type: 'cron' }>;

/** The `sleep` broadcast: the run as it stands, and which phase it just left. */
export type SleepEvent = Extract<AgentEvent, { type: 'sleep' }>;

/** The `question` broadcast: a turn is waiting on a human answer. */
export type QuestionEvent = Extract<AgentEvent, { type: 'question' }>;

/** The `question-closed` broadcast: that question is over, however it ended. */
export type QuestionClosedEvent = Extract<AgentEvent, { type: 'question-closed' }>;

/** One live-log entry of a running assignment this socket watches. */
export type AssignmentLogFrame = Extract<ServerFrame, { type: 'assignment-log' }>;

/** What a run's terminal sends: its snapshot, screen output, or a state change. */
export type TuiFrame = Extract<ServerFrame, { type: 'tui-snapshot' | 'tui-data' | 'tui-state' }>;

export interface TurnHandlers {
  onEvent(event: AgentEvent): void;
  onDone(text: string, usage?: TurnUsage): void;
  onError(message: string): void;
}

interface PendingTurn extends TurnHandlers {
  id: string;
  /**
   * How far into the turn this client already is, in journal positions. A
   * locally started turn begins at 0 and counts everything; a re-joined turn
   * begins where its REST replay ended, so the first live frames - which may
   * overlap what the journal already gave - are dropped rather than doubled.
   */
  cursor: number;
}

/** What an `attached` frame says: which turn answered, and where it stands. */
export type AttachedFrame = Extract<ServerFrame, { type: 'attached' }>;

const MAX_BACKOFF_MS = 15000;
const PING_INTERVAL_MS = 25000;
const TUI_OPEN_TIMEOUT_MS = 60_000;
const NOT_CONNECTED_MESSAGE = 'Not connected to the Rookery server.';
const CONNECTION_LOST_MESSAGE = 'Connection to the Rookery server was lost.';
/** How many unadopted turns keep their early frames, and how many frames per turn. */
const MAX_UNCLAIMED_TURNS = 8;
const MAX_UNCLAIMED_FRAMES = 2000;

type Listener<T> = (value: T) => void;

/** The `memory` broadcast: what a finished turn taught the memory, in the conversation it came from. */
export interface LearnedMemories {
  sessionId: string;
  stored: MemoryRecord[];
}

/** Adds `listener`; the function returned takes it out again. */
function subscribe<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

function emit<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const listener of listeners) listener(value);
}

export class RookerySocket {
  #url: string;
  #ws: WebSocket | null = null;
  #status: SocketStatus = 'closed';
  #attempt = 0;
  #closedByUs = false;
  #pending = new Map<string, PendingTurn>();
  /**
   * Event frames of turns nobody here has adopted yet, by turn id. A turn
   * announced to this socket - a report-back, a message from the phone - is
   * joined by reading its journal and then adopting it; frames that land in
   * between would otherwise fall through the gap. Small and short-lived:
   * adopting drains them, and only the newest few turns are kept.
   */
  readonly #unclaimed = new Map<string, Extract<ServerFrame, { type: 'event' }>[]>();
  /** Conversations this socket wants the running turn of, re-armed on reconnect. */
  #attachedConversations = new Set<string>();
  /** The latest `attachConversation` handler; one page attaches one conversation. */
  #onAttached: ((frame: AttachedFrame) => void) | null = null;
  #statusListeners = new Set<Listener<SocketStatus>>();
  #memoryListeners = new Set<Listener<LearnedMemories>>();
  #assignmentListeners = new Set<Listener<AssignmentView>>();
  #messageListeners = new Set<Listener<AgentMessage>>();
  #notificationListeners = new Set<Listener<Notification>>();
  #taskEventListeners = new Set<Listener<TaskEvent>>();
  #taskListeners = new Set<Listener<Task>>();
  #cronListeners = new Set<Listener<CronEvent>>();
  #changedListeners = new Set<Listener<OrgChange>>();
  #sleepListeners = new Set<Listener<SleepEvent>>();
  #quotaListeners = new Set<Listener<ProviderQuota>>();
  #questionListeners = new Set<Listener<QuestionEvent>>();
  #questionClosedListeners = new Set<Listener<QuestionClosedEvent>>();
  #assignmentLogListeners = new Set<Listener<AssignmentLogFrame>>();
  /** Assignments this socket should be watching, so a reconnect can re-arm them. */
  #watchedAssignments = new Set<string>();
  #tuiListeners = new Set<Listener<TuiFrame>>();
  /** Terminals this socket has open; re-armed on reconnect like the watches. */
  #watchedTuis = new Set<string>();
  /** `tui-open` requests waiting for their `tui-opened` reply. */
  #tuiOpens = new Map<string, { resolve(value: { sessionId: string; key: string }): void; reject(error: Error): void }>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    this.#url = url;
  }

  get status(): SocketStatus {
    return this.#status;
  }

  /** Called at once with the current status, then on every change. */
  onStatus(listener: Listener<SocketStatus>): () => void {
    const unsubscribe = subscribe(this.#statusListeners, listener);
    listener(this.#status);
    return unsubscribe;
  }

  onMemory(listener: Listener<LearnedMemories>): () => void {
    return subscribe(this.#memoryListeners, listener);
  }

  /** Every assignment state change in the company, whoever started it. */
  onAssignment(listener: Listener<AssignmentView>): () => void {
    return subscribe(this.#assignmentListeners, listener);
  }

  /** Every message posted between agents, their manager or the assistant. */
  onMessage(listener: Listener<AgentMessage>): () => void {
    return subscribe(this.#messageListeners, listener);
  }

  /** Every notification stored for the user - a schedule result, a question, a report. */
  onNotification(listener: Listener<Notification>): () => void {
    return subscribe(this.#notificationListeners, listener);
  }

  /** Every line added to any task's activity. */
  onTaskEvent(listener: Listener<TaskEvent>): () => void {
    return subscribe(this.#taskEventListeners, listener);
  }

  /** Every task on the board that was created or changed state, whoever did it. */
  onTask(listener: Listener<Task>): () => void {
    return subscribe(this.#taskListeners, listener);
  }

  /** A schedule was created, edited or deleted, or one of its runs changed state. */
  onCron(listener: Listener<CronEvent>): () => void {
    return subscribe(this.#cronListeners, listener);
  }

  /** The memory fell asleep, moved on a phase, or woke up again. */
  onSleep(listener: Listener<SleepEvent>): () => void {
    return subscribe(this.#sleepListeners, listener);
  }

  /**
   * The provider reported the subscription's limit windows.
   *
   * This rides a turn's stream - it is what the CLI says on its way past -
   * but the figure is about the account, not the turn, so it gets its own
   * listener set. Without it the context indicator in the header would only
   * ever learn about quota while a turn happened to be running in the chat.
   * Outside a turn, `GET /api/providers/:id/usage` stays the source.
   */
  onQuota(listener: Listener<ProviderQuota>): () => void {
    return subscribe(this.#quotaListeners, listener);
  }

  /**
   * The assistant asked something and a turn is waiting on the answer.
   *
   * This is the broadcast, not the turn's own stream: the turn may have been
   * started in another window or on the phone, and the question is still ours
   * to show and ours to answer - the id belongs to the question, not to a
   * turn. A client that started the turn itself sees the same event twice,
   * once here and once on its stream, so listeners merge by id.
   */
  onQuestion(listener: Listener<QuestionEvent>): () => void {
    return subscribe(this.#questionListeners, listener);
  }

  /** That question is over - answered, cancelled or expired. Take the card away. */
  onQuestionClosed(listener: Listener<QuestionClosedEvent>): () => void {
    return subscribe(this.#questionClosedListeners, listener);
  }

  /** An agent, team, project or the company itself was created or edited. */
  onChanged(listener: Listener<OrgChange>): () => void {
    return subscribe(this.#changedListeners, listener);
  }

  /**
   * Live-log entries of the running assignments this socket watches. Only
   * frames for ids this client sent `watchAssignment` for ever arrive, so the
   * listener does not need to filter - but it gets the whole frame, id
   * included, because one terminal component may serve several rows.
   */
  onAssignmentLog(listener: Listener<AssignmentLogFrame>): () => void {
    return subscribe(this.#assignmentLogListeners, listener);
  }

  /**
   * Opt into the live log of one running assignment. Sent immediately when
   * the socket is open; otherwise remembered and re-sent on the next `open`,
   * so a watch started mid-reconnect is not silently lost.
   */
  watchAssignment(id: string): void {
    this.#watchedAssignments.add(id);
    this.#send({ type: 'watch', assignmentId: id });
  }

  /**
   * Opt back out. Idempotent: a watcher going away ends nothing but the
   * watching - the run itself keeps going (E.1).
   */
  unwatchAssignment(id: string): void {
    this.#watchedAssignments.delete(id);
    this.#send({ type: 'unwatch', assignmentId: id });
  }

  /** Frames of the run terminals this socket has open (`watchTui`). */
  onTui(listener: Listener<TuiFrame>): () => void {
    return subscribe(this.#tuiListeners, listener);
  }

  /**
   * Open a run's Claude Code terminal. The server answers with a snapshot -
   * the screen so far, or `info: null` when there is no terminal - and then
   * streams. A reconnect re-arms it, and the fresh snapshot redraws.
   */
  watchTui(id: string): void {
    this.#watchedTuis.add(id);
    this.#send({ type: 'tui-watch', assignmentId: id });
  }

  unwatchTui(id: string): void {
    this.#watchedTuis.delete(id);
    this.#send({ type: 'tui-unwatch', assignmentId: id });
  }

  /** Keystrokes into the terminal, exactly as the terminal emulator encoded them. */
  sendTuiInput(id: string, data: string): void {
    this.#send({ type: 'tui-input', assignmentId: id, data });
  }

  resizeTui(id: string, cols: number, rows: number): void {
    this.#send({ type: 'tui-resize', assignmentId: id, cols, rows });
  }

  /** Ends the terminal's process; only the transcript remains. */
  killTui(id: string): void {
    this.#send({ type: 'tui-kill', assignmentId: id });
  }

  /**
   * Carry a conversation on in Claude Code's own terminal. Resolves with the
   * conversation (a new one when none was given) and the key its terminal
   * streams under - watch that with `watchTui`.
   */
  openTui(payload: {
    sessionId?: string;
    provider?: ProviderId;
    model?: string;
    effort?: EffortLevel;
    permission?: PermissionLevel;
    projectId?: string;
  }): Promise<{ sessionId: string; key: string }> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#tuiOpens.delete(id);
        reject(new Error('The terminal did not open in time.'));
      }, TUI_OPEN_TIMEOUT_MS);
      this.#tuiOpens.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      // Without a connection no reply can ever come: say so now, not after the timeout.
      if (!this.#send({ type: 'tui-open', id, ...payload })) {
        this.#tuiOpens.delete(id);
        clearTimeout(timer);
        reject(new Error(NOT_CONNECTED_MESSAGE));
      }
    });
  }

  /** Back to chat: the conversation's terminal ends. */
  closeTui(sessionId: string): void {
    this.#send({ type: 'tui-close', sessionId });
  }

  connect(): void {
    if (this.#ws && (this.#status === 'open' || this.#status === 'connecting')) return;
    this.#closedByUs = false;
    this.#setStatus('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch {
      this.#setStatus('closed');
      this.#scheduleReconnect();
      return;
    }
    this.#ws = socket;

    // Every handler below asks first whether this socket is still the current
    // one. Without that check a replaced socket keeps delivering: `close()`
    // cannot stop a handshake already in flight, its late `onclose` used to
    // null out the *successor's* reference and schedule yet another
    // reconnect, and the second live socket was still wired to
    // `#handleFrame`. Every broadcast then arrived twice - two "memories
    // learned" toasts for one turn, two notification toasts for one notification - which is
    // exactly the duplication this guard ends.
    const current = (): boolean => this.#ws === socket;

    socket.onopen = () => {
      if (!current()) {
        socket.close();
        return;
      }
      this.#attempt = 0;
      this.#setStatus('open');
      this.#clearPing();
      this.#pingTimer = setInterval(() => this.#send({ type: 'ping' }), PING_INTERVAL_MS);
      // The server's watcher sets died with the old socket: every live
      // terminal re-arms its watch here, before any frames could be missed.
      for (const id of this.#watchedAssignments) this.#send({ type: 'watch', assignmentId: id });
      for (const id of this.#watchedTuis) this.#send({ type: 'tui-watch', assignmentId: id });
      // Same for the conversations being followed: the turn kept running
      // while the connection was down, and its journal has the part missed.
      for (const sessionId of this.#attachedConversations) this.#send({ type: 'attach', sessionId });
    };

    socket.onmessage = (message) => {
      if (!current()) return;
      this.#handleFrame(message.data);
    };

    socket.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };

    socket.onclose = () => {
      if (!current()) return;
      this.#clearPing();
      this.#ws = null;
      this.#setStatus('closed');
      this.#failPendingWork();
      if (!this.#closedByUs) this.#scheduleReconnect();
    };
  }

  close(): void {
    this.#closedByUs = true;
    clearTimeout(this.#reconnectTimer ?? undefined);
    this.#failPendingWork();
    this.#clearPing();
    // Detached before closing. A CONNECTING socket cannot be stopped
    // synchronously, so without this its events would still land after the
    // next `connect()` has taken over.
    const socket = this.#ws;
    this.#ws = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
    this.#setStatus('closed');
  }

  /** Turns and terminal opens owed a reply by a connection that is gone: a drop must not leave the UI waiting forever. */
  #failPendingWork(): void {
    for (const turn of this.#pending.values()) turn.onError(CONNECTION_LOST_MESSAGE);
    this.#pending.clear();
    for (const opening of this.#tuiOpens.values()) opening.reject(new Error(CONNECTION_LOST_MESSAGE));
    this.#tuiOpens.clear();
  }

  /** Start a turn. Returns its id so the caller can abort it. */
  send(payload: ChatPayload, handlers: TurnHandlers): string {
    return this.#start({ type: 'chat', payload }, handlers);
  }

  /**
   * Hand one agent a task directly. Identical plumbing to `send`: the server
   * streams the same event envelope, only the generator behind it differs.
   */
  sendAssign(payload: AssignPayload, handlers: TurnHandlers): string {
    return this.#start({ type: 'assign', payload }, handlers);
  }

  /**
   * Run a task from the board. Same envelope again: task, assignment, tool and
   * error events arrive on the turn's own stream, `done` carries the combined
   * result.
   */
  sendRunTask(payload: RunTaskPayload, handlers: TurnHandlers): string {
    return this.#start({ type: 'run_task', payload }, handlers);
  }

  #start(
    frame:
      | { type: 'chat'; payload: ChatPayload }
      | { type: 'assign'; payload: AssignPayload }
      | { type: 'run_task'; payload: RunTaskPayload },
    handlers: TurnHandlers,
  ): string {
    const id = crypto.randomUUID();
    this.#pending.set(id, { id, cursor: 0, ...handlers });

    if (!this.#send({ ...frame, id } as ClientFrame)) {
      this.#pending.delete(id);
      handlers.onError(NOT_CONNECTED_MESSAGE);
    }
    return id;
  }

  /**
   * Register handlers for a turn this client did not start - the one the
   * journal replayed over REST. Its live frames arrive with the same id;
   * `cursor` is how far the replay already went, and everything numbered up
   * to it is dropped on arrival rather than applied twice.
   */
  adopt(id: string, handlers: TurnHandlers, cursor: number): void {
    this.#pending.set(id, { id, cursor, ...handlers });
    const early = this.#unclaimed.get(id);
    this.#unclaimed.delete(id);
    // Replayed through the same path, so the cursor drops what the journal
    // already covered.
    for (const frame of early ?? []) this.#handleEventFrame(frame);
  }

  abort(id: string): void {
    this.#send({ type: 'abort', id });
    this.#pending.delete(id);
  }

  /**
   * Point this socket at a conversation: whichever turn runs there, its live
   * frames come to this client from now on. Re-armed on every reconnect, like
   * the assignment watches. The handler hears each `attached` reply, so a
   * turn that started after the REST replay - on another screen, say - can
   * still be fetched and joined; one page attaches one conversation, which is
   * why the latest handler wins.
   */
  attachConversation(sessionId: string, onAttached?: (frame: AttachedFrame) => void): void {
    this.#attachedConversations.add(sessionId);
    if (onAttached) this.#onAttached = onAttached;
    this.#send({ type: 'attach', sessionId });
  }

  /** Stop asking after a conversation. Its turns keep running, unseen here. */
  detachConversation(sessionId: string): void {
    this.#attachedConversations.delete(sessionId);
    this.#onAttached = null;
    // Otherwise the server keeps announcing every new turn there to a page
    // that is not showing it any more.
    this.#send({ type: 'detach', sessionId });
  }

  /**
   * Answer an open question. `id` is the question's, not a turn's, so this
   * opens no stream and gets no reply of its own: the server resolves the
   * waiting tool call and closes the question with a `question-closed`
   * broadcast, which is what takes the card away everywhere at once.
   *
   * Returns `false` when the socket is not open, so the caller can fall back
   * to `POST /api/questions/:id/answer` rather than lose the answer.
   */
  answer(id: string, payload: { selected: number[]; text?: string }): boolean {
    const text = payload.text?.trim();
    return this.#send({
      type: 'answer',
      id,
      selected: payload.selected,
      ...(text ? { text } : {}),
    });
  }

  /* ---------------------------- internals ---------------------------- */

  #handleFrame(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }

    switch (frame.type) {
      case 'memory':
        emit(this.#memoryListeners, frame.event);
        return;

      case 'assignment':
        if (frame.event.type === 'assignment') emit(this.#assignmentListeners, frame.event.assignment);
        return;

      case 'message':
        if (frame.event.type === 'message') emit(this.#messageListeners, frame.event.message);
        return;

      case 'notification': {
        // The contract sends the notification flat; tolerate it wrapped as an event too.
        const notification =
          frame.notification ?? (frame.event?.type === 'notification' ? frame.event.notification : undefined);
        if (notification) emit(this.#notificationListeners, notification);
        return;
      }

      case 'task-event': {
        const payload = frame.event as TaskEvent | AgentEvent;
        const event = 'type' in payload ? (payload.type === 'task-event' ? payload.event : undefined) : payload;
        if (event) emit(this.#taskEventListeners, event);
        return;
      }

      case 'task':
        if (frame.event.type === 'task') emit(this.#taskListeners, frame.event.task);
        return;

      case 'cron':
        if (frame.event.type === 'cron') emit(this.#cronListeners, frame.event);
        return;

      case 'sleep':
        if (frame.event.type === 'sleep') emit(this.#sleepListeners, frame.event);
        return;

      case 'question':
        if (frame.event.type === 'question') emit(this.#questionListeners, frame.event);
        return;

      case 'question-closed':
        if (frame.event.type === 'question-closed') emit(this.#questionClosedListeners, frame.event);
        return;

      case 'changed':
        emit(this.#changedListeners, frame.change ?? { kind: frame.kind ?? '', id: frame.id ?? '' });
        return;

      case 'assignment-log':
        emit(this.#assignmentLogListeners, frame);
        return;

      case 'tui-opened': {
        const opening = this.#tuiOpens.get(frame.id);
        this.#tuiOpens.delete(frame.id);
        opening?.resolve({ sessionId: frame.sessionId, key: frame.key });
        return;
      }

      case 'tui-snapshot':
      case 'tui-data':
      case 'tui-state':
        emit(this.#tuiListeners, frame);
        return;

      case 'error':
        this.#handleErrorFrame(frame);
        return;

      case 'attached':
        this.#onAttached?.(frame);
        return;

      case 'event':
        // Quota is about the account, not the turn, so it is handed on even
        // when the turn itself is no longer ours to render (a reload mid-turn,
        // say). Everything else below belongs to a registered turn.
        if (frame.event.type === 'quota') emit(this.#quotaListeners, frame.event.quota);
        this.#handleEventFrame(frame);
        return;

      default:
        // `pong` and anything a newer server may add.
        return;
    }
  }

  /** An error names the `tui-open` or the turn it belongs to; one that names neither concerns nobody here. */
  #handleErrorFrame(frame: Extract<ServerFrame, { type: 'error' }>): void {
    if (!frame.id) return;
    const opening = this.#tuiOpens.get(frame.id);
    if (opening) {
      this.#tuiOpens.delete(frame.id);
      opening.reject(new Error(frame.message));
      return;
    }
    const turn = this.#pending.get(frame.id);
    this.#pending.delete(frame.id);
    turn?.onError(frame.message);
  }

  #handleEventFrame(frame: Extract<ServerFrame, { type: 'event' }>): void {
    const turn = this.#pending.get(frame.id);
    if (!turn) {
      this.#holdUnclaimed(frame);
      return;
    }
    // The journal position this frame carries is the guard of the handover:
    // a re-joined turn has already applied everything up to its cursor, so
    // an overlap frame is dropped instead of splicing duplicated text in.
    if (typeof frame.seq === 'number') {
      if (frame.seq <= turn.cursor) return;
      turn.cursor = frame.seq;
    }
    turn.onEvent(frame.event);

    if (frame.event.type === 'done') {
      this.#pending.delete(frame.id);
      turn.onDone(frame.event.text, frame.event.usage);
    } else if (frame.event.type === 'error' && frame.event.fatal) {
      this.#pending.delete(frame.id);
      turn.onError(frame.event.message);
    }
  }

  /** Keep a frame of a turn nobody has adopted yet until someone does. */
  #holdUnclaimed(frame: Extract<ServerFrame, { type: 'event' }>): void {
    let early = this.#unclaimed.get(frame.id);
    if (!early) {
      early = [];
      this.#unclaimed.set(frame.id, early);
      // Only the newest few turns: an announced turn is adopted within a
      // round trip or not at all.
      while (this.#unclaimed.size > MAX_UNCLAIMED_TURNS) {
        const oldest = this.#unclaimed.keys().next().value;
        if (oldest === undefined) break;
        this.#unclaimed.delete(oldest);
      }
    }
    if (early.length < MAX_UNCLAIMED_FRAMES) early.push(frame);
  }

  #send(frame: ClientFrame): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(frame));
    return true;
  }

  #setStatus(status: SocketStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    emit(this.#statusListeners, status);
  }

  #scheduleReconnect(): void {
    clearTimeout(this.#reconnectTimer ?? undefined);
    this.#attempt += 1;
    // 500ms, 1s, 2s, 4s ... capped, with jitter so reloads do not sync up.
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.#attempt - 1));
    const delay = base * (0.75 + Math.random() * 0.5);
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #clearPing(): void {
    clearInterval(this.#pingTimer ?? undefined);
    this.#pingTimer = null;
  }
}
