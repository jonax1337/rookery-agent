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
import { extractMemories, smallModelFor } from './memory/extractor.js';
import { admitCandidates, linkEntities } from './memory/gate.js';
import { SleepRunner } from './memory/sleep.js';
import { buildSystemPrompt, deriveTitle } from './agents/persona.js';
import { BridgeServer } from './org/bridge.js';
import { OrgController } from './org/controller.js';
import { QuestionRegistry } from './org/questions.js';
import { assistantOrgBlock } from './org/prompts.js';
import { dormantToolsHint, ensureToolServers, externalTurnExtras, toolServersFor } from './tools/hub.js';
import { SkillStore, renderSkillsIndex } from './skills/store.js';
import { renderExternalSkillsHint } from './skills/shelf.js';
import { matchSkills, renderSkillMatches } from './skills/suggest.js';
import { CronScheduler, type CronRunOutcome } from './cron/scheduler.js';
import { describeCron } from './cron/parse.js';
import { runCronScript } from './cron/script.js';
import { EventQueue } from './util/queue.js';
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
    this.sleep = new SleepRunner({
      store: this.store,
      registry: this.providers,
      config: this.config,
      logger: this.log,
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
    const journal = { begun: false };
    try {
      for await (const event of this.#chatTurn(input, turnId, journal)) {
        if (journal.begun) this.store.turns.append(turnId, event as unknown as Record<string, unknown>);
        yield event;
      }
      if (journal.begun) this.store.turns.settle(turnId, 'done', Date.now());
    } catch (error) {
      // The turn died mid-flight. Whatever reached the journal is the only
      // record of it - it stays, marked, rather than vanishing whole.
      if (journal.begun) this.store.turns.settle(turnId, 'interrupted', Date.now());
      throw error;
    }
  }

  async *#chatTurn(
    input: ChatInput,
    turnId: string,
    journal: { begun: boolean },
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const prompt = input.text.trim();
    if (!prompt) {
      yield { type: 'error', message: 'Nothing to send.', fatal: true };
      return;
    }

    const session = this.#resolveSession(input);
    this.store.turns.begin(turnId, session.id, 'chat', Date.now());
    journal.begun = true;
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
    if (this.config.memory.enabled) {
      yield { type: 'status', label: 'recalling', detail: 'searching memory' };
      // One truth about the recall parameters (concept 9.3): the resolver
      // clamps at read time and both the turn and the recorder read it here,
      // so a config change cannot leave the record and the live turn
      // disagreeing about which policy produced the prompt.
      const policy = resolvePolicy(this.store, this.config, owner, 'recall');
      memories = this.#turnMemories(session, owner, prompt, policy);
      if (memories.length) {
        yield { type: 'memory', action: 'recalled', count: memories.length, items: memories };
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
    this.store.addMessage({ sessionId: session.id, role: 'user', content: prompt });
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
      usedModel = attempt === 1 ? model : remapModel(pid, model);

      // The hub decides which extra MCP servers this attempt gets, and the
      // prompt carries one paragraph per server plus the index of skills to
      // open. Provider-scoped, so a switch attaches its own set.
      await ensureToolServers(this.config, who, pid, project?.id, (id, error) =>
        this.log.warn('Tool server could not prepare', { id, error: error.message }),
      );
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

        await ensureToolServers(this.config, who, pid, project?.id, (id, error) =>
          this.log.warn('Tool server could not prepare', { id, error: error.message }),
        );
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
   * assignment's events and ends with `done` carrying the report.
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

    const queue = new EventQueue<AgentEvent>();
    const run = this.org
      .run({
        orgId: organization.id,
        agent,
        task,
        projectId: input.projectId,
        sessionId: input.sessionId,
        requesterKind: 'user',
        depth: 0,
        scheduled: input.scheduled,
        emit: (event) => queue.push(event),
        signal: input.signal,
      })
      .finally(() => queue.close());

    for await (const event of queue.drain()) yield event;
    const assignment = await run;

    if (assignment.status === 'done') {
      yield { type: 'done', text: assignment.result ?? '', usage: { durationMs: assignment.durationMs } };
    } else {
      yield {
        type: 'error',
        message: 'Assignment ' + assignment.status + (assignment.error ? ': ' + assignment.error : '.'),
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
      for await (const event of this.assign({ agent: agent.id, task: job.prompt, projectId: job.projectId, signal, scheduled: true })) {
        if (event.type === 'assignment' && !assignmentId) assignmentId = event.assignment.id;
        else if (event.type === 'done') text = event.text;
        else if (event.type === 'error' && event.fatal) error = event.message;
      }
      return error ? { status: 'failed', error, assignmentId } : { status: 'done', result: text, assignmentId };
    }

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
    const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const prompt =
      'Automatic run of schedule “' + job.name + '” (' +
      (job.schedule ? describeCron(job.schedule) : 'fired by an event') + '), ' + when + '. ' +
      'Nobody is following live: carry out the assignment now and finish with a short report ' +
      'for the user to read later. If carrying it out already delivers the result to the user by ' +
      'itself (for example you send_mail them the thing this job exists to send), that mail is the ' +
      'delivery - reply with exactly [SILENT] and nothing else, so a second "schedule completed" ' +
      'notification is not posted on top of it.\n\n' + job.prompt;
    let text = '';
    let error: string | undefined;
    for await (const event of this.chat({ text: prompt, sessionId, projectId: job.projectId, permission: job.permission, signal, scheduled: true })) {
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
   */
  #turnMemories(session: Session, owner: string, prompt: string, policy: RecallPolicy): ScoredMemory[] {
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
    // One id per turn: every traced call of this turn carries it, and labels
    // attach to it rather than to any single call (R19).
    const turnId = randomUUID();
    let memories: ScoredMemory[] = [];
    this.store.recordDreamTurn(() => {
      const trace = this.store.beginTrace({
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
