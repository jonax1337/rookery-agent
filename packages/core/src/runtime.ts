import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type {
  Agent,
  AgentEvent,
  AssignmentLogEntry,
  AssignmentLogFrame,
  AssignmentLogSnapshot,
  CronJob,
  EffortLevel,
  MemoryRecord,
  NotifyEvent,
  PermissionLevel,
  ProviderId,
  RookeryConfig,
  ScoredMemory,
  Session,
  SessionKind,
  Task,
} from './types.js';
import { ASSISTANT_MEMORY_OWNER } from './types.js';
import { databasePath, loadConfig } from './config.js';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { ProviderRegistry } from './providers/registry.js';
import { sharedCodexBridge } from './providers/codex-bridge.js';
import type { ReportBackEvent, ToolContext } from './org/controller.js';
import { Store } from './memory/store.js';
import { linkEntities } from './memory/gate.js';
import { recall } from './memory/recall.js';
import { SleepRunner, type PromotionNotice } from './memory/sleep.js';
import { BridgeServer } from './org/bridge.js';
import { OrgController, taskNotification } from './org/controller.js';
import { QuestionRegistry } from './org/questions.js';
import { SkillStore } from './skills/store.js';
import { CronScheduler } from './cron/scheduler.js';
import { EventQueue, titleFromBrief } from './util/queue.js';
import { BoardWatch } from './assistant/board-watch.js';
import { chatTurn } from './assistant/chat-turn.js';
import { DreamRecorder } from './assistant/dream-recorder.js';
import { journalledTurn, type JournalContext } from './assistant/journalled-turn.js';
import { learnFromExchange } from './assistant/memory-learning.js';
import { promotionMessage } from './assistant/promotion-notice.js';
import { ScheduledRuns } from './assistant/scheduled-runs.js';
import {
  createSession,
  pinProject,
  resolveSession,
  sessionPermissionKey,
  SessionTurnQueue,
  type NewSessionInput,
} from './assistant/sessions.js';
import { ConversationTerminals, conversationTerminalKey } from './assistant/terminals.js';
import { storeTypedTurn } from './assistant/terminal-turn.js';
import { reportIfRejected, type TurnServices } from './assistant/turn-support.js';
import type {
  AssignInput,
  AssistantOptions,
  ChatInput,
  FollowUpEvent,
  RunTaskInput,
  TurnRunner,
} from './assistant/types.js';

export { conversationTerminalKey } from './assistant/terminals.js';
export type {
  AssignInput,
  AssistantOptions,
  ChatInput,
  FollowUpEvent,
  MemoryLearnedEvent,
  RunTaskInput,
  TurnRunner,
} from './assistant/types.js';

/**
 * The assistant runtime.
 *
 * One turn is: resolve session -> recall memories -> assemble context ->
 * stream the provider -> persist -> learn.
 *
 * There is no routing step and no agent selection. Rookery is one personal
 * assistant: the identity is fixed, and the provider only ever changes when
 * the caller asks for it, when the current one is logged out, or - the one
 * exception - when it runs out of quota, in which case the turn switches
 * once and says so. That matters beyond persona: switching provider throws
 * away `providerSessionId`, so a router that changed its mind
 * mid-conversation would silently drop the thread the assistant was holding.
 *
 * What the assistant can do beyond talking is run its company: every turn
 * gets Rookery's tools through the MCP bridge, and an `assign` call from
 * inside the provider process starts an agent in the background. Those
 * assignments report into the same event stream as the turn itself.
 *
 * The assistant's own process always runs in the workspace. It never sees
 * the directory Rookery was started from; only agents work in project
 * directories, and only when the project names one.
 *
 * The turn itself lives in `assistant/`: this class owns the collaborators,
 * the public surface and the events it re-broadcasts.
 */
