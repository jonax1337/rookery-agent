import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type {
  EffortLevel,
  Agent,
  AgentEvent,
  CronJob,
  CronRun,
  Mail,
  MemoryRecord,
  NotifyEvent,
  PermissionLevel,
  ProviderId,
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
import { Store } from './memory/store.js';
import { coreProfile, dropContradicted, recall } from './memory/recall.js';
import { extractMemories, smallModelFor } from './memory/extractor.js';
import { admitCandidates, linkEntities } from './memory/gate.js';
import { SleepRunner } from './memory/sleep.js';
import { buildSystemPrompt, deriveTitle } from './agents/persona.js';
import { BridgeServer } from './org/bridge.js';
import { OrgController } from './org/controller.js';
import { assistantOrgBlock } from './org/prompts.js';
import { dormantToolsHint, ensureToolServers, toolServersFor } from './tools/hub.js';
import { SkillStore, renderSkillsIndex } from './skills/store.js';
import { renderExternalSkillsHint } from './skills/shelf.js';
import { CronScheduler, type CronRunOutcome } from './cron/scheduler.js';
import { describeCron } from './cron/parse.js';
import { runCronScript } from './cron/script.js';
import { EventQueue } from './util/queue.js';

/**
 * The assistant runtime.
 *
 * One turn is: resolve session -> recall memories -> assemble context ->
 * stream the provider -> persist -> learn.
 *
 * There is no routing step and no agent selection. Rookery is one personal
 * assistant: the identity is fixed, and the provider only ever changes when
 * the caller asks for it or the current one is logged out. That matters
 * beyond persona - switching provider throws away `providerSessionId`, so a
 * router that changed its mind mid-conversation would silently drop the
 * thread the assistant was holding.
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
    this.org = new OrgController({
      store: this.store,
      registry: this.providers,
      config: this.config,
      bridge: new BridgeServer({ runDir: join(this.config.home, 'run') }),
      logger: this.log,
      cron: this.cron,
      sleep: this.sleep,
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
    this.cron.stop();
    void this.org.bridge.close();
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
   * starts. The job is an ordinary `cron_jobs` row, so it shows up on the
   * schedules page, can be edited, switched off or run by hand like any
   * other - there is no second, hidden timer anywhere.
   */
  ensureSleepSchedule(): CronJob | null {
    const sleep = this.config.memory.sleep;
    if (!sleep.enabled) return null;
    try {
      const organization = this.org.activeOrganization();
      const existing = this.cron.list(organization.id).find((job) => job.kind === 'sleep');
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

  /** One conversational turn, streamed. Assignments the turn starts ride the same stream. */
  async *chat(input: ChatInput): AsyncGenerator<AgentEvent, void, unknown> {
    const prompt = input.text.trim();
    if (!prompt) {
      yield { type: 'error', message: 'Nothing to send.', fatal: true };
      return;
    }

    const session = this.#resolveSession(input);
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
      const detail = statuses.map((s) => s.id + ': ' + (s.detail ?? 'unavailable')).join(' | ');
      yield { type: 'error', message: 'No AI provider is ready. ' + detail, fatal: true };
      return;
    }
    if (providerId !== wanted) {
      yield { type: 'status', label: 'provider', detail: wanted + ' is not logged in, using ' + providerId };
    }

    // Resuming the provider's own thread only works on the same provider.
    const resumed = Boolean(session.providerSessionId) && session.provider === providerId;
    const model = input.model ?? session.model ?? this.config.defaultModel;
    const effort = input.effort ?? this.config.defaultEffort;

    let memories: ScoredMemory[] = [];
    if (this.config.memory.enabled) {
      yield { type: 'status', label: 'recalling', detail: 'searching memory' };
      const matched = recall(this.store, {
        text: prompt,
        owner,
        limit: this.config.memory.recallLimit,
        threshold: this.config.memory.recallThreshold,
        hopEntity: this.config.memory.graph.hopEntity,
        hopEdge: this.config.memory.graph.hopEdge,
      });
      const profile = coreProfile(this.store, {
        owner,
        limit: Math.max(3, Math.floor(this.config.memory.recallLimit / 2)),
      });
      const byId = new Map<string, ScoredMemory>();
      for (const memory of profile) byId.set(memory.id, memory);
      for (const memory of matched) byId.set(memory.id, memory);
      // Of a contradicting pair only the newer sentence goes into the prompt;
      // the older one stays in the bank and stays visible in the inspector.
      memories = dropContradicted(this.store, [...byId.values()]).sort((a, b) => b.score - a.score);
      if (memories.length) {
        yield { type: 'memory', action: 'recalled', count: memories.length, items: memories };
      }
    }

    const history = resumed ? [] : this.store.getMessages(session.id, this.config.memory.workingWindow);

    // The company block: who works here, what is running, what arrived in
    // the mail. Read once per turn; the mail is then marked as read.
    const organization = this.org.activeOrganization();
    const snapshot = this.org.snapshot(organization.id);
    const mail = this.store.org.unreadMailFor(organization.id, { kind: 'assistant' });
    const project = session.projectId ? (this.store.org.getProject(session.projectId) ?? undefined) : undefined;
    if (mail.length) this.store.org.markMailReadFor(mail, { kind: 'assistant' });

    // The hub decides which extra MCP servers this turn gets, and the prompt
    // carries one paragraph per server plus the index of skills to open.
    const who = 'assistant';
    await ensureToolServers(this.config, who, providerId, project?.id, (id, error) =>
      this.log.warn('Tool server could not prepare', { id, error: error.message }),
    );
    const extra = toolServersFor(this.config, who, providerId, project?.id);
    // The assistant also hears about the servers it could attach but has not:
    // a switch it does not know about is a wall it cannot climb.
    const toolHints = [...extra.hints, dormantToolsHint(this.config, who, project?.id)].filter(Boolean);
    // Rookery's own shelf in full, and one paragraph for the far larger one
    // installed in Claude Code and Codex: what is there, not what it says.
    const skillsIndex = [renderSkillsIndex(this.skills.for(who)), renderExternalSkillsHint(this.config, who)]
      .filter(Boolean)
      .join('\n\n');
    const systemPrompt = buildSystemPrompt({
      config: this.config,
      query: prompt,
      memories,
      history,
      resumed,
      // A voice session speaks whichever surface the turn came from.
      voice: input.voice ?? session.kind === 'voice',
      orgBlock: assistantOrgBlock(this.config, snapshot, mail, project, this.cron.list(organization.id)),
      toolHints,
      skillsIndex,
      // Lets the memory block group itself by entity.
      store: this.store,
    });

    this.store.addMessage({ sessionId: session.id, role: 'user', content: prompt });
    if (session.messageCount === 0 && session.title === 'New conversation') {
      this.store.updateSession(session.id, { title: deriveTitle(prompt) });
    }

    const provider = this.providers.get(providerId);
    const started = Date.now();
    let answer = '';
    const toolCalls: Extract<AgentEvent, { type: 'tool' }>[] = [];
    let providerSessionId = resumed ? session.providerSessionId : undefined;
    let failed = false;
    let usage: TurnUsage | undefined;

    yield { type: 'session', sessionId: session.id, providerSessionId, provider: providerId, model };

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
            model,
            effort,
            cwd,
            permission: input.permission ?? this.config.defaultPermission,
            mcp,
            mcpExtra: currentSpecs.length ? currentSpecs : undefined,
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
              yield event;
              break;
            case 'text':
              passText += event.delta;
              yield event;
              break;
            case 'session':
              providerSessionId = event.providerSessionId ?? providerSessionId;
              break;
            case 'done':
              providerSessionId = event.providerSessionId ?? providerSessionId;
              passText = event.text || passText;
              usage = mergeUsage(usage, event.usage);
              break;
            case 'error':
              if (event.fatal) failed = true;
              yield event;
              break;
            default:
              yield event;
          }
        }
      } finally {
        await pump;
        this.org.unregister(token);
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
      const next = toolServersFor(this.config, who, providerId, project?.id);
      const fresh = next.specs.map((spec) => spec.name).filter((name) => !attached.has(name));
      if (!fresh.length) break;

      await ensureToolServers(this.config, who, providerId, project?.id, (id, error) =>
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
        orgBlock: assistantOrgBlock(this.config, snapshot, [], project, this.cron.list(organization.id)),
        toolHints: [...next.hints, dormantToolsHint(this.config, who, project?.id)].filter(Boolean),
        skillsIndex,
        store: this.store,
      });
      passPrompt = continuePrompt(fresh);
      yield { type: 'status', label: 'tools', detail: fresh.join(', ') + ' attached, carrying on' };
    }

    if (failed && !answer && !toolCalls.length) {
      // Nothing usable came back; leave the session context untouched so the
      // next attempt can still resume cleanly.
      return;
    }

    // The provider's numbers plus the wall-clock of the whole turn, so a
    // reloaded transcript can still show what the context looked like.
    const turnUsage: TurnUsage = { ...usage, durationMs: Date.now() - started };
    this.store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      content: answer,
      provider: providerId,
      model,
      usage: turnUsage,
      toolCalls,
    });
    if (failed && !answer) return;
    this.store.updateSession(session.id, { provider: providerId, model, providerSessionId });

    yield { type: 'done', text: answer, providerSessionId, usage: turnUsage };

    if (this.config.memory.enabled && this.config.memory.autoExtract) {
      void this.#learn(session.id, prompt, answer, providerId, owner);
    }
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
   * Execute one schedule. The assistant's own jobs run as a turn in a
   * conversation kept per job, so the user can open it and read along or
   * carry on; an agent's jobs run as an ordinary assignment.
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
      for await (const event of this.assign({ agent: agent.id, task: job.prompt, projectId: job.projectId, signal })) {
        if (event.type === 'assignment' && !assignmentId) assignmentId = event.assignment.id;
        else if (event.type === 'done') text = event.text;
        else if (event.type === 'error' && event.fatal) error = event.message;
      }
      return error ? { status: 'failed', error, assignmentId } : { status: 'done', result: text, assignmentId };
    }

    const existing = job.sessionId ? this.store.getSession(job.sessionId) : null;
    let sessionId: string;
    if (existing) {
      sessionId = existing.id;
      // The user may have archived the chat while this was pending; reusing
      // it silently would bury the reply where nobody looks for it.
      if (existing.archived) this.store.updateSession(existing.id, { archived: false });
    } else {
      sessionId = this.createSession({ title: 'Schedule: ' + job.name, projectId: job.projectId }).id;
      this.store.cron.updateJob(job.id, { sessionId }, false);
    }
    const when = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    const prompt =
      'Automatic run of schedule “' + job.name + '” (' + describeCron(job.schedule) + '), ' + when + '. ' +
      'Nobody is following live: carry out the assignment now and finish with a short report ' +
      'for the user to read later.\n\n' + job.prompt;
    let text = '';
    let error: string | undefined;
    for await (const event of this.chat({ text: prompt, sessionId, projectId: job.projectId, permission: job.permission, signal })) {
      if (event.type === 'done') text = event.text;
      else if (event.type === 'error' && event.fatal) error = event.message;
    }
    if (error && !text) return { status: 'failed', error, sessionId };
    if (job.kind === 'script' && text.trim() === '[SILENT]') return { status: 'done', result: '', silent: true, sessionId };
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
