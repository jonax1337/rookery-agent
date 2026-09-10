import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type {
  EffortLevel,
  Agent,
  AgentEvent,
  CronJob,
  CronRun,
  MemoryRecord,
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
import { coreProfile, recall } from './memory/recall.js';
import { extractMemories, smallModelFor } from './memory/extractor.js';
import { buildSystemPrompt, deriveTitle } from './agents/persona.js';
import { BridgeServer } from './org/bridge.js';
import { OrgController } from './org/controller.js';
import { assistantOrgBlock, buildAgentChatPrompt } from './org/prompts.js';
import { ensureToolServers, toolServersFor } from './tools/hub.js';
import { SkillStore, renderSkillsIndex } from './skills/store.js';
import { CronScheduler, type CronRunOutcome } from './cron/scheduler.js';
import { describeCron } from './cron/parse.js';
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
    this.org = new OrgController({
      store: this.store,
      registry: this.providers,
      config: this.config,
      bridge: new BridgeServer({ runDir: join(this.config.home, 'run') }),
      logger: this.log,
      cron: this.cron,
    });
    this.cron.on('cron', (event: AgentEvent) => this.emit('cron', event));
    this.cron.on('message', (event: AgentEvent) => this.emit('message', event));
    // Anything an agent does is interesting to every client, not only the
    // turn that caused it: the org page shows activity live.
    this.org.on('assignment', (event: AgentEvent) => this.emit('assignment', event));
    this.org.on('message', (event: AgentEvent) => this.emit('message', event));
    this.org.on('task', (event: AgentEvent) => this.emit('task', event));
    this.org.on('changed', (change: { kind: string; id: string }) => this.emit('changed', change));
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

  /** Recent sessions; `agentId` narrows to one counterpart (`null` = the assistant), `kind` to chats or voice. */
  listSessions(limit = 50, agentId?: string | null, kind?: SessionKind): Session[] {
    return this.store.listSessions({ limit, agentId, kind });
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
      touch: false,
    });
  }

  rememberFact(input: { content: string; kind?: MemoryRecord['kind']; tags?: string[]; importance?: number }): MemoryRecord {
    return this.store.upsertMemory({
      kind: input.kind ?? 'fact',
      content: input.content,
      tags: input.tags,
      importance: input.importance,
      owner: ASSISTANT_MEMORY_OWNER,
    });
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
    // The counterpart: an agent for a direct chat, otherwise the assistant.
    const agent: Agent | null = session.agentId ? this.store.org.getAgent(session.agentId) : null;
    if (session.agentId && !agent) {
      yield { type: 'error', message: 'The agent this conversation belonged to no longer exists.', fatal: true };
      return;
    }
    const owner = agent ? agent.id : ASSISTANT_MEMORY_OWNER;
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
      });
      const profile = coreProfile(this.store, {
        owner,
        limit: Math.max(3, Math.floor(this.config.memory.recallLimit / 2)),
      });
      const byId = new Map<string, ScoredMemory>();
      for (const memory of profile) byId.set(memory.id, memory);
      for (const memory of matched) byId.set(memory.id, memory);
      memories = [...byId.values()].sort((a, b) => b.score - a.score);
      if (memories.length) {
        yield { type: 'memory', action: 'recalled', count: memories.length, items: memories };
      }
    }

    const history = resumed ? [] : this.store.getMessages(session.id, this.config.memory.workingWindow);

    // The company block: who works here, what is running, what arrived in
    // the inbox. Read once per turn; the inbox is then marked as read.
    const organization = this.org.activeOrganization();
    const snapshot = this.org.snapshot(organization.id);
    const inbox = this.store.org.inbox(organization.id, agent?.id ?? null, { unreadOnly: true });
    const project = session.projectId ? (this.store.org.getProject(session.projectId) ?? undefined) : undefined;
    if (inbox.length) this.store.org.markRead(inbox.map((message) => message.id));

    // The hub decides which extra MCP servers this turn gets, and the prompt
    // carries one paragraph per server plus the index of skills to open.
    const who = agent ? 'agent' : 'assistant';
    await ensureToolServers(this.config, who, providerId, (id, error) =>
      this.log.warn('Tool server could not prepare', { id, error: error.message }),
    );
    const extra = toolServersFor(this.config, who, providerId);
    const skillsIndex = renderSkillsIndex(this.skills.for(who));
    const systemPrompt = agent
      ? buildAgentChatPrompt({
          config: this.config, agent, snapshot, memories, inbox, history, resumed, project,
          toolHints: extra.hints, skillsIndex,
        })
      : buildSystemPrompt({
          config: this.config,
          memories,
          history,
          resumed,
          // A voice session speaks whichever surface the turn came from.
          voice: input.voice ?? session.kind === 'voice',
          orgBlock: assistantOrgBlock(this.config, snapshot, inbox, project, this.cron.list(organization.id)),
          toolHints: extra.hints,
          skillsIndex,
        });

    this.store.addMessage({ sessionId: session.id, role: 'user', content: prompt });
    if (session.messageCount === 0 && session.title === 'New conversation') {
      this.store.updateSession(session.id, { title: deriveTitle(prompt) });
    }

    const provider = this.providers.get(providerId);
    const started = Date.now();
    let answer = '';
    let providerSessionId = resumed ? session.providerSessionId : undefined;
    let failed = false;
    let usage: TurnUsage | undefined;

    yield { type: 'session', sessionId: session.id, providerSessionId, provider: providerId, model };

    // Everything the turn produces goes through one queue: the provider's
    // own events, and whatever the tool calls it makes cause in the company.
    const queue = new EventQueue<AgentEvent>();
    const token = this.org.register({
      orgId: organization.id,
      audience: agent ? 'agent' : 'assistant',
      agentId: agent?.id,
      sessionId: session.id,
      projectId: session.projectId,
      depth: agent ? 0 : -1,
      emit: (event) => queue.push(event),
      signal: input.signal,
    });
    // An agent in a chat may look at its project; the assistant stays in the
    // workspace and is a person, not Claude Code's coding agent.
    const cwd = agent && project?.path ? project.path : this.config.workspace;

    const pump = (async () => {
      try {
        const mcp = await this.org.bridge.spec(token);
        for await (const event of provider.run({
          prompt,
          systemPrompt,
          systemPromptMode: agent ? 'append' : 'replace',
          providerSessionId,
          model,
          effort,
          cwd,
          permission: input.permission ?? agent?.permission ?? this.config.defaultPermission,
          mcp,
          mcpExtra: extra.specs.length ? extra.specs : undefined,
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

    try {
      for await (const event of queue.drain()) {
        switch (event.type) {
          case 'text':
            answer += event.delta;
            yield event;
            break;
          case 'session':
            providerSessionId = event.providerSessionId ?? providerSessionId;
            break;
          case 'done':
            providerSessionId = event.providerSessionId ?? providerSessionId;
            answer = event.text || answer;
            usage = event.usage;
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

    if (failed && !answer) {
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
    });
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
    if (job.kind === 'agent') {
      const agent = job.agentId ? this.store.org.getAgent(job.agentId) : null;
      if (!agent || agent.archived) return { status: 'failed', error: 'Der Agent dieses Zeitplans existiert nicht mehr.' };
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

    let sessionId = job.sessionId && this.store.getSession(job.sessionId) ? job.sessionId : undefined;
    if (!sessionId) {
      sessionId = this.createSession({ title: 'Zeitplan: ' + job.name, projectId: job.projectId }).id;
      this.store.cron.updateJob(job.id, { sessionId }, false);
    }
    const when = new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
    const prompt =
      'Automatischer Lauf des Zeitplans „' + job.name + '“ (' + describeCron(job.schedule) + '), ' + when + '. ' +
      'Niemand liest gerade live mit: erledige den Auftrag jetzt und schließe mit einem kurzen Bericht ab, ' +
      'den der Nutzer später liest.\n\n' + job.prompt;
    let text = '';
    let error: string | undefined;
    for await (const event of this.chat({ text: prompt, sessionId, projectId: job.projectId, permission: job.permission, signal })) {
      if (event.type === 'done') text = event.text;
      else if (event.type === 'error' && event.fatal) error = event.message;
    }
    if (error && !text) return { status: 'failed', error, sessionId };
    return { status: 'done', result: text, sessionId };
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
      const known = this.store.listMemories({ owner, limit: 40 }).map((memory) => memory.content);
      const candidates = await extractMemories(this.providers.get(providerId), {
        userText,
        assistantText,
        known,
        sessionId,
        model: smallModelFor(providerId),
      });
      const stored: MemoryRecord[] = [];
      for (const candidate of candidates) {
        stored.push(this.store.upsertMemory({ ...candidate, owner, sourceSessionId: sessionId }));
      }
      const event: MemoryLearnedEvent = { sessionId, stored };
      this.emit('memory', event);
    } catch (error) {
      this.log.warn('Memory extraction failed', { error: (error as Error).message });
    }
  }
}
