import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type {
  EffortLevel,
  Agent,
  AgentEvent,
  AssignmentLogEntry,
  AssignmentLogFrame,
  AssignmentLogSnapshot,
  CronJob,
  CronRun,
  Mail,
  MemoryRecord,
  NotifyEvent,
  PermissionLevel,
  ProviderId,
  RecallBox,
  RecallPolicy,
  RookeryConfig,
  ScoredMemory,
  Session,
  SessionKind,
  TaskStatus,
  TurnUsage,
} from './types.js';
import { ASSISTANT_MEMORY_OWNER } from './types.js';
import { databasePath, loadConfig } from './config.js';
import { createLogger, silentLogger, type Logger } from './logger.js';
import { ProviderRegistry } from './providers/registry.js';
import { remapModel } from './providers/provider-catalog.js';
import { isUsageLimitError, providerBlocked, providerLow, rememberUsageFailure } from './providers/quota.js';
import { sharedCodexBridge } from './providers/codex-bridge.js';
import { Store } from './memory/store.js';
import { byScoreThenId, coreProfile, dropContradicted, recall } from './memory/recall.js';
import { fetchFrame } from './memory/dream/frame.js';
import { resolvePolicy } from './memory/dream/policy.js';
import { DEFAULT_SPLIT_RATES, splitOf } from './memory/dream/evaluate.js';
import { episodeFromEvents } from './memory/dream/trajectory.js';
import { extractMemories, smallModelFor } from './memory/extractor.js';
import { admitCandidates, linkEntities } from './memory/gate.js';
import { SleepRunner, type PromotionNotice } from './memory/sleep.js';
import { buildSystemPrompt, deriveTitle } from './agents/persona.js';
import { BridgeServer } from './org/bridge.js';
import { OrgController } from './org/controller.js';
import { QuestionRegistry } from './org/questions.js';
import { assistantOrgBlock } from './org/prompts.js';
import { dormantToolsHint, externalTurnExtras, toolServersFor } from './tools/hub.js';
import { SkillStore, renderSkillsIndex } from './skills/store.js';
import { renderExternalSkillsHint } from './skills/shelf.js';
import { matchSkills, renderSkillMatches } from './skills/suggest.js';
import { CronScheduler, type CronRunOutcome } from './cron/scheduler.js';
import { describeCron } from './cron/parse.js';
import { runCronScript } from './cron/script.js';
import { EventQueue, titleFromBrief } from './util/queue.js';
import { formatAge, formatNow } from './util/time.js';
import { TurnBlocks } from './util/blocks.js';

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
 */

/**
 * How many provider processes one turn may use. Two, because a turn that
 * attaches a tool server needs a second process to actually get it, and
 * because a third would let the assistant loop over its own switches.
 */
const MAX_PROVIDER_PASSES = 2;

/**
 * How many providers one turn may run on. The second only happens when the
 * first died on its usage limit with nothing to show for it, so a switch
 * costs one provider session, never the thread the turn was holding.
 */
const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * The board watcher's schedule id, deterministic so it stays findable across a
 * restart - every other schedule id is a random uuid. One per organisation.
 */
function boardWatchJobId(orgId: string): string {
  return 'board-watch:' + orgId;
}

/** Wide enough that the clock rarely fires it: the event path is the fast one, this is its backstop. */
const BOARD_WATCH_SCHEDULE = '*/30 * * * *';

/**
 * What the watcher is told to look at (E8, F3). It reports; it does not act.
 *
 * The earlier wording told it to "do whatever actually helps - reassign it,
 * follow up with a fresh run on the same task, or restart it". That made the
 * watcher the unattended caller with the widest reach in the system, and it
 * fired hardest on `blocked` - the one status that means a person was asked
 * something. The right answer to an open question is to wait for it, so the
 * watcher now only says what it found. `WATCH_TOOLS` in org/tools.ts is what
 * enforces that; this prompt only explains it.
 */
const BOARD_WATCH_PROMPT =
  'Watch the board and report what needs a person. Check list_tasks for anything failed, and for ' +
  'anything running far longer than it should. You are a backstop, not a worker: you cannot start, ' +
  'reassign, restart or close anything, and that is deliberate - deciding what to do about what you ' +
  'find belongs to the user. Mail the user at most once per pass, and only when something truly ' +
  'needs a human decision: say what you saw, how long it has been that way, and what you would ' +
  'suggest. A task waiting on an answer is working as intended, not a fault, and never a reason to ' +
  'write. If none of what you were shown is worth interrupting somebody over, do not report that ' +
  'everything is fine - answer with exactly [SILENT] instead.';

/** Add up what two passes of one turn cost; the last pass owns the context gauge. */
function mergeUsage(base: TurnUsage | undefined, next: TurnUsage | undefined): TurnUsage | undefined {
  if (!base) return next;
  if (!next) return base;
  const sum = (a?: number, b?: number): number | undefined => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  return {
    inputTokens: sum(base.inputTokens, next.inputTokens),
    outputTokens: sum(base.outputTokens, next.outputTokens),
    cachedInputTokens: sum(base.cachedInputTokens, next.cachedInputTokens),
    reasoningTokens: sum(base.reasoningTokens, next.reasoningTokens),
    costUsd: sum(base.costUsd, next.costUsd),
    contextTokens: next.contextTokens ?? base.contextTokens,
    contextWindow: next.contextWindow ?? base.contextWindow,
  };
}

/**
 * What the second pass is asked. It is not the user talking, and it says so:
 * the assistant should pick the work back up, not answer this sentence.
 */
function continuePrompt(servers: string[]): string {
  return [
    '[Rookery] The tool servers you just switched on are attached now: ' + servers.join(', ') + '.',
    'This message is from the system, not from your user, so do not address it and do not greet.',
    'Carry on with what you stopped for, using the new tools, and finish the answer without',
    'repeating what you already said.',
  ].join(' ');
}

/* --------------------------- dream recorder --------------------------- */

/**
 * Salt for the dream's session-level sample draw. A fixed literal, not a
 * per-process random: the sample must survive a restart, because it is drawn
 * per session - consecutive turns of one session share topic, bank cutout and
 * entity neighbourhood, and a restart must not split them across the sample.
 */
const DREAM_SAMPLE_SALT = 'rookery.dream.sample.v1';

/**
 * The sample draw of one session as a number in [0, 1): FNV-1a over the
 * session id and the salt. Cheap, stable and portable - it only has to be
 * deterministic, never cryptographic.
 */
