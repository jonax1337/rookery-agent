import type {
  AgentEvent,
  AgentMessage,
  AssignmentView,
  AssignPayload,
  ChatPayload,
  ClientFrame,
  Mail,
  MemoryRecord,
  OrgChange,
  ProviderQuota,
  RunTaskPayload,
  ServerFrame,
  Task,
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

/** One live-log entry of a running assignment this socket watches. */
export type AssignmentLogFrame = Extract<ServerFrame, { type: 'assignment-log' }>;

export interface TurnHandlers {
  onEvent(event: AgentEvent): void;
  onDone(text: string, usage?: TurnUsage): void;
  onError(message: string): void;
}

interface PendingTurn extends TurnHandlers {
  id: string;
}

const MAX_BACKOFF_MS = 15000;
const PING_INTERVAL_MS = 25000;

export class RookerySocket {
  #url: string;
  #ws: WebSocket | null = null;
  #status: SocketStatus = 'closed';
  #attempt = 0;
  #closedByUs = false;
  #pending = new Map<string, PendingTurn>();
  #statusListeners = new Set<(status: SocketStatus) => void>();
  #memoryListeners = new Set<(event: { sessionId: string; stored: MemoryRecord[] }) => void>();
  #assignmentListeners = new Set<(assignment: AssignmentView) => void>();
  #messageListeners = new Set<(message: AgentMessage) => void>();
  #mailListeners = new Set<(mail: Mail) => void>();
  #taskListeners = new Set<(task: Task) => void>();
  #cronListeners = new Set<(event: CronEvent) => void>();
  #changedListeners = new Set<(change: OrgChange) => void>();
  #sleepListeners = new Set<(event: SleepEvent) => void>();
  #quotaListeners = new Set<(quota: ProviderQuota) => void>();
  #assignmentLogListeners = new Set<(frame: AssignmentLogFrame) => void>();
  /** Assignments this socket should be watching, so a reconnect can re-arm them. */
  #watchedAssignments = new Set<string>();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    this.#url = url;
  }

  get status(): SocketStatus {
    return this.#status;
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  onMemory(listener: (event: { sessionId: string; stored: MemoryRecord[] }) => void): () => void {
    this.#memoryListeners.add(listener);
    return () => this.#memoryListeners.delete(listener);
  }

  /** Every assignment state change in the company, whoever started it. */
  onAssignment(listener: (assignment: AssignmentView) => void): () => void {
    this.#assignmentListeners.add(listener);
    return () => this.#assignmentListeners.delete(listener);
  }

  /** Every message posted between agents, their manager or the assistant. */
  onMessage(listener: (message: AgentMessage) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  /** Every mail sent between agents, the assistant or the user. */
  onMail(listener: (mail: Mail) => void): () => void {
    this.#mailListeners.add(listener);
    return () => this.#mailListeners.delete(listener);
  }

  /** Every task on the board that was created or changed state, whoever did it. */
  onTask(listener: (task: Task) => void): () => void {
    this.#taskListeners.add(listener);
    return () => this.#taskListeners.delete(listener);
  }

  /** A schedule was created, edited or deleted, or one of its runs changed state. */
  onCron(listener: (event: CronEvent) => void): () => void {
    this.#cronListeners.add(listener);
    return () => this.#cronListeners.delete(listener);
  }

  /** The memory fell asleep, moved on a phase, or woke up again. */
  onSleep(listener: (event: SleepEvent) => void): () => void {
    this.#sleepListeners.add(listener);
    return () => this.#sleepListeners.delete(listener);
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
  onQuota(listener: (quota: ProviderQuota) => void): () => void {
    this.#quotaListeners.add(listener);
    return () => this.#quotaListeners.delete(listener);
  }

  /** An agent, team, project or the company itself was created or edited. */
  onChanged(listener: (change: OrgChange) => void): () => void {
    this.#changedListeners.add(listener);
    return () => this.#changedListeners.delete(listener);
  }

  /**
   * Live-log entries of the running assignments this socket watches. Only
   * frames for ids this client sent `watchAssignment` for ever arrive, so the
   * listener does not need to filter - but it gets the whole frame, id
   * included, because one terminal component may serve several rows.
   */
  onAssignmentLog(listener: (frame: AssignmentLogFrame) => void): () => void {
    this.#assignmentLogListeners.add(listener);
    return () => this.#assignmentLogListeners.delete(listener);
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

  connect(): void {
    if (this.#ws && (this.#status === 'open' || this.#status === 'connecting')) return;
    this.#closedByUs = false;
    this.#setStatus('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.#url);
    } catch {
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
    // learned" toasts for one turn, two mail toasts for one mail - which is
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
      // A drop mid-turn must not leave the UI spinning forever.
      for (const turn of this.#pending.values()) {
        turn.onError('Connection to the Rookery server was lost.');
      }
      this.#pending.clear();
      if (!this.#closedByUs) this.#scheduleReconnect();
    };
  }

  close(): void {
    this.#closedByUs = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
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
    this.#pending.set(id, { id, ...handlers });

    const delivered = this.#send({ ...frame, id } as ClientFrame);
    if (!delivered) {
      this.#pending.delete(id);
      handlers.onError('Not connected to the Rookery server.');
    }
    return id;
  }

  abort(id: string): void {
    this.#send({ type: 'abort', id });
    this.#pending.delete(id);
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

    if (frame.type === 'pong') return;

    if (frame.type === 'memory') {
      for (const listener of this.#memoryListeners) listener(frame.event);
      return;
    }

    if (frame.type === 'assignment') {
      if (frame.event.type === 'assignment') {
        const view = frame.event.assignment;
        for (const listener of this.#assignmentListeners) listener(view);
      }
      return;
    }

    if (frame.type === 'message') {
      if (frame.event.type === 'message') {
        const message = frame.event.message;
        for (const listener of this.#messageListeners) listener(message);
      }
      return;
    }

    if (frame.type === 'mail') {
      if (frame.event.type === 'mail') {
        const mail = frame.event.mail;
        for (const listener of this.#mailListeners) listener(mail);
      }
      return;
    }

    if (frame.type === 'task') {
      if (frame.event.type === 'task') {
        const task = frame.event.task;
        for (const listener of this.#taskListeners) listener(task);
      }
      return;
    }

    if (frame.type === 'cron') {
      if (frame.event.type === 'cron') {
        const event = frame.event;
        for (const listener of this.#cronListeners) listener(event);
      }
      return;
    }

    if (frame.type === 'sleep') {
      if (frame.event.type === 'sleep') {
        const event = frame.event;
        for (const listener of this.#sleepListeners) listener(event);
      }
      return;
    }

    if (frame.type === 'changed') {
      for (const listener of this.#changedListeners) listener(frame.change);
      return;
    }

    if (frame.type === 'assignment-log') {
      for (const listener of this.#assignmentLogListeners) listener(frame);
      return;
    }

    if (frame.type === 'error') {
      if (frame.id) {
        const turn = this.#pending.get(frame.id);
        this.#pending.delete(frame.id);
        turn?.onError(frame.message);
      }
      return;
    }

    if (frame.type === 'event') {
      // Quota is about the account, not the turn, so it is handed on even
      // when the turn itself is no longer ours to render (a reload mid-turn,
      // say). Everything else below belongs to a registered turn.
      if (frame.event.type === 'quota') {
        const quota = frame.event.quota;
        for (const listener of this.#quotaListeners) listener(quota);
      }

      const turn = this.#pending.get(frame.id);
      if (!turn) return;
      turn.onEvent(frame.event);

      if (frame.event.type === 'done') {
        this.#pending.delete(frame.id);
        turn.onDone(frame.event.text, frame.event.usage);
      } else if (frame.event.type === 'error' && frame.event.fatal) {
        this.#pending.delete(frame.id);
        turn.onError(frame.event.message);
      }
    }
  }

  #send(frame: ClientFrame): boolean {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(frame));
    return true;
  }

  #setStatus(status: SocketStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#attempt += 1;
    // 500ms, 1s, 2s, 4s ... capped, with jitter so reloads do not sync up.
    const base = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.#attempt - 1));
    const delay = base * (0.75 + Math.random() * 0.5);
    this.#reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  #clearPing(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }
}