export class Assistant extends EventEmitter {
  readonly config: RookeryConfig;
  readonly store: Store;
  readonly providers: ProviderRegistry;
  readonly log: Logger;
  /** The company: structure, rules and assignment execution. */
  readonly org: OrgController;
  /** The skills folder: written procedures the assistant and agents open on demand. */
  readonly skills: SkillStore;
  /**
   * The clock: schedules that fire while the process is up. Created here so
   * the assistant's tools can manage them, started by whoever hosts the
   * runtime for real (the server), never by a one-off CLI command.
   */
  readonly cron: CronScheduler;
  /**
   * The night shift: condensing, linking and concluding over the memory
   * bank while nobody is talking. Fires from a schedule like anything else,
   * and can be started by hand from the memory page.
   */
  readonly sleep: SleepRunner;
  /**
   * The questions the assistant has put to the user and is waiting on. Held
   * here, next to the company and the clock, because a question outlives the
   * surface it appeared on: whoever is at a screen may answer it, so it
   * cannot belong to one socket, one terminal or one chat.
   */
  readonly questions: QuestionRegistry;
  /**
   * Whether a notification would actually reach the user right now. Set by
   * whoever owns the outgoing channels (the server, for its gateways); left
   * unset, the `notify` tool falls back to "is anything listening at all".
   * A function rather than a flag because the answer changes with a setting,
   * a blocked recipient or a channel that was switched off mid-session.
   */
  notifyProbe?: () => boolean;
  /** Takes over report-back turns so people can watch them; see `TurnRunner`. */
  turnRunner?: TurnRunner;
  readonly #sessionTurns = new SessionTurnQueue();
  readonly #boardWatch: BoardWatch;
  readonly #recorder: DreamRecorder;
  readonly #terminals: ConversationTerminals;
  readonly #turnServices: TurnServices;
  readonly #journalContext: JournalContext;
  readonly #scheduledRuns: ScheduledRuns;