function dreamSampleDraw(sessionId: string): number {
  let hash = 0x811c9dc5;
  const input = sessionId + DREAM_SAMPLE_SALT;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/** Clamp to a range, for dream keys read outside the patch schema (E21). */
function clampNumber(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The declared box around one turn's realised recall policy: the parameter
 * space a replay of this turn's frame may move in. The interval widths are
 * the house widths the night's grid places its candidates at - weights
 * +/-0.1, threshold [0.05, 0.3], hop weights +/-0.15 and +/-0.2 - always
 * stretched to contain the realised point and never past the valid range,
 * so a knob the user turned cannot sit outside the box that is supposed to
 * close over it. `limitMax` arrives already containing the realised limit.
 */
function declaredDreamBox(policy: RecallPolicy, limitMax: number): RecallBox {
  const weight = (value: number): [number, number] => [Math.max(0, value - 0.1), Math.min(1, value + 0.1)];
  return {
    limitMax,
    w: {
      relevance: weight(policy.w.relevance),
      importance: weight(policy.w.importance),
      recency: weight(policy.w.recency),
      usage: weight(policy.w.usage),
    },
    threshold: [Math.min(0.05, policy.threshold), Math.max(0.3, policy.threshold)],
    hopEntity: [Math.max(0, policy.hopEntity - 0.15), Math.min(1, policy.hopEntity + 0.15)],
    hopEdge: [Math.max(0, policy.hopEdge - 0.2), Math.min(1, policy.hopEdge + 0.2)],
    kinds: policy.kinds,
    minImportance: policy.minImportance,
  };
}

/**
 * What the journal wrapper learns while the turn it wraps is running.
 *
 * `chat()` opens and closes the journal but does not resolve the session -
 * `#chatTurn` does, once the prompt has survived its first checks - so the
 * two facts the wrapper needs afterwards are handed back through this one
 * object rather than re-derived from the store.
 */
interface TurnJournalState {
  begun: boolean;
  sessionId?: string;
}

export interface ChatInput {
  text: string;
  sessionId?: string;
  provider?: ProviderId;
  model?: string;
  /** Reasoning effort for this turn; the config default otherwise. */
  effort?: EffortLevel;
  permission?: PermissionLevel;
  /** Project this conversation is about. Sticks to the session once set. */
  projectId?: string;
  /**
   * Talk to one agent instead of the assistant: a direct message in the
   * company chat. Only honoured when the session is new; an existing
   * session keeps its counterpart.
   */
  agentId?: string;
  /** Spoken turn: the reply is shaped to be read aloud. */
  voice?: boolean;
  /**
   * The id this turn is journalled under. A transport that has its own id for
   * the turn - the websocket frame id - passes it through, so a client that
   * rejoins after a reload can stop the very turn it re-joined; every other
   * caller gets a fresh id and never sees the journal at all.
   */
  turnId?: string;
  /**
   * Set by callers that start this chat without a person in front of it - a
   * schedule pinned to an existing conversation - so unattended-only rules
   * apply even though the session itself is an ordinary one. Sessions of kind
   * `schedule` and `mail` carry the flag on their own.
   */
  scheduled?: boolean;
  /**
   * Set only by the board watcher's own firing. It narrows the turn's tools
   * to `WATCH_TOOLS` (org/tools.ts): read the board, write one mail. Nothing
   * else may set it - a turn that can act is not a watcher.
   */
  watching?: boolean;
  signal?: AbortSignal;
}

/** Run a task from the board, outside any conversation. */
export interface RunTaskInput {
  /** Task id or unambiguous prefix. */
  taskId: string;
  signal?: AbortSignal;
}

/** A user-initiated assignment, outside any conversation. */
export interface AssignInput {
  /** Agent id, slug or name. */
  agent: string;
  /**
   * What the run is called in lists. A schedule passes its own name, which
   * is right for a job that means the same thing every night; anything else
   * falls back to the brief's first line (concept 7.2).
   */
  title?: string;
  task: string;
  projectId?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /**
   * Set when a schedule fired this assignment. An automated run works, but
   * it does not learn: its words are the job's prompt, written once when
   * the schedule was created, and re-extracting them on every firing would
   * fill the agent's bank with echoes of its own job description.
   */
  scheduled?: boolean;
  /**
   * The schedule that fired, recorded on the card so the board can say why
   * a piece of work exists. Set alongside `scheduled`; the two answer
   * different questions - whether to learn from the run, and what to show
   * the person looking at the card.
   */
  scheduleId?: string;
}

export interface AssistantOptions {
  config?: Partial<RookeryConfig>;
  store?: Store;
  registry?: ProviderRegistry;
  logger?: Logger;
}

export interface MemoryLearnedEvent {
  sessionId: string;
  stored: MemoryRecord[];
}

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
  /**
   * The last status seen for a task, by id - only so the board-watch
   * subscriber can tell a fresh landing in `failed` apart from an unrelated
   * edit to a task that was already sitting there. Never read for anything
   * else.
   *
   * Filled from the board when the clock starts, not left empty: a map that
   * starts empty makes every already-failed task look like a fresh landing,
   * so the first harmless edit to any of them after a restart - a priority,
   * a title - would wake the watcher for a state it had already reported.
   * Edge-triggered has to mean edge-triggered across a restart as well.
   */
  readonly #taskStatusSeen = new Map<string, TaskStatus>();

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
      runner: (job, run, signal) => this.#runScheduled(job, run, signal),
      logger: this.log,
      timeoutMs: this.config.org.assignmentTimeoutMs,
    });
    // Before the controller: the `sleep_now` tool needs it at construction.
    // The promotion hook is a closure rather than `this.org.sendUserMail`
    // itself for exactly that reason - the controller does not exist yet
    // here, and it does by the time a night can promote anything.
    this.sleep = new SleepRunner({
      store: this.store,
      registry: this.providers,
      config: this.config,
      logger: this.log,
      onPromotion: (notice) => this.#announcePromotion(notice),
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
      runAssistantMail: (input) => this.#answerMail(input.mail, input.senderLabel, input.thread),
    });
    this.cron.on('cron', (event: AgentEvent) => this.emit('cron', event));
    this.cron.on('message', (event: AgentEvent) => this.emit('message', event));
    this.cron.on('mail', (event: AgentEvent) => this.emit('mail', event));
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
    this.org.on('mail', (event: AgentEvent) => this.emit('mail', event));
    this.org.on('task', (event: AgentEvent) => this.emit('task', event));
    // The watcher's fast path (section 5): a task landing in `failed` or
    // `blocked` wakes it through the same event machinery a webhook or an
    // IMAP listener uses, no different from any other schedule.
    this.org.on('task', (event: AgentEvent) => this.#onTaskEvent(event));
    this.org.on('changed', (change: { kind: string; id: string }) => this.emit('changed', change));
    // The assistant reaching out on its own initiative - no HTTP, no
    // Telegram here, just an event a channel in another package can listen
    // for and act on however it likes.
    this.org.on('notify', (event: NotifyEvent) => this.emit('notify', event));
  }

  close(): void {
    // Anything still waiting on a person is settled first: an open question
    // holds a promise inside a tool call, and shutting down around it would
    // leave that call to time out long after there is anybody to answer.
    this.questions.cancelAll();
    this.cron.stop();
    void this.org.bridge.close();
    void sharedCodexBridge.close();
    this.store.close();
  }

  /* ---------------------------- sessions ---------------------------- */

  createSession(
    input: {
      title?: string;
      kind?: SessionKind;
      provider?: ProviderId;
      model?: string;
      projectId?: string;
      agentId?: string;
    } = {},
  ): Session {
    const agent = input.agentId ? this.store.org.getAgent(input.agentId) : null;
    if (input.agentId && !agent) throw new Error('No agent ' + input.agentId + '.');
    return this.store.createSession({
      title: input.title,
      kind: input.kind,
      provider: input.provider ?? agent?.provider ?? this.config.defaultProvider,
      model: input.model ?? agent?.model ?? this.config.defaultModel,
      cwd: this.config.workspace,
      projectId: input.projectId,
      agentId: agent?.id,
    });
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
    // A frame is a verbatim store of what was said in this session, so it
    // may never outlive the session it quotes (R17). Dropped before the
    // session row goes, the same safe direction the memory-retiring store
    // methods take for their owner's frames.
    this.store.dropDreamFramesForSession(id);
    this.store.deleteSession(id);
  }

  /** Forget the provider-side thread so the next turn starts cold. */
  resetSessionContext(id: string): void {
    this.store.updateSession(id, { providerSessionId: undefined });
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

  /* ------------------------------- board watch ----------------------------- */

  /**
   * Make sure the board has a watcher. Called once when the clock starts.
   *
   * Unlike the nightly memory schedule, this row is an ordinary, visible
   * `cron_jobs` entry - E8 wants it editable and switchable in the same UI as
   * every other job, not hidden system clockwork. Seeding is idempotent by
   * id: a second call, on a later start, finds the same row and returns it
   * untouched, whatever a person did to it since - edited the schedule,
   * rewritten the prompt, switched it off. Only a row that does not exist yet
   * gets created.
   */
  ensureBoardWatchSchedule(): CronJob | null {
    try {
      const organization = this.org.activeOrganization();
      // Seed the edge detector before the subscriber can fire: every task
      // already on the board counts as "seen in this state", so only a real
      // transition from here on wakes the watcher. Without this the first
      // unrelated edit to an old failed task would look like a new failure.
      for (const task of this.store.org.listTasks(organization.id, { anyLevel: true, limit: 5000 })) {
        this.#taskStatusSeen.set(task.id, task.status);
      }
      const id = boardWatchJobId(organization.id);
      const existing = this.cron.get(id);
      if (existing && existing.orgId === organization.id) return existing;
      return this.cron.create({
        id,
        orgId: organization.id,
        name: 'Board watch',
        schedule: BOARD_WATCH_SCHEDULE,
        triggerMode: 'schedule',
        // The clock is the backstop; the fast path is the task-event
        // subscriber below. A minute keeps ten failures or blocks in one
        // burst to one run, exactly like every other event-fed schedule.
        eventCooldownMs: 60_000,
        kind: 'assistant',
        prompt: BOARD_WATCH_PROMPT,
        createdBy: 'assistant',
      });
    } catch (error) {
      this.log.warn('Could not set up the board watcher', { error: (error as Error).message });
      return null;
    }
  }

  /**
   * What the board watcher would have something to say about, decided in
   * SQL rather than by a model.
   *
   * The watcher used to be a full turn every thirty minutes plus one per
   * event - roughly fifty model runs a day whose usual answer was
   * `[SILENT]`. "Is anything wrong" is a query; only "is this worth
   * interrupting somebody over, and how do I put it" needs judgment. So the
   * clock runs this first, the model is never started unless this finds
   * something, and when it does the findings go into the prompt: the turn
   * begins already knowing what it is there for.
   *
   * Nothing is reported twice. Everything that went wrong before the
   * watcher last actually said something was covered by that report, so
   * only what became true since then is news. That is what stops a board
   * with one permanently broken task on it from mailing about it
   * forty-eight times a day.
   */
  #boardAttention(orgId: string, jobId: string): string[] {
    const now = Date.now();
    // The mark is stored, not reconstructed from the run history.
    //
    // Reading "the newest run that produced a result" out of the last N
    // runs looked equivalent and was not, in three ways. A quiet board
    // writes a silent run every half hour, so after ten hours the speaking
    // run had fallen out of any fixed window and every old failure became
    // news again. A pass the model ended with `[SILENT]` left no result at
    // all, so a finding it had deliberately judged not worth reporting came
    // back every thirty minutes for ever. And both readings confused two
    // different questions: what the model chose to say, and what it was
    // shown. This answers the second - the mark moves when the findings are
    // handed over, whatever the model then decides to do with them.
    const markKey = 'board-watch:seen:' + jobId;
    const since = Number(this.store.getMeta(markKey) ?? 0);
    // A run that has outlived twice its own hard stop is not slow: either
    // its timer never fired or the row was orphaned by a crash.
    const stuckAfter = this.config.org.assignmentTimeoutMs * 2;
    const lines: string[] = [];
    // An explicit ceiling, and a high one. `listTasks` defaults to 100
    // ordered by priority then oldest-first, so on a board that has built up
    // history the newest failure - the one that matters - is exactly the row
    // that falls off the end and is never seen.
    for (const task of this.store.org.listTasks(orgId, { anyLevel: true, status: ['failed', 'running'], limit: 5000 })) {
      const label = '[' + task.id.slice(0, 8) + '] ' + task.title;
      if (task.status === 'failed') {
        const landed = task.finishedAt ?? task.updatedAt;
        if (landed <= since) continue;
        const runs = this.store.org.taskRunCount(task.id);
        lines.push(
          label + ' failed' + (runs > 1 ? ' on run ' + runs : '') +
            (task.error ? ': ' + task.error : '') + ' (' + formatAge(landed, now, 'minute') + ' ago)',
        );
        continue;
      }
      const started = task.startedAt ?? task.updatedAt;
      // The moment it became stuck, not the moment we noticed: a task that
      // crossed that line before the last report was in that report.
      const crossed = started + stuckAfter;
      if (crossed > now || crossed <= since) continue;
      lines.push(label + ' has been running ' + formatAge(started, now, 'minute') + ' with no end');
    }
    // Only a pass that actually found something moves the mark: a quiet
    // look must not silently swallow a failure that lands a second later.
    if (lines.length) this.store.setMeta(markKey, String(now));
    return lines;
  }

  /**
   * A task crossed into `failed` - the one transition the watcher cares
   * about (E8, section 5). The clock behind it fires every thirty minutes
   * regardless; this is only the fast path, and it is edge-triggered on
   * purpose: a task that merely stays failed while its title or priority
   * changes must not re-fire the watcher on every one of those unrelated
   * edits, only on actually landing in the state.
   *
   * `blocked` used to wake it too, and that was backwards. Blocked means an
   * agent asked a person something and the board is correctly waiting for
   * the answer. Waking a watcher on it meant the system's reaction to being
   * asked a question was to go and do something instead - within a minute,
   * while the person was still reading it.
   */
  #onTaskEvent(event: AgentEvent): void {
    if (event.type !== 'task') return;
    const { task } = event;
    const attention = task.status === 'failed';
    const before = this.#taskStatusSeen.get(task.id);
    this.#taskStatusSeen.set(task.id, task.status);
    if (!attention || before === task.status) return;
    const id = boardWatchJobId(task.orgId);
    void this.cron.runEvent(id, 'task ' + task.id.slice(0, 8) + ' turned ' + task.status).catch((error: unknown) => {
      this.log.warn('Could not wake the board watcher', { error: String(error) });
    });
  }

  /* ------------------------------- chat ----------------------------- */

  /**
   * One conversational turn, streamed - and journalled while it runs.
   *
   * The wrapper is the single place every yielded event passes through, which
   * is what makes the journal faithful: whatever a live client saw, in the
   * order it saw it, numbered once each. A client that arrives late - a
   * reloaded tab, another browser - reads the same events back and continues
   * from the same numbers, so rejoining can neither duplicate nor drop.
   *
   * `#chatTurn` does the work and opens the journal once its session is
   * resolved; events yielded before that (a rejected empty prompt, say) are
   * ephemeral by nature and stay unjournalled.
   */
  async *chat(input: ChatInput): AsyncGenerator<AgentEvent, void, unknown> {
    const turnId = input.turnId ?? randomUUID();
    const startedAt = Date.now();
    const journal: TurnJournalState = { begun: false };
    // The backstop a turn never had. A run and a schedule both stop
    // themselves; a turn ran until its provider process did, and over
    // `POST /api/chat` - which passes no signal - nobody could interrupt
    // it. The caller's own signal still works and still wins; this only
    // adds an end to turns that would otherwise not have one.
    const guard = new AbortController();
    const onCallerAbort = (): void => guard.abort();
    // A signal that was already aborted never fires the event again, so
    // forwarding only through the listener would start a turn the caller
    // had already given up on.
    if (input.signal?.aborted) guard.abort();
    else input.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => guard.abort(), this.config.turns.timeoutMs);
    // Node keeps the process alive for a pending timer; this one must never
    // be the reason a CLI command refuses to exit.
    timer.unref?.();
    const guarded: ChatInput = { ...input, signal: guard.signal };
    try {
      for await (const event of this.#chatTurn(guarded, turnId, journal)) {
        if (journal.begun) this.store.turns.append(turnId, event as unknown as Record<string, unknown>);
        yield event;
      }
      if (journal.begun) {
        this.store.turns.settle(turnId, 'done', Date.now());
        // Only an orderly end is an episode: a turn that died mid-flight has
        // no outcome to judge a trajectory against (concept 7.2).
        this.#recordTrialEpisode(turnId, journal, startedAt);
      }
    } catch (error) {
      // The turn died mid-flight. Whatever reached the journal is the only
      // record of it - it stays, marked, rather than vanishing whole.
      if (journal.begun) this.store.turns.settle(turnId, 'interrupted', Date.now());
      throw error;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  async *#chatTurn(
    input: ChatInput,
    turnId: string,
    journal: TurnJournalState,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const prompt = input.text.trim();
    if (!prompt) {
      yield { type: 'error', message: 'Nothing to send.', fatal: true };
      return;
    }

    const session = this.#resolveSession(input);
    this.store.turns.begin(turnId, session.id, 'chat', Date.now());
    journal.begun = true;
    journal.sessionId = session.id;
    // Chat is exclusively the assistant's own conversation; a stale
    // `agentId` on an old session is never read here any more.
    const owner = ASSISTANT_MEMORY_OWNER;
    if (input.projectId && input.projectId !== session.projectId) {
      this.store.updateSession(session.id, { projectId: input.projectId });
      session.projectId = input.projectId;
    }

    const wanted = input.provider ?? session.provider;
    const providerId = await this.providers.resolveUsable(wanted);
    if (!providerId) {
      const statuses = await this.providers.statuses();
      // A provider parked for quota says so here rather than hiding behind
      // its login state: "out of quota" tells the user what to wait for.
      const detail = statuses
        .map((s) => s.id + ': ' + (providerBlocked(s.id) ? 'out of quota' : (s.detail ?? 'unavailable')))
        .join(' | ');
      yield { type: 'error', message: 'No AI provider is ready. ' + detail, fatal: true };
      return;
    }
    if (providerId !== wanted) {
      yield { type: 'status', label: 'provider', detail: this.#switchReason(wanted, providerId) };
    }

    // Resuming the provider's own thread only works on the same provider.
    const resumed = Boolean(session.providerSessionId) && session.provider === providerId;
    const model = input.model ?? session.model ?? this.config.defaultModel;
    const effort = input.effort ?? this.config.defaultEffort;

    let memories: ScoredMemory[] = [];
    /**
     * The recall as it went out on the wire, kept so the ordered transcript
     * can carry it too: the recall happens before the first provider attempt,
     * and `turnBlocks` below is only born once one is about to start.
     */
    let recall: Extract<AgentEvent, { type: 'memory' }> | undefined;
    if (this.config.memory.enabled) {
      yield { type: 'status', label: 'recalling', detail: 'searching memory' };
      // One truth about the recall parameters (concept 9.3): the resolver
      // clamps at read time and both the turn and the recorder read it here,
      // so a config change cannot leave the record and the live turn
      // disagreeing about which policy produced the prompt.
      const policy = resolvePolicy(this.store, this.config, owner, 'recall');
      memories = this.#turnMemories(session, owner, prompt, policy, turnId);
      if (memories.length) {
        // The turn id travels with the list the surface is about to render:
        // a click on one of these rows becomes a label about THIS turn, not
        // about the session it happened in (S6, concept 4.2b).
        recall = { type: 'memory', action: 'recalled', count: memories.length, items: memories, turnId };
        yield recall;
      }
    }

    // Read before the turn stores its own user message: a retry that cannot
    // resume the dead provider's thread rebuilds its prompt from this.
    const turnHistory = this.store.getMessages(session.id, this.config.memory.workingWindow);
    const history = resumed ? [] : turnHistory;

    // The company block: who works here, what is running, what arrived in
    // the mail. Read once per turn; the mail is then marked as read.
    const organization = this.org.activeOrganization();
    const snapshot = this.org.snapshot(organization.id);
    const mail = this.store.org.unreadMailFor(organization.id, { kind: 'assistant' });
    const project = session.projectId ? (this.store.org.getProject(session.projectId) ?? undefined) : undefined;
    if (mail.length) this.store.org.markMailReadFor(mail, { kind: 'assistant' });

    // Who is asking: the assistant. The tool servers and the prompt built on
    // them are per provider attempt, because each provider attaches its own.
    const who = 'assistant';
    // Rookery's own shelf in full, and one paragraph for the far larger one
    // installed in Claude Code: what is there, not what it says. Then the few
    // that look like this turn - searched here rather than left to a tool call
    // the model has to think of, the same way its memories arrive.
    const ownSkills = this.skills.for(who);
    const skillsIndex = [
      renderSkillsIndex(ownSkills),
      renderExternalSkillsHint(this.config, who),
      renderSkillMatches(matchSkills(this.config, who, ownSkills, prompt)),
    ]
      .filter(Boolean)
      .join('\n\n');
    // The journal's id, on the message (concept 9.4): it is what makes a
    // quote from this prompt locatable to this exact turn later, instead of
    // to a position counted off the transcript.
    this.store.addMessage({ sessionId: session.id, role: 'user', content: prompt, turnId });
    if (session.messageCount === 0 && session.title === 'New conversation') {
      this.store.updateSession(session.id, { title: deriveTitle(prompt) });
    }

    const started = Date.now();
    let answer = '';
    const toolCalls: Extract<AgentEvent, { type: 'tool' }>[] = [];
    // The same turn as an ordered transcript: text, thinking and tools in
    // arrival order, kept beside the flat views. One instance spans every
    // pass of every attempt; a provider fallback is the only reset.
    const turnBlocks = new TurnBlocks();
    // What was put in front of the answer, first in the transcript because it
    // was first in the turn. It survives `clear()`, so a fallback attempt
    // keeps it too.
    if (recall) turnBlocks.apply(recall);
    let providerSessionId = resumed ? session.providerSessionId : undefined;
    let usage: TurnUsage | undefined;
    let lastFatal: string | null = null;
    /** The provider and model the turn ends up having run with. */
    let usedProvider = providerId;
    let usedModel = model;
    const tried = new Set<ProviderId>([providerId]);

    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      const pid = usedProvider;
      // A different backend serves different names; the fallback provider's
      // own default stands in for a model it has never heard of.
      usedModel = attempt === 1 && pid === wanted ? model : remapModel(pid, model);

      // The hub decides which extra MCP servers this attempt gets, and the
      // prompt carries one paragraph per server plus the index of skills to
      // open. Provider-scoped, so a switch attaches its own set.
      const extra = toolServersFor(this.config, who, pid, project?.id);
      // The assistant also hears about the servers it could attach but has not:
      // a switch it does not know about is a wall it cannot climb.
      const toolHints = [...extra.hints, dormantToolsHint(this.config, who, project?.id)].filter(Boolean);
      const systemPrompt = buildSystemPrompt({
        config: this.config,
        query: prompt,
        memories,
        // A retry cannot resume the dead provider's thread, so it rebuilds
        // its context from the history it still has.
        history: attempt === 1 ? history : turnHistory,
        resumed: attempt === 1 && resumed,
        // A voice session speaks whichever surface the turn came from.
        voice: input.voice ?? session.kind === 'voice',
        orgBlock: assistantOrgBlock(this.config, snapshot, mail, project, this.cron.list(organization.id), this.store),
        toolHints,
        skillsIndex,
        // Lets the memory block group itself by entity.
        store: this.store,
      });

      const provider = this.providers.get(pid);
      // Only the first attempt may resume the provider's own thread; a
      // fallback starts a fresh one on the new backend.
      providerSessionId = attempt === 1 && resumed ? session.providerSessionId : undefined;
      let failed = false;

      yield { type: 'session', sessionId: session.id, providerSessionId, provider: pid, model: usedModel };

      // The assistant stays in the workspace, not a project directory - it is
      // a person, not Claude Code's coding agent.
      const cwd = this.config.workspace;

      // What this pass of the provider is run with. A turn usually has exactly
      // one pass; see the continuation below for why it sometimes has two.
      let passPrompt = prompt;
      let passSystemPrompt = systemPrompt;
      let passExtra = extra;
      let attached = new Set(extra.specs.map((spec) => spec.name));

      for (let pass = 1; pass <= MAX_PROVIDER_PASSES; pass += 1) {
        // Everything the turn produces goes through one queue: the provider's
        // own events, and whatever the tool calls it makes cause in the company.
        const queue = new EventQueue<AgentEvent>();
        const token = this.org.register({
          orgId: organization.id,
          audience: 'assistant',
          agentId: undefined,
          sessionId: session.id,
          projectId: session.projectId,
          depth: -1,
          // A scheduled chat run works under the same rule as a scheduled
          // assignment: it may read memory and open skills, but nothing it
          // does lands back in the bank - no extraction, no tools that write.
          // That covers every run with nobody in front of it: a session of
          // kind `schedule`, the mail-answer turn (`kind: 'mail'`), and a
          // schedule pinned to an ordinary conversation, which arrives with
          // `input.scheduled` set. All three are exactly the runs that must
          // not be offered `ask_user` - there is no screen to answer on.
          scheduled:
            input.scheduled === true || session.kind === 'schedule' || session.kind === 'mail',
          watching: input.watching === true,
          emit: (event) => queue.push(event),
          signal: input.signal,
        });

        const currentPrompt = passPrompt;
        const currentSystemPrompt = passSystemPrompt;
        const currentSpecs = passExtra.specs;
        const currentResume = providerSessionId;
        const pump = (async () => {
          try {
            const mcp = await this.org.bridge.spec(token);
            for await (const event of provider.run({
              prompt: currentPrompt,
              systemPrompt: currentSystemPrompt,
              systemPromptMode: 'replace',
              providerSessionId: currentResume,
              model: usedModel,
              effort,
              cwd,
              permission: input.permission ?? this.config.defaultPermission,
              mcp,
              mcpExtra: currentSpecs.length ? currentSpecs : undefined,
              // Approved subagents and hooks out of the Claude Code
              // installation, plus Rookery's own permission floor.
              ...externalTurnExtras(this.config, who),
              signal: input.signal,
            })) {
              queue.push(event);
            }
          } catch (error) {
            queue.push({ type: 'error', message: (error as Error).message, fatal: true });
          } finally {
            queue.close();
          }
        })();

        let passText = '';
        try {
          for await (const event of queue.drain()) {
            switch (event.type) {
              case 'tool':
                toolCalls.push(event);
                turnBlocks.apply(event);
                // Also on the assistant's own emitter, not just this stream:
                // a channel that is not the one that started the turn - the
                // phone, watching a schedule run - has no other way to see
                // what is being done. Nobody has to listen; the web UI reads
                // these off the turn stream it already holds.
                this.emit('tool', event);
                yield event;
                break;
              case 'question':
              case 'question-closed':
                // Into this stream only. The assistant's emitter already
                // carries both events - forwarded from the registry, which
                // fires them even when this queue is long closed - so the
                // phone and a second tab see the card without this turn's
                // help, and emitting here as well would say everything twice.
                yield event;
                break;
              case 'text':
                passText += event.delta;
                turnBlocks.apply(event);
                yield event;
                break;
              case 'thinking':
                // Explicit only so the transcript folds it in; on the wire
                // this is the same pass-through `default` already gave it.
                turnBlocks.apply(event);
                yield event;
                break;
              case 'session':
                providerSessionId = event.providerSessionId ?? providerSessionId;
                break;
              case 'done':
                providerSessionId = event.providerSessionId ?? providerSessionId;
                passText = event.text || passText;
                turnBlocks.reconcile(event.text);
                usage = mergeUsage(usage, event.usage);
                break;
              case 'error':
                if (event.fatal) {
                  failed = true;
                  lastFatal = event.message;
                }
                yield event;
                break;
              default:
                yield event;
            }
          }
        } finally {
          await pump;
          this.org.unregister(token);
          // Every exit, not only an abort: a provider crash or a fallback
          // switch ends the pass without the signal ever firing, and the
          // questions it asked would otherwise stand answerable on every
          // surface for their full timeout, reaching a tool call that is gone.
          this.questions.cancelForOwner(token);
        }

        answer = answer && passText ? answer + '\n\n' + passText : answer || passText;

        // The continuation. A tool server the assistant switched on mid-turn
        // can only be attached to a provider process that has not started yet,
        // so without this the work stalls until the user asks again - exactly
        // the dead end the assistant is told not to accept. Instead the turn
        // runs once more with the new servers attached and the provider's own
        // session resumed, and the two answers are joined.
        if (failed || pass === MAX_PROVIDER_PASSES) break;
        if (input.signal?.aborted) break;
        const next = toolServersFor(this.config, who, pid, project?.id);
        const fresh = next.specs.map((spec) => spec.name).filter((name) => !attached.has(name));
        if (!fresh.length) break;

        passExtra = next;
        attached = new Set(next.specs.map((spec) => spec.name));
        passSystemPrompt = buildSystemPrompt({
          config: this.config,
          query: prompt,
          memories,
          resumed: true,
          voice: input.voice ?? session.kind === 'voice',
          orgBlock: assistantOrgBlock(this.config, snapshot, [], project, this.cron.list(organization.id), this.store),
          toolHints: [...next.hints, dormantToolsHint(this.config, who, project?.id)].filter(Boolean),
          skillsIndex,
          store: this.store,
        });
        passPrompt = continuePrompt(fresh);
        yield { type: 'status', label: 'tools', detail: fresh.join(', ') + ' attached, carrying on' };
      }

      // A turn that died on its usage limit with nothing to show goes around
      // once more on another provider. Anything else keeps today's semantics:
      // nothing usable came back, so the session context stays untouched for
      // the next attempt to resume cleanly.
      if (!failed || answer || toolCalls.length) break;
      const alternate =
        this.config.providerFallback.enabled &&
        attempt < MAX_PROVIDER_ATTEMPTS &&
        !input.signal?.aborted &&
        lastFatal !== null &&
        isUsageLimitError(lastFatal)
          ? await this.providers.resolveUsable(wanted, { exclude: [...tried] })
          : null;
      if (!alternate) return;
      rememberUsageFailure(pid);
      yield { type: 'status', label: 'provider', detail: pid + ' hit its usage limit, continuing on ' + alternate };
      usedProvider = alternate;
      tried.add(alternate);
      // The dead attempt belongs to no transcript; the next one starts clean
      // rather than appending to a half-told story.
      turnBlocks.clear();
    }

    // The provider's numbers plus the wall-clock of the whole turn, so a
    // reloaded transcript can still show what the context looked like.
    const turnUsage: TurnUsage = { ...usage, durationMs: Date.now() - started };
    this.store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: answer,
      turnId,
      provider: usedProvider,
      model: usedModel,
      usage: turnUsage,
      toolCalls,
      blocks: turnBlocks.blocks.length ? turnBlocks.blocks : undefined,
    });
    if (lastFatal !== null && !answer) return;
    this.store.updateSession(session.id, { provider: usedProvider, model: usedModel, providerSessionId });

    yield { type: 'done', text: answer, providerSessionId, usage: turnUsage };

    // Scheduled runs stay out of the memory: the "user" side of that
    // exchange is Rookery's own boilerplate plus the job's prompt, not
    // something the user said today, and quoting it would file the job
    // description again on every firing. Mail answers are deliberately
    // still extracted - a person wrote in, and what they wrote stands.
    if (
      this.config.memory.enabled &&
      this.config.memory.autoExtract &&
      session.kind !== 'schedule'
    ) {
      void this.#learn(session.id, prompt, answer, usedProvider, owner);
    }
  }

  /**
   * What to say when a turn starts on a provider it did not ask for. Quota
   * reasons first - they are the ones the user cannot see anywhere else - and
   * a missing login last, which the provider list already shows.
   */
  #switchReason(wanted: ProviderId, chosen: ProviderId): string {
    const blocked = providerBlocked(wanted);
    if (blocked) {
      return (
        wanted +
        ' is out of quota' +
        (blocked.until ? ' until ' + new Date(blocked.until).toLocaleTimeString() : '') +
        ', using ' +
        chosen
      );
    }
    if (this.config.providerFallback.enabled && providerLow(wanted, this.config.providerFallback.thresholdPercent)) {
      return wanted + ' is nearly out of quota, using ' + chosen + ' for now';
    }
    return wanted + ' is not logged in, using ' + chosen;
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

    const queue = new EventQueue<AgentEvent>();
    const run = this.org
      .runTask(
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
          emit: (event) => queue.push(event),
          signal: input.signal,
        },
        card,
      )
      .finally(() => queue.close());

    for await (const event of queue.drain()) yield event;
    const finished = await run;

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
    const queue = new EventQueue<AgentEvent>();
    const run = this.org
      .runTask(
        {
          orgId: organization.id,
          audience: 'assistant',
          depth: -1,
          projectId: task.projectId,
          emit: (event) => queue.push(event),
          signal: input.signal,
        },
        task,
      )
      .finally(() => queue.close());
    for await (const event of queue.drain()) yield event;
    const finished = await run;
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

  /* ----------------------------- schedules -------------------------- */

  /**
   * Execute one schedule. The assistant's own jobs run as a turn in a fresh
   * conversation every firing - a clean rerun each time, not a diary the
   * assistant keeps adding to - unless the job was pinned to a specific
   * conversation when it was created (the "reply in this chat" case for a
   * one-off follow-up); an agent's jobs run as an ordinary assignment.
   */
  async #runScheduled(job: CronJob, run: CronRun, signal: AbortSignal): Promise<CronRunOutcome> {
    void run;
    if (job.kind === 'script') {
      const result = await runCronScript(this.config.home, job, signal);
      if (result.silent) return { status: 'done', result: '', silent: true };
      if (job.script?.noAgent) return { status: 'done', result: result.output };
      job = { ...job, prompt: job.prompt + '\n\nThe imported pre-check script produced this data:\n' + result.output };
    }
    if (job.kind === 'sleep') {
      // The night shift. `prompt` carries the scope, not an instruction:
      // "assistant", "all", or one agent id.
      const scope = job.prompt.trim() || 'assistant';
      const owners =
        scope === 'all' ? this.sleep.dueOwners() : scope === 'assistant' ? [ASSISTANT_MEMORY_OWNER] : [scope];
      const lines: string[] = [];
      let failed: string | undefined;
      for (const owner of owners) {
        const result = await this.sleep.run({ owner, trigger: 'schedule', signal });
        lines.push(labelForOwner(this, owner) + ': ' + (result.report ?? '-'));
        if (result.status === 'failed') failed = result.error ?? 'The sleep run failed.';
      }
      if (failed && lines.length <= 1) return { status: 'failed', error: failed };
      return { status: 'done', result: lines.join('\n') };
    }

    if (job.kind === 'agent') {
      const agent = job.agentId ? this.store.org.getAgent(job.agentId) : null;
      if (!agent || agent.archived) return { status: 'failed', error: 'The agent for this schedule no longer exists.' };
      let assignmentId: string | undefined;
      let text = '';
      let error: string | undefined;
      // `scheduled` keeps the run from learning: the assignment's words are
      // the job's own prompt, and no memory should grow out of them.
      for await (const event of this.assign({
        agent: agent.id,
        // A recurring job is called the same thing every night, and that is
        // right: the schedule's name is the third source of a run's name.
        title: job.name,
        task: job.prompt,
        projectId: job.projectId,
        signal,
        scheduled: true,
        scheduleId: job.id,
      })) {
        if (event.type === 'assignment' && !assignmentId) assignmentId = event.assignment.id;
        else if (event.type === 'done') text = event.text;
        else if (event.type === 'error' && event.fatal) error = event.message;
      }
      return error ? { status: 'failed', error, assignmentId } : { status: 'done', result: text, assignmentId };
    }

    // The board watcher checks before it thinks. Nothing on the board that
    // needs saying means no session, no provider process and no model call -
    // which is what the overwhelming majority of its firings are.
    const watching = job.id === boardWatchJobId(job.orgId);
    const attention = watching ? this.#boardAttention(job.orgId, job.id) : [];
    if (watching && !attention.length) return { status: 'done', result: '', silent: true };

    // `job.sessionId` here only ever means "pinned at creation" - a one-off
    // follow-up the user asked to land in a chat they already had open.
    // Nothing below writes it back after a run, so a recurring job gets a
    // clean, unlinked conversation every single firing.
    const existing = job.sessionId ? this.store.getSession(job.sessionId) : null;
    let sessionId: string;
    if (existing) {
      sessionId = existing.id;
      // The user may have archived the chat while this was pending; reusing
      // it silently would bury the reply where nobody looks for it.
      if (existing.archived) this.store.updateSession(existing.id, { archived: false });
    } else {
      sessionId = this.createSession({ title: 'Schedule: ' + job.name, kind: 'schedule', projectId: job.projectId }).id;
    }
    // Same clock, same zone, same wording as every other stamp a model reads.
    const when = formatNow();
    const prompt =
      'Automatic run of schedule “' + job.name + '” (' +
      (job.schedule ? describeCron(job.schedule) : 'fired by an event') + '), ' + when + '. ' +
      'Nobody is following live: carry out the assignment now and finish with a short report ' +
      'for the user to read later. If carrying it out already delivers the result to the user by ' +
      'itself (for example you send_mail them the thing this job exists to send), that mail is the ' +
      'delivery - reply with exactly [SILENT] and nothing else, so a second "schedule completed" ' +
      'notification is not posted on top of it.\n\n' + job.prompt +
      // The watcher arrives knowing what it was woken for, so the turn is
      // about judging those findings rather than going to look for them.
      // Everything here is new since its last report by construction.
      (attention.length
        ? '\n\nThe board was checked before this run. These are new since you last reported, ' +
          'and they are the whole reason you were woken:\n- ' + attention.join('\n- ')
        : '');
    let text = '';
    let error: string | undefined;
    for await (const event of this.chat({
      text: prompt,
      sessionId,
      projectId: job.projectId,
      permission: job.permission,
      signal,
      scheduled: true,
      // The board watcher is the one schedule that gets a cut-down toolset:
      // it looks and it mails, it does not act. Keyed off the job's fixed id
      // so a user-made job that merely happens to be named "Board watch" is
      // an ordinary assistant schedule with ordinary reach.
      watching,
    })) {
      if (event.type === 'done') text = event.text;
      else if (event.type === 'error' && event.fatal) error = event.message;
    }
    if (error && !text) return { status: 'failed', error, sessionId };
    // An exact-match check on the whole reply is too brittle: the model
    // sometimes reasons out loud first and tacks the sentinel on as its
    // last line instead of replying with only it, which used to defeat the
    // match and let the explanation (sentinel and all) straight into the
    // inbox mail. Matching it as a trailing token - not anywhere in the
    // text - still catches that case without firing on a report that
    // merely quotes or explains the convention somewhere in its middle.
    if (/\[SILENT\]\s*$/.test(text)) return { status: 'done', result: '', silent: true, sessionId };
    return { status: 'done', result: text, sessionId };
  }

  /**
   * One assistant turn for a mail addressed to it, answered by mail.
   * Same shape as a scheduled run: its own conversation, nobody watching
   * live, the answer read later - except the answer goes back as a reply.
   */
  async #answerMail(mail: Mail, senderLabel: string, thread: Mail[]): Promise<string> {
    // `kind: 'mail'` keeps this out of the conversations list: it is the
    // transcript of one answered mail, not a thread anyone continues.
    const session = this.createSession({ title: 'Mail: ' + mail.subject, kind: 'mail' });
    // Subjects only: the thread can be long, and most mail is answerable
    // without it. `read_mail_thread` fetches the text if this one is not.
    const history = thread.length
      ? 'Earlier in this thread (' + thread.length + ' mail(s)), subjects only:\n' +
        thread.map((entry) => '- ' + entry.subject).join('\n') +
        '\nRead the full text with read_mail_thread("' + mail.threadId + '") if the answer depends on it.\n\n'
      : '';
    const prompt =
      'Mail ' + mail.id + ' arrived for you from ' + senderLabel + '. Nobody is following this ' +
      'conversation live: answer it now, and write the answer as the body of your reply mail - no ' +
      'chat pleasantries, no report framing. It is sent back to them as a reply automatically. Do ' +
      'not send_mail the answer to them as well: this text is the reply, and doing both delivers ' +
      'it twice. send_mail here is only for bringing somebody else in.\n\n' +
      history + 'Subject: ' + mail.subject + '\n\n' + mail.body;

    let text = '';
    for await (const event of this.chat({ text: prompt, sessionId: session.id })) {
      if (event.type === 'done') text = event.text;
      else if (event.type === 'error' && event.fatal) throw new Error(event.message);
    }
    return text;
  }

  /* ---------------------------- internals --------------------------- */

  /**
   * Whether this turn is framed for the dream. All conditions must hold
   * (R18): the dream and the recorder are switched on, the owner is the
   * assistant - stage 1 records nothing but the assistant's own bank, an
   * agent frame would be cost without a night that ever scores it - and the
   * session is a real conversation. A `schedule` run walks this same code
   * but can never earn a correction label, because `sessionsActiveSince`
   * filters its kind out; framing it would be pure cost. The sample itself
   * is drawn per session, never per trace, and `frameRate` is clamped here
   * because `rookery config set` bypasses the patch schema (E21).
   */
  #dreamRecords(session: Session, owner: string): boolean {
    const dream = this.config.memory.dream;
    if (!dream.enabled || !dream.record) return false;
    if (owner !== ASSISTANT_MEMORY_OWNER) return false;
    if (session.kind !== 'chat' && session.kind !== 'voice' && session.kind !== 'mail') return false;
    return dreamSampleDraw(session.id) < clampNumber(dream.frameRate, 0, 1);
  }

  /**
   * Index a finished turn as a trial episode (concept 7.2, Phase 6).
   *
   * `dream.trialEpisodes` gets its reader here rather than in the night,
   * for the plain reason that the night cannot reach the turn journal: the
   * episode is an INDEX over `turn_events`, and only the process that just
   * wrote those rows knows the turn is over. Zero by default, so this is a
   * single config read and a return on every turn Rookery has ever run.
   *
   * The key is a quota, not a switch: `trialEpisodes` many episodes per
   * bank, then nothing. Phase 6 is a sample to validate a mechanism on, not
   * a recorder to leave running - and a trial that never stops would keep
   * pointing at verbatim journal rows long after anybody looked at it.
   *
   * Nothing in here may cost the turn. The turn is finished and answered by
   * the time this runs; a store that refuses the write costs the episode
   * and a debug line (10.5).
   */
  #recordTrialEpisode(turnId: string, journal: TurnJournalState, startedAt: number): void {
    const trial = Math.round(clampNumber(this.config.memory.dream.trialEpisodes, 0, 1000));
    if (trial <= 0) return;
    const owner = ASSISTANT_MEMORY_OWNER;
    try {
      // Read with the quota as the limit: the question is "are there already
      // enough", never "how many are there".
      if (this.store.dreamEpisodes(owner, { limit: trial }).length >= trial) return;
      const sessionId = journal.sessionId;
      // The same session-wise split the recorder stamps on a trace (E3): a
      // turn outside any conversation is its own cluster.
      const split = splitOf(sessionId ?? turnId, DEFAULT_SPLIT_RATES);
      const { episode } = episodeFromEvents(turnId, this.store.turns.events(turnId), {
        owner,
        kind: 'turn',
        slot: 'recall',
        ...(sessionId ? { sessionId } : {}),
        startedAt,
        finishedAt: Date.now(),
        holdout: split === 'holdout',
        audit: split === 'audit',
      });
      this.store.recordDreamEpisode(episode);
    } catch (error) {
      this.log.debug('Trial episode not recorded', { turnId, error: (error as Error).message });
    }
  }

  /**
   * A retrieval policy went in force, so the user hears about it (S26,
   * concept 9.6). This is the one place that can say so: the night owns the
   * promotion and knows nothing about mail, the controller owns the mail and
   * knows nothing about the night, and the runtime holds both.
   *
   * Everything quoted is a number, an id or the promotion's own stored
   * rationale, which carries no verbatim text by construction (E19/S21), so
   * the message can outlive the memories the evaluation stood on.
   *
   * A failing send costs the message, never the night: `#announcePromotion`
   * in sleep.ts catches whatever comes back out of here, and this catches
   * first so the warning names the mail rather than the hook.
   */
  async #announcePromotion(notice: PromotionNotice): Promise<void> {
    const version = notice.version;
    const evaluation = notice.evaluation;
    const body = [
      'A new ' + notice.slot + ' policy is in force for ' + notice.owner +
        ' (version ' + version.version + ').',
      '',
      notice.rationale,
      '',
      'delta ' + evaluation.delta.toFixed(4) +
        ', ci_low ' + evaluation.ciLow.toFixed(4) +
        ', over ' + evaluation.closed + ' of ' + evaluation.traces + ' traces' +
        (evaluation.auditCiLow === undefined
          ? ''
          : ', audit ci_low ' + evaluation.auditCiLow.toFixed(4)) +
        '.',
      'No further promotion of this slot before ' + new Date(notice.cooldownUntil).toISOString() + '.',
      '',
      'Take it back on its own: POST /api/dream/policies/' + version.id + '/revert' +
        (notice.prevActiveId ? ' (restores version ' + notice.prevActiveId + ').' : '.'),
      'Take the whole night back: undo sleep run ' + notice.runId + '.',
    ].join('\n');
    try {
      await this.org.sendUserMail({
        orgId: this.org.activeOrganization().id,
        to: ['user'],
        subject: 'Retrieval policy ' + notice.slot + ' v' + version.version + ' is in force',
        body,
      });
    } catch (error) {
      this.log.warn('Could not mail the promotion notice', {
        owner: notice.owner,
        slot: notice.slot,
        policy: version.id,
        error: (error as Error).message,
      });
    }
  }

  /**
   * The turn's merged memory list: the ranking plus the profile, pairs that
   * cannot both be true reduced to the newer sentence, and the whole merge
   * totally ordered - score descending, id ascending (R11), so a tie can no
   * longer pick whichever row the Map happened to insert first. That order
   * is what the rendered block reads, and what the recorder freezes.
   *
   * A framed turn additionally records everything the night needs to replay
   * this decision: the trace, the touches the ranking causes, and the frame
   * at the permissive corner of the declared box. The live ranking inside
   * the bracket is byte for byte the ranking of an unframed turn - the
   * recorder may not change the turn it records - and everything it writes
   * sits in the store's SAVEPOINT bracket (R9), so a framed turn is one
   * transaction or nothing.
   *
   * `turnId` is the JOURNAL's id, handed down from `chat()` - not one minted
   * here. That is the whole of concept 9.4's "one turn id instead of three":
   * the trace, the message and the journal now say the same word, so a
   * correction quote found in `messages.turn_id` lands on exactly the trace
   * that produced the prompt it corrects. Minted separately, `locateTurn`
   * could never match one and every correction label fell back to session
   * scope - where, by S3, it can never contribute a gain.
   */
  #turnMemories(
    session: Session,
    owner: string,
    prompt: string,
    policy: RecallPolicy,
    turnId: string,
  ): ScoredMemory[] {
    const options = {
      text: prompt,
      owner,
      limit: policy.limit,
      threshold: policy.threshold,
      hopEntity: policy.hopEntity,
      hopEdge: policy.hopEdge,
    };
    const promptProfileLimit = Math.max(3, Math.floor(policy.limit / 2));
    const merged = (matched: ScoredMemory[], profile: ScoredMemory[]): ScoredMemory[] => {
      const byId = new Map<string, ScoredMemory>();
      for (const memory of profile) byId.set(memory.id, memory);
      for (const memory of matched) byId.set(memory.id, memory);
      // Of a contradicting pair only the newer sentence goes into the prompt;
      // the older one stays in the bank and stays visible in the inspector.
      return dropContradicted(this.store, [...byId.values()]).sort(byScoreThenId);
    };

    if (!this.#dreamRecords(session, owner)) {
      return merged(recall(this.store, options), coreProfile(this.store, { owner, limit: promptProfileLimit }));
    }

    const dream = this.config.memory.dream;
    const limitMax = Math.max(Math.round(clampNumber(dream.limitMax, 4, 16)), policy.limit);
    const maxFrameBytes = Math.round(clampNumber(dream.maxFrameBytes, 1000, 2_000_000));
    // Which half of the evidence this turn belongs to, stamped at record
    // time (E3). The unit is the SESSION, never the trace: two traces of one
    // session can never disagree, and the rates come from the one exported
    // constant the night reads back months later - if the recorder and the
    // evaluation ever picked their rates separately, a session would change
    // sides between the stamp and the measurement and the holdout would
    // quietly stop being one.
    const split = splitOf(session.id, DEFAULT_SPLIT_RATES);
    let memories: ScoredMemory[] = [];
    this.store.recordDreamTurn(() => {
      const trace = this.store.beginTrace({
        // One id per turn: every traced call of this turn carries it, and
        // labels attach to it rather than to any single call (R19).
        turnId,
        owner,
        kind: 'turn',
        site: 'turn',
        pipeline: 'assistant',
        sessionId: session.id,
        sessionKind: session.kind,
        // The position of this turn in its session: the messages stored
        // before it, which is the count the session carries at recall time.
        turnIndex: session.messageCount,
        policySet: { recall: policy },
        framed: true,
        holdout: split === 'holdout',
        audit: split === 'audit',
      });
      // The record, fetched before the ranking: the frame freezes
      // `access_count`, and the values worth freezing are the ones the live
      // scores are about to read - not the ones this turn's own touch will
      // write a moment later.
      const frame = fetchFrame(this.store, {
        ...options,
        box: declaredDreamBox(policy, limitMax),
        site: 'turn',
        pipeline: 'assistant',
        budgetChars: Math.floor(this.config.memory.contextBudget * 0.4),
        subject: 'this user',
        // A meta read and nothing more; empty until the first night has
        // stamped a fingerprint, which certifies nothing yet (R10).
        corpusStampId: this.store.currentCorpusStamp(owner)?.id ?? '',
      });
      const matched = recall(this.store, { ...options, touchContext: { traceId: trace.id, owner } });
      // One profile read at the permissive corner of the box, sliced down
      // for the prompt: the SQL behind `coreProfile` is prefix-invariant
      // now that it tie-breaks on id, so the wider read costs one query and
      // changes no row the prompt sees (R12).
      const profile = coreProfile(this.store, {
        owner,
        limit: Math.max(promptProfileLimit, Math.max(3, Math.floor(limitMax / 2))),
      }).slice(0, promptProfileLimit);
      memories = merged(matched, profile);
      // A frame over the size cap is refused rather than thrown at: the
      // trace still closes, without a frame, and the night simply never
      // scores this turn.
      if (!this.store.saveFrame(trace.id, 'recall', frame, { maxFrameBytes })) {
        this.log.debug('Dream frame refused: over dream.maxFrameBytes', { sessionId: session.id, turnId });
      }
      this.store.finishTrace(trace.id, { degraded: frame.degraded });
    });
    return memories;
  }

  #resolveSession(input: ChatInput): Session {
    if (input.sessionId) {
      const existing = this.store.getSession(input.sessionId);
      if (existing) return existing;
      this.log.warn('Unknown session, starting a new one', { sessionId: input.sessionId });
    }
    return this.createSession({
      // A spoken first turn opens a voice session, so the hands-free screen
      // never has to create one by hand.
      kind: input.voice ? 'voice' : 'chat',
      provider: input.provider,
      model: input.model,
      projectId: input.projectId,
      agentId: input.agentId,
    });
  }

  /** Extract and store durable memories from a finished exchange. */
  async #learn(
    sessionId: string,
    userText: string,
    assistantText: string,
    providerId: ProviderId,
    owner: string,
  ): Promise<void> {
    try {
      // What the model must not repeat is what is RELEVANT here, not what
      // happens to rank highest overall. Listing the forty most important
      // memories was the single biggest reason the bank kept growing: the
      // sentence about to be written again was almost never in that list.
      const known = relevantKnown(this.store, owner, userText + '\n' + assistantText);
      const candidates = await extractMemories(this.providers.get(providerId), {
        userText,
        assistantText,
        known,
        sessionId,
        model: smallModelFor(providerId),
      });
      const admitted = admitCandidates(this.store, {
        candidates,
        owner,
        config: this.config.memory,
        // The user's own message, and nothing else. The assistant's answer
        // goes to the extractor so it can tell what the exchange was about,
        // but a fact the assistant produced is not a fact the user confirmed,
        // and only the user's words may stand behind a memory about the user.
        sources: [userText],
        sourceSessionId: sessionId,
      });
      if (admitted.rejected.length) {
        this.log.debug('Memory gate rejected candidates', {
          count: admitted.rejected.length,
          reasons: admitted.rejected.map((entry) => entry.reason).join(','),
        });
      }
      const event: MemoryLearnedEvent = { sessionId, stored: admitted.stored };
      this.emit('memory', event);
    } catch (error) {
      this.log.warn('Memory extraction failed', { error: (error as Error).message });
    }
  }
}

/** "The assistant" or the agent's name, for the schedule's report line. */
function labelForOwner(assistant: Assistant, owner: string): string {
  if (owner === ASSISTANT_MEMORY_OWNER) return 'Assistant';
  return assistant.store.org.getAgent(owner)?.name ?? owner.slice(0, 8);
}

/**
 * The memories the extractor needs to see so it does not write them again:
 * whatever this exchange actually touches, plus the small core profile.
 *
 * Deliberately untraced: this is the `site: 'extract'` population of the
 * dream's vocabulary - `touch: false`, `expand: false`, a wider limit and a
 * lower threshold than any conversational turn. Stage 1 scores only
 * `site = 'turn'`, so the recorder does not sit here; wiring it in would
 * fill the night's pool with calls no label can ever attach to.
 */
function relevantKnown(store: Store, owner: string, text: string): string[] {
  const matched = recall(store, { text, owner, limit: 20, threshold: 0.05, touch: false, expand: false });
  const profile = coreProfile(store, { owner, limit: 5 });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const memory of [...matched, ...profile]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    out.push(memory.content);
  }
  return out;
}