  constructor(options: AssistantOptions = {}) {
    super();
    this.config = loadConfig(options.config ?? {});
    this.store = options.store ?? new Store(databasePath(this.config));
    this.providers = options.registry ?? new ProviderRegistry();
    // Layer in configured provider profiles (e.g. GLM). A no-op when there
    // are none, and harmless for the fixed provider lists tests inject.
    this.providers.sync(this.config);
    this.log =
      options.logger ??
      (this.config.logLevel === 'silent'
        ? silentLogger
        : createLogger({ level: this.config.logLevel, home: this.config.home, scope: 'runtime' }));
    this.skills = new SkillStore(this.config.skillsDir);
    this.cron = new CronScheduler({
      store: this.store,
      runner: (job, _run, signal) => this.#scheduledRuns.run(job, signal),
      logger: this.log,
      timeoutMs: this.config.org.assignmentTimeoutMs,
      // A run's outcome goes the one road to the user. A closure, because
      // the controller is built below; no run can end before it exists.
      notify: (input) => {
        this.org.notifyUser(input);
      },
    });
    // Before the controller: the `sleep_now` tool needs it at construction.
    // The promotion hook is a closure rather than `this.org.notifyUser`
    // itself for exactly that reason - the controller does not exist yet
    // here, and it does by the time a night can promote anything.
    this.sleep = new SleepRunner({
      store: this.store,
      registry: this.providers,
      config: this.config,
      logger: this.log,
      onPromotion: (notice) => this.announcePromotion(notice),
    });
    // Before the controller, like the night shift: the `ask_user` tool needs
    // it at construction. Its own emitter is what the Assistant re-broadcasts:
    // a question-closed can arrive after the asking turn's queue has closed -
    // answered late, or cancelled when the turn's token was retired - and the
    // turn stream would drop it exactly then, so the registry is the one wire
    // both halves can rely on.
    this.questions = new QuestionRegistry();
    this.questions.on('question', (event: AgentEvent) => this.emit('question', event));
    this.questions.on('question-closed', (event: AgentEvent) => this.emit('question-closed', event));
    this.org = new OrgController({
      store: this.store,
      registry: this.providers,
      config: this.config,
      bridge: new BridgeServer({ runDir: join(this.config.home, 'run') }),
      logger: this.log,
      cron: this.cron,
      sleep: this.sleep,
      questions: this.questions,
      // The `notify` tool asks this instead of a transport it cannot see. A
      // listener on `notify` is the floor, not the answer: a push service
      // attaches once at startup and stays attached while it is switched
      // off, so a bare listener count would let the tool report "Sent" into
      // a channel that drops the message. Whoever hosts the runtime sets
      // `notifyProbe` to the honest test.
      canNotify: () => (this.notifyProbe ? this.notifyProbe() : this.listenerCount('notify') > 0),
    });

    this.#boardWatch = new BoardWatch({
      store: this.store,
      cron: this.cron,
      org: this.org,
      config: this.config,
      log: this.log,
    });
    this.#recorder = new DreamRecorder({ store: this.store, config: this.config, log: this.log });
    const collaborators = {
      config: this.config,
      store: this.store,
      log: this.log,
      providers: this.providers,
      org: this.org,
      skills: this.skills,
      cron: this.cron,
      questions: this.questions,
    };
    this.#terminals = new ConversationTerminals({
      ...collaborators,
      onTypedTurn: (sessionId, turn, openedWith) => storeTypedTurn(this.#turnServices, sessionId, turn, openedWith),
      onChanged: (sessionId) => this.#announceSessionChanged(sessionId),
    });
    this.#turnServices = {
      ...collaborators,
      terminals: this.#terminals,
      recorder: this.#recorder,
      announceTool: (event) => {
        this.emit('tool', event);
      },
      announceChanged: (sessionId) => this.#announceSessionChanged(sessionId),
      learn: (sessionId, userText, assistantText, providerId) =>
        this.#learn(sessionId, userText, assistantText, providerId),
    };
    this.#journalContext = { store: this.store, config: this.config, recorder: this.#recorder };
    this.#scheduledRuns = new ScheduledRuns({
      config: this.config,
      store: this.store,
      sleep: this.sleep,
      boardWatch: this.#boardWatch,
      chat: (input) => this.chat(input),
      assign: (input) => this.assign(input),
      createSession: (input) => this.createSession(input),
    });
    this.#relayEvents();
  }

  /** What every client hears about, from the clock, the night shift and the company. */
  #relayEvents(): void {
    this.cron.on('cron', (event: AgentEvent) => this.emit('cron', event));
    this.cron.on('message', (event: AgentEvent) => this.emit('message', event));
    // Only a scheduler without the `notify` hook emits this itself; wired
    // anyway so an outcome can never be written without being announced.
    this.cron.on('notification', (event: AgentEvent) => this.emit('notification', event));
    // Every client watches the brain fall asleep and wake up again.
    this.sleep.on('sleep', (event: AgentEvent) => this.emit('sleep', event));
    // Anything an agent does is interesting to every client, not only the
    // turn that caused it: the org page shows activity live.
    this.org.on('assignment', (event: AgentEvent) => this.emit('assignment', event));
    // Live transcript lines of a running assignment, for whoever opted into
    // watching that run - the TUI's watch mode and the server's watching
    // sockets, never a blanket fan-out.
    this.org.on('assignment-log', (frame: AssignmentLogFrame) => this.emit('assignment-log', frame));
    this.org.on('message', (event: AgentEvent) => this.emit('message', event));
    // Everything that reaches the user outside a conversation, and every
    // line added to a card's activity - the two carriers that replaced mail
    // (docs/concepts/mail-removal-notifications-and-task-activity.md).
    this.org.on('notification', (event: AgentEvent) => this.emit('notification', event));
    this.org.on('task-event', (event: AgentEvent) => this.emit('task-event', event));
    this.org.on('task', (event: AgentEvent) => this.emit('task', event));
    // The watcher's fast path (section 5): a task landing in `failed` or
    // `blocked` wakes it through the same event machinery a webhook or an
    // IMAP listener uses, no different from any other schedule.
    this.org.on('task', (event: AgentEvent) => this.#boardWatch.onTaskEvent(event));
    this.org.on('changed', (change: { kind: string; id: string }) => this.emit('changed', change));
    // The assistant reaching out on its own initiative - no HTTP, no
    // Telegram here, just an event a channel in another package can listen
    // for and act on however it likes.
    this.org.on('notify', (event: NotifyEvent) => this.emit('notify', event));
    // Work handed off in the background has ended: the conversation that
    // handed it off hears about it as a turn of its own (R2/R3).
    this.org.on('report-back', (event: ReportBackEvent) => this.#onReportBack(event));
  }

  #announceSessionChanged(sessionId: string): void {
    this.emit('changed', { kind: 'session', id: sessionId });
  }

  close(): void {
    // Anything still waiting on a person is settled first: an open question
    // holds a promise inside a tool call, and shutting down around it would
    // leave that call to time out long after there is anybody to answer.
    this.questions.cancelAll();
    this.cron.stop();
    // No terminal or gateway outlives the runtime that owns it.
    this.#terminals.shutdown();
    reportIfRejected(this.org.bridge.close(), this.log, 'Closing the MCP bridge');
    reportIfRejected(sharedCodexBridge.close(), this.log, 'Closing the Codex bridge');
    this.store.close();
  }

  /* --------------------------- report-back --------------------------- */

  #onReportBack(event: ReportBackEvent): void {
    const session = this.store.getSession(event.sessionId);
    // A scheduled run has nobody reading along, and a conversation that was
    // deleted has nobody at all. The ending still belongs to somebody, and
    // the only one left is the user: it goes to them as a notification
    // instead of a turn nobody would see - a question most of all.
    if (!session || (session.kind !== 'chat' && session.kind !== 'voice')) {
      this.#notifyReportBack(event, session);
      return;
    }
    // Archived while the work ran: bringing it back is better than burying
    // the answer where nobody looks.
    if (session.archived) this.store.updateSession(session.id, { archived: false });
    this.followUp({ sessionId: session.id, text: event.notice, taskId: event.taskId });
  }

  #notifyReportBack(event: ReportBackEvent, session: Session | null): void {
    const task = this.store.org.getTask(event.taskId);
    if (!task) return;
    const agent = task.assigneeId ? this.store.org.getAgent(task.assigneeId) : null;
    const question = task.status === 'blocked' ? this.store.org.lastTaskEvent(task.id, 'question') : null;
    this.org.notifyUser({
      orgId: task.orgId,
      ...taskNotification(task, agent, question?.text),
      ...(session ? { sessionId: session.id } : {}),
    });
  }

  /**
   * A turn in a conversation that nobody typed: Rookery telling the
   * assistant something it has to pass on - today, how work it handed off
   * ended. It runs like any other turn of that conversation, after whatever
   * is being answered there now, and the host shows it live (`turnRunner`).
   * Returns the turn id.
   */
  followUp(input: { sessionId: string; text: string; taskId?: string }): string {
    const turnId = randomUUID();
    const controller = new AbortController();
    const permission = this.store.getMeta(sessionPermissionKey(input.sessionId)) as PermissionLevel | null;
    const events = this.#reported(
      this.chat({
        text: input.text,
        sessionId: input.sessionId,
        turnId,
        origin: 'system',
        ...(permission ? { permission } : {}),
        signal: controller.signal,
      }),
      input,
    );
    if (this.turnRunner) {
      this.turnRunner({ turnId, sessionId: input.sessionId, controller, events });
    } else {
      void (async () => {
        for await (const event of events) void event;
      })().catch((error: unknown) => this.log.warn('Follow-up turn failed', { error: String(error) }));
    }
    return turnId;
  }

  /** Passes a follow-up's events through and says how it ended, once, however it ends. */
  async *#reported(
    events: AsyncGenerator<AgentEvent, void, unknown>,
    input: { sessionId: string; taskId?: string },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    let text = '';
    let error: string | undefined;
    try {
      for await (const event of events) {
        if (event.type === 'done') text = event.text;
        else if (event.type === 'error' && event.fatal) error = event.message;
        yield event;
      }
    } catch (thrown) {
      error = (thrown as Error).message;
      throw thrown;
    } finally {
      const done: FollowUpEvent = {
        sessionId: input.sessionId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        text,
        ...(error ? { error } : {}),
      };
      this.emit('follow-up', done);
    }
  }

  /* ---------------------------- sessions ---------------------------- */

  createSession(input: NewSessionInput = {}): Session {
    return createSession(this, input);
  }

  getSession(id: string): Session | null {
    return this.store.getSession(id);
  }

  /**
   * Recent sessions; `agentId` narrows to one counterpart (`null` = the
   * assistant), `kind` to chats or voice. Archived conversations stay out
   * unless asked for, because archiving is how a list is kept short.
   */
  listSessions(limit = 50, agentId?: string | null, kind?: SessionKind, includeArchived = false): Session[] {
    return this.store.listSessions({ limit, agentId, kind, includeArchived });
  }

  deleteSession(id: string): void {
    // Its terminal goes first: a process left running would go on writing a
    // transcript into a conversation that no longer exists.
    this.#terminals.closeNow(id);
    // A frame is a verbatim store of what was said in this session, so it
    // may never outlive the session it quotes (R17). Dropped before the
    // session row goes, the same safe direction the memory-retiring store
    // methods take for their owner's frames.
    this.store.dropDreamFramesForSession(id);
    this.store.deleteSession(id);
  }

  /** Forget the provider-side thread so the next turn starts cold. */
  resetSessionContext(id: string): void {
    // `updateSession` leaves an undefined field alone, so clearing a column
    // takes the statement itself.
    this.store.db
      .prepare('UPDATE sessions SET provider_session_id = NULL WHERE id = ?')
      .run(id);
  }

  /* ------------------------------ memory ---------------------------- */

  /**
   * Read-only memory search for surfaces that inspect the bank. This is the
   * `site: 'inspect'` population of the dream's vocabulary: never framed,
   * never scored - the recorder sits at the conversational call site, never
   * inside `recall` (R19), precisely so a browser search or a CLI call with a
   * free-form owner cannot end up in the night's pool.
   */
  recallMemories(text: string, limit?: number): ScoredMemory[] {
    return recall(this.store, {
      text,
      limit: limit ?? this.config.memory.recallLimit,
      threshold: this.config.memory.recallThreshold,
      hopEntity: this.config.memory.graph.hopEntity,
      hopEdge: this.config.memory.graph.hopEdge,
      touch: false,
    });
  }

  /**
   * Something the user told us to keep. Marked `user`, which makes it
   * untouchable for the nightly run: it is never merged away and never put
   * to sleep, however little it gets recalled.
   */
  rememberFact(input: {
    content: string;
    kind?: MemoryRecord['kind'];
    tags?: string[];
    importance?: number;
    pinned?: boolean;
  }): MemoryRecord {
    const record = this.store.upsertMemory({
      kind: input.kind ?? 'fact',
      content: input.content,
      tags: input.tags,
      importance: input.importance,
      owner: ASSISTANT_MEMORY_OWNER,
      origin: 'user',
      pinned: input.pinned,
    });
    linkEntities(this.store, ASSISTANT_MEMORY_OWNER, record.id, input.tags ?? []);
    return record;
  }

  /** Extract and store durable memories from a finished exchange, when learning is on. */
  #learn(sessionId: string, userText: string, assistantText: string, providerId: ProviderId): void {
    const { memory } = this.config;
    if (!memory.enabled || !memory.autoExtract) return;
    void learnFromExchange(
      this,
      { sessionId, userText, assistantText, providerId, owner: ASSISTANT_MEMORY_OWNER },
      (event) => this.emit('memory', event),
    );
  }

  /* ------------------------------- sleep ---------------------------- */

  /** Run a night by hand, for one bank. The memory page's "sleep now". */
  async sleepNow(owner: string = ASSISTANT_MEMORY_OWNER, signal?: AbortSignal) {
    return this.sleep.run({ owner, trigger: 'manual', signal });
  }

  sleepRuns(owner?: string, limit = 30) {
    return this.store.listSleepRuns({ owner, limit });
  }

  /** Take one night back, in a single transaction. */
  undoSleep(runId: string) {
    return this.sleep.undo(runId);
  }

  /**
   * Make sure the nightly run has a schedule. Called once when the clock
   * starts. The job is an ordinary `cron_jobs` row - one timer, no second
   * hidden one anywhere - but it is Rookery's internal clockwork, not a
   * user schedule: every list filters it out, and the memory page is the
   * only place it is shown and managed.
   */
  ensureSleepSchedule(): CronJob | null {
    const sleep = this.config.memory.sleep;
    if (!sleep.enabled) return null;
    try {
      const organization = this.org.activeOrganization();
      const existing = this.cron
        .list(organization.id, { includeSystem: true })
        .find((job) => job.kind === 'sleep');
      if (existing) {
        // Follow the config when the user changes it there, but never
        // re-enable a job they switched off by hand.
        if (existing.schedule !== sleep.schedule && existing.enabled) {
          return this.cron.update(existing.id, { schedule: sleep.schedule });
        }
        return existing;
      }
      return this.cron.create({
        orgId: organization.id,
        name: 'Memory sleep',
        schedule: sleep.schedule,
        kind: 'sleep',
        prompt: sleep.scope,
        createdBy: 'user',
      });
    } catch (error) {
      this.log.warn('Could not set up the nightly memory schedule', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * A retrieval policy went in force, so the user hears about it (S26,
   * concept 9.6). This is the one place that can say so: the night owns the
   * promotion and knows nothing about notifications, the controller owns them and
   * knows nothing about the night, and the runtime holds both.
   *
   * A failing send costs the message, never the night: `#announcePromotion`
   * in sleep.ts catches whatever comes back out of here, and this catches
   * first so the warning names the notice rather than the hook.
   */
  async announcePromotion(notice: PromotionNotice): Promise<void> {
    const { title, body } = promotionMessage(notice);
    try {
      // A `sleep` notification, from Rookery itself. It used to be a mail
      // from the user to the user, which no push filter ever let through -
      // the promotion reached the web inbox and never the phone.
      this.org.notifyUser({
        orgId: this.org.activeOrganization().id,
        kind: 'sleep',
        title,
        body,
        fromKind: 'system',
      });
    } catch (error) {
      this.log.warn('Could not post the promotion notice', {
        owner: notice.owner,
        slot: notice.slot,
        policy: notice.version.id,
        error: (error as Error).message,
      });
    }
  }

  /* ------------------------------- board watch ----------------------------- */

  /** Make sure the board has a watcher. Called once when the clock starts. */
  ensureBoardWatchSchedule(): CronJob | null {
    return this.#boardWatch.ensureSchedule();
  }

  /* ------------------------------- chat ----------------------------- */

  /**
   * One conversational turn, streamed - and journalled while it runs (see
   * `journalledTurn`).
   *
   * One conversation answers one message at a time: a turn in a known
   * conversation waits for the one before it. A new conversation has nothing
   * to wait for - nobody else can know its id yet.
   */
  async *chat(input: ChatInput): AsyncGenerator<AgentEvent, void, unknown> {
    const release = input.sessionId ? await this.#sessionTurns.take(input.sessionId) : undefined;
    try {
      yield* journalledTurn(this.#journalContext, input, (guarded, turnId, journal) =>
        chatTurn(this.#turnServices, guarded, turnId, journal),
      );
    } finally {
      release?.();
    }
  }

  /* ------------------------------ assign ---------------------------- */

  /**
   * Give one agent a task directly, outside a conversation. Streams the
   * run's events and ends with `done` carrying the report.
   *
   * Like every other way of handing out work, this puts a card on the board
   * first (decision E9). It used to call `org.run()` straight, and it is the
   * entrance the web UI, the websocket, the CLI and every agent schedule all
   * come through - so the single biggest source of "sometimes there is a
   * card and sometimes there is only a run" was this one method. The
   * `assign` tool had already been moved onto the board; this is the same
   * move for everything that is not a tool call.
   */
  async *assign(input: AssignInput): AsyncGenerator<AgentEvent, void, unknown> {
    const task = input.task.trim();
    if (!task) {
      yield { type: 'error', message: 'The task is empty.', fatal: true };
      return;
    }
    const organization = this.org.activeOrganization();
    const agent: Agent | null = this.store.org.findAgent(organization.id, input.agent);
    if (!agent) {
      yield { type: 'error', message: 'No agent "' + input.agent + '".', fatal: true };
      return;
    }
    if (input.projectId && !this.store.org.getProject(input.projectId)) {
      yield { type: 'error', message: 'No project ' + input.projectId + '.', fatal: true };
      return;
    }

    // The card comes first and the run hangs off it, so this work is on the
    // board from the moment it is handed over rather than only visible as a
    // row under "runs". `createdBy: 'user'` is the truth here: every caller
    // of this method is a person acting directly, or a schedule they set up.
    const card = this.store.org.createTask({
      orgId: organization.id,
      title: input.title?.trim() || titleFromBrief(task),
      description: task,
      projectId: input.projectId,
      assigneeId: agent.id,
      createdBy: 'user',
      // A card that appeared at three in the morning can say why. The work
      // is still the user's - they set the schedule up - so `createdBy`
      // stays `user` and this only names the arrangement that fired.
      scheduleId: input.scheduleId,
    });
    this.org.announceTask(card);

    const finished = yield* this.#streamRun(
      {
        orgId: organization.id,
        audience: 'assistant',
        depth: -1,
        projectId: input.projectId,
        // The conversation this was started from, when there was one. It
        // is what links the run back into that chat's journal; dropping
        // it left `turns.session_id` null and the run unfindable from the
        // conversation that asked for it.
        sessionId: input.sessionId,
        scheduled: input.scheduled,
        signal: input.signal,
      },
      card,
    );

    if (finished.status === 'done') {
      yield { type: 'done', text: finished.result ?? '' };
    } else if (finished.status === 'blocked') {
      // Not a failure: somebody was asked something and the board is
      // waiting for them. Saying "the run blocked" as an error made a
      // perfectly good question read as a breakage.
      yield { type: 'done', text: finished.result ?? 'Waiting for an answer.' };
    } else {
      yield {
        type: 'error',
        message: 'The run ' + finished.status + (finished.error ? ': ' + finished.error : '.'),
        fatal: true,
      };
    }
  }

  /**
   * Runs a card and streams what the run emits - the provider's events and
   * everything its tool calls cause in the company - then hands back the
   * card as it ended.
   */
  async *#streamRun(context: Omit<ToolContext, 'emit'>, card: Task): AsyncGenerator<AgentEvent, Task, unknown> {
    const queue = new EventQueue<AgentEvent>();
    const run = this.org
      .runTask({ ...context, emit: (event) => queue.push(event) }, card)
      .finally(() => queue.close());
    let drained = false;
    try {
      for await (const event of queue.drain()) yield event;
      drained = true;
    } finally {
      // A consumer that walked away never awaits the run.
      if (!drained) reportIfRejected(run, this.log, 'Task run, after its stream ended,');
    }
    return await run;
  }

  /* ---------------------------- assignment log ---------------------------- */

  /**
   * The live log of a running assignment so far; an unknown or finished id
   * reads as inactive and empty. Delegates to the org controller.
   */
  snapshotAssignmentLog(assignmentId: string): AssignmentLogSnapshot | null {
    return this.org.snapshotAssignmentLog(assignmentId);
  }

  /**
   * Follow one running assignment's live log; the returned unsub stops the
   * listener. Delegates to the org controller.
   */
  watchAssignmentLog(assignmentId: string, listener: (entry: AssignmentLogEntry) => void): () => void {
    return this.org.watchAssignmentLog(assignmentId, listener);
  }

  /**
   * Replay a running assignment's buffered log, then follow it live until
   * the run ends. Delegates to the org controller.
   */
  async *assignmentLog(assignmentId: string): AsyncGenerator<AssignmentLogEntry, void, unknown> {
    yield* this.org.assignmentLog(assignmentId);
  }

  /* ------------------------------- tasks ---------------------------- */

  /** Plan one task from the board on the user's behalf. Throws when the task is unknown. */
  async planTask(taskId: string, hint?: string) {
    const organization = this.org.activeOrganization();
    const task = this.org.findTask(organization.id, taskId);
    if (!task) throw new Error('No task ' + taskId + '.');
    return this.org.planTask({ orgId: organization.id, audience: 'assistant', depth: -1, emit: () => {} }, task, hint);
  }

  /**
   * Run one task from the board on the user's behalf. Streams task and
   * assignment events and ends with `done` carrying the combined result.
   */
  async *runTask(input: RunTaskInput): AsyncGenerator<AgentEvent, void, unknown> {
    const organization = this.org.activeOrganization();
    const task = this.org.findTask(organization.id, input.taskId);
    if (!task) {
      yield { type: 'error', message: 'No task ' + input.taskId + '.', fatal: true };
      return;
    }
    const finished = yield* this.#streamRun(
      {
        orgId: organization.id,
        audience: 'assistant',
        depth: -1,
        projectId: task.projectId,
        signal: input.signal,
      },
      task,
    );
    if (finished.status === 'done') {
      yield { type: 'done', text: finished.result ?? '' };
    } else {
      yield {
        type: 'error',
        message: 'Task ' + finished.status + (finished.error ? ': ' + finished.error : '.'),
        fatal: true,
      };
    }
  }

  /* ------------------------- conversation terminal ------------------------ */

  /**
   * The terminal view of a conversation: the same Claude Code process every
   * chat message of it is typed into (T1), opened here if nothing has opened
   * it yet. Switching between chat and terminal loses nothing because there
   * is nothing to switch - it is one process with one transcript, and what a
   * person types into it lands in the conversation like any other message.
   */
  async openConversationTerminal(input: {
    sessionId?: string;
    provider?: ProviderId;
    model?: string;
    effort?: EffortLevel;
    permission?: PermissionLevel;
    projectId?: string;
  }): Promise<{ sessionId: string; key: string }> {
    const session = resolveSession(this, input);
    const opened = { sessionId: session.id, key: conversationTerminalKey(session.id) };
    if (this.#terminals.running(session.id)?.handle.alive()) return opened;
    pinProject(this.store, session, input.projectId);
    const providerId = await this.providers.resolveUsable(input.provider ?? session.provider);
    if (!providerId) throw new Error('No AI provider is ready.');
    await this.#terminals.ensure(session, {
      providerId,
      model: input.model ?? session.model ?? this.config.defaultModel,
      effort: input.effort ?? this.config.defaultEffort,
      permission: input.permission ?? this.config.defaultPermission,
    });
    return opened;
  }

  /** Ends the conversation's terminal. False when it had none. */
  closeConversationTerminal(sessionId: string): boolean {
    return this.#terminals.closeNow(sessionId);
  }
}
