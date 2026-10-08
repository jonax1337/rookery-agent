import { buildSystemPrompt } from '../agents/persona.js';
import { externalTurnExtras, toolServersFor } from '../tools/hub.js';
import type { ToolContext } from '../org/controller.js';
import { isUsageLimitError, rememberUsageFailure } from '../providers/quota.js';
import { remapModel } from '../providers/provider-catalog.js';
import type { AgentEvent, McpServerSpec, Provider, ProviderId, TurnUsage } from '../types.js';
import { EventQueue } from '../util/queue.js';
import {
  ASSISTANT_AUDIENCE,
  MAX_PROVIDER_ATTEMPTS,
  MAX_PROVIDER_PASSES,
  companyBlock,
  continuePrompt,
  freshServerNames,
  toolHintsFor,
  toolsAttachedStatus,
  type TurnPlan,
  type TurnServices,
} from './turn-support.js';
import { TurnTranscript } from './turn-transcript.js';

/** What one run of the provider process is started with. */
interface ProviderPass {
  provider: Provider;
  prompt: string;
  systemPrompt: string;
  specs: McpServerSpec[];
}

/** What one pass brought back. */
interface PassOutcome {
  text: string;
  failed: boolean;
}

/** The tool servers one audience gets this turn, as the hub hands them out. */
interface ToolServers {
  specs: McpServerSpec[];
  hints: string[];
}

/**
 * A conversational turn answered by a headless provider process: the
 * provider runs, its events and the company's merge into one stream, and the
 * answer is stored and learned from.
 *
 * A turn has up to two attempts (a different provider when the first died on
 * its usage limit with nothing to show) and each attempt up to two passes
 * (a second process when the assistant switched on a tool server mid-turn).
 */
export class HeadlessTurn {
  readonly #services: TurnServices;
  readonly #plan: TurnPlan;
  readonly #transcript: TurnTranscript;
  readonly #startedAt = Date.now();
  readonly #tried: Set<ProviderId>;
  /** The provider and model the turn ends up having run with. */
  #providerId: ProviderId;
  #model: string | undefined;
  #providerSessionId: string | undefined;
  #lastFatal: string | null = null;

  constructor(services: TurnServices, plan: TurnPlan) {
    this.#services = services;
    this.#plan = plan;
    // The same turn as an ordered transcript: text, thinking and tools in
    // arrival order, kept beside the flat views.
    this.#transcript = new TurnTranscript(plan.recall);
    this.#providerId = plan.providerId;
    this.#model = plan.model;
    this.#tried = new Set([plan.providerId]);
  }

  async *run(): AsyncGenerator<AgentEvent, void, unknown> {
    for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      const failed = yield* this.#attempt(attempt);
      // A turn that died on its usage limit with nothing to show goes around
      // once more on another provider. Anything else keeps today's semantics:
      // nothing usable came back, so the session context stays untouched for
      // the next attempt to resume cleanly.
      if (!failed || this.#transcript.hasOutput) break;
      const alternate = await this.#alternateProvider(attempt);
      if (!alternate) return;
      rememberUsageFailure(this.#providerId);
      yield {
        type: 'status',
        label: 'provider',
        detail: this.#providerId + ' hit its usage limit, continuing on ' + alternate,
      };
      this.#providerId = alternate;
      this.#tried.add(alternate);
      this.#transcript.restart();
    }
    yield* this.#finish();
  }

  /** One provider, start to end. Returns whether it died on a fatal error. */
  async *#attempt(attempt: number): AsyncGenerator<AgentEvent, boolean, unknown> {
    const { config, providers } = this.#services;
    // Each attempt answers for itself: a fatal error of the dead one must not
    // make a clean second attempt read as failed.
    this.#lastFatal = null;
    const { session, project } = this.#plan;
    const providerId = this.#providerId;
    // A different backend serves different names; the fallback provider's
    // own default stands in for a model it has never heard of.
    this.#model = attempt === 1 && providerId === this.#plan.wantedProvider
      ? this.#plan.model
      : remapModel(providerId, this.#plan.model);

    // The hub decides which extra MCP servers this attempt gets, and the
    // prompt carries one paragraph per server plus the index of skills to
    // open. Provider-scoped, so a switch attaches its own set.
    const extra = toolServersFor(config, ASSISTANT_AUDIENCE, providerId, project?.id);
    // Only the first attempt may resume the provider's own thread; a
    // fallback starts a fresh one on the new backend, and a retry cannot
    // resume the dead provider's thread, so it rebuilds its context from the
    // history it still has.
    const resumes = attempt === 1 && this.#plan.resumed;
    this.#providerSessionId = resumes ? session.providerSessionId : undefined;
    const provider = providers.get(providerId);

    yield {
      type: 'session',
      sessionId: session.id,
      providerSessionId: this.#providerSessionId,
      provider: providerId,
      model: this.#model,
    };

    // What this pass of the provider is run with. A turn usually has exactly
    // one pass; see the continuation below for why it sometimes has two.
    let pass: ProviderPass = {
      provider,
      prompt: this.#plan.prompt,
      systemPrompt: this.#systemPrompt(extra, resumes),
      specs: extra.specs,
    };
    let attached = extra.specs.map((spec) => spec.name);
    let failed = false;
    for (let passNumber = 1; passNumber <= MAX_PROVIDER_PASSES; passNumber += 1) {
      const outcome = yield* this.#runPass(pass);
      failed = outcome.failed;
      this.#transcript.appendAnswer(outcome.text);

      // The continuation. A tool server the assistant switched on mid-turn
      // can only be attached to a provider process that has not started yet,
      // so without this the work stalls until the user asks again - exactly
      // the dead end the assistant is told not to accept. Instead the turn
      // runs once more with the new servers attached and the provider's own
      // session resumed, and the two answers are joined.
      if (failed || passNumber === MAX_PROVIDER_PASSES || this.#plan.input.signal?.aborted) break;
      const next = toolServersFor(config, ASSISTANT_AUDIENCE, providerId, project?.id);
      const fresh = freshServerNames(next.specs, attached);
      if (!fresh.length) break;

      attached = next.specs.map((spec) => spec.name);
      pass = {
        provider,
        prompt: continuePrompt(fresh),
        systemPrompt: this.#systemPrompt(next, true),
        specs: next.specs,
      };
      yield toolsAttachedStatus(fresh);
    }
    return failed;
  }

  /** The provider a usage-limited turn moves to, or null when it should simply end. */
  async #alternateProvider(attempt: number): Promise<ProviderId | null> {
    const { config, providers } = this.#services;
    const lastFatal = this.#lastFatal;
    const mayFallBack =
      config.providerFallback.enabled &&
      attempt < MAX_PROVIDER_ATTEMPTS &&
      !this.#plan.input.signal?.aborted &&
      lastFatal !== null &&
      isUsageLimitError(lastFatal);
    if (!mayFallBack) return null;
    return providers.resolveUsable(this.#plan.wantedProvider, { exclude: [...this.#tried] });
  }

  #systemPrompt(extra: ToolServers, resumed: boolean): string {
    const { config, store } = this.#services;
    const { input, session, project } = this.#plan;
    return buildSystemPrompt({
      config,
      query: this.#plan.prompt,
      memories: this.#plan.memories,
      history: this.#plan.history,
      resumed,
      // A voice session speaks whichever surface the turn came from.
      voice: input.voice ?? session.kind === 'voice',
      orgBlock: companyBlock(this.#services, this.#plan.organizationId, project, this.#plan.snapshot),
      toolHints: toolHintsFor(config, extra.hints, project?.id),
      skillsIndex: this.#plan.skillsIndex,
      // Lets the memory block group itself by entity.
      store,
    });
  }

  /**
   * One run of the provider process. Everything the turn produces goes
   * through one queue: the provider's own events, and whatever the tool calls
   * it makes cause in the company.
   */
  async *#runPass(pass: ProviderPass): AsyncGenerator<AgentEvent, PassOutcome, unknown> {
    const { org, questions } = this.#services;
    const queue = new EventQueue<AgentEvent>();
    const token = org.register(this.#bridgeContext(queue));
    const pump = this.#pump(queue, token, pass);
    const outcome: PassOutcome = { text: '', failed: false };
    try {
      for await (const event of queue.drain()) {
        if (this.#absorb(event, outcome)) yield event;
      }
    } finally {
      await pump;
      org.unregister(token);
      // Every exit, not only an abort: a provider crash or a fallback
      // switch ends the pass without the signal ever firing, and the
      // questions it asked would otherwise stand answerable on every
      // surface for their full timeout, reaching a tool call that is gone.
      questions.cancelForOwner(token);
    }
    return outcome;
  }

  #bridgeContext(queue: EventQueue<AgentEvent>): ToolContext {
    const { session, input } = this.#plan;
    return {
      orgId: this.#plan.organizationId,
      audience: ASSISTANT_AUDIENCE,
      agentId: undefined,
      sessionId: session.id,
      projectId: session.projectId,
      depth: -1,
      // A scheduled chat run works under the same rule as a scheduled
      // assignment: it may read memory and open skills, but nothing it
      // does lands back in the bank - no extraction, no tools that write.
      // That covers every run with nobody in front of it: a session of
      // kind `schedule`, the old mail-answer turn (`kind: 'mail'`, no
      // longer created), and a schedule pinned to an ordinary
      // conversation, which arrives with
      // `input.scheduled` set. All three are exactly the runs that must
      // not be offered `ask_user` - there is no screen to answer on.
      scheduled: input.scheduled === true || session.kind === 'schedule' || session.kind === 'mail',
      watching: input.watching === true,
      emit: (event) => queue.push(event),
      signal: input.signal,
    };
  }

  /** Runs the provider and feeds its events into the queue; ends the queue however the run ends. */
  async #pump(queue: EventQueue<AgentEvent>, token: string, pass: ProviderPass): Promise<void> {
    const { config, org } = this.#services;
    const { input } = this.#plan;
    const resume = this.#providerSessionId;
    try {
      const mcp = await org.bridge.spec(token);
      for await (const event of pass.provider.run({
        prompt: pass.prompt,
        systemPrompt: pass.systemPrompt,
        systemPromptMode: 'replace',
        providerSessionId: resume,
        model: this.#model,
        effort: this.#plan.effort,
        // The assistant stays in the workspace, not a project directory - it
        // is a person, not Claude Code's coding agent.
        cwd: config.workspace,
        permission: input.permission ?? config.defaultPermission,
        mcp,
        mcpExtra: pass.specs.length ? pass.specs : undefined,
        // Approved subagents and hooks out of the Claude Code
        // installation, plus Rookery's own permission floor.
        ...externalTurnExtras(config, ASSISTANT_AUDIENCE),
        signal: input.signal,
      })) {
        queue.push(event);
      }
    } catch (error) {
      queue.push({ type: 'error', message: (error as Error).message, fatal: true });
    } finally {
      queue.close();
    }
  }

  /**
   * Files one event of a pass into the turn's state. Returns whether the
   * event goes on to the stream: the provider's `session` and `done` are
   * bookkeeping and stay inside.
   *
   * Questions go into this stream only. The assistant's emitter already
   * carries both question events - forwarded from the registry, which fires
   * them even when this queue is long closed - so the phone and a second tab
   * see the card without this turn's help, and emitting here as well would
   * say everything twice.
   */
  #absorb(event: AgentEvent, outcome: PassOutcome): boolean {
    switch (event.type) {
      case 'tool':
        this.#transcript.record(event);
        // Also on the assistant's own emitter, not just this stream: a
        // channel that is not the one that started the turn has no other
        // way to see what is being done.
        this.#services.announceTool(event);
        return true;
      case 'text':
        outcome.text += event.delta;
        this.#transcript.record(event);
        return true;
      case 'thinking':
        // Explicit only so the transcript folds it in.
        this.#transcript.record(event);
        return true;
      case 'session':
        this.#providerSessionId = event.providerSessionId ?? this.#providerSessionId;
        return false;
      case 'done':
        this.#providerSessionId = event.providerSessionId ?? this.#providerSessionId;
        outcome.text = event.text || outcome.text;
        this.#transcript.reconcile(event.text);
        this.#transcript.addUsage(event.usage);
        return false;
      case 'error':
        if (event.fatal) {
          outcome.failed = true;
          this.#lastFatal = event.message;
        }
        return true;
      default:
        return true;
    }
  }

  /** Stores the answer, moves the session onto what answered it, and says `done`. */
  async *#finish(): AsyncGenerator<AgentEvent, void, unknown> {
    const { store } = this.#services;
    const { session, turnId } = this.#plan;
    const answer = this.#transcript.answer;
    // The provider's numbers plus the wall-clock of the whole turn, so a
    // reloaded transcript can still show what the context looked like.
    const usage: TurnUsage = { ...this.#transcript.usage, durationMs: Date.now() - this.#startedAt };
    store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      turnId,
      provider: this.#providerId,
      model: this.#model,
      usage,
      ...this.#transcript.storedViews(),
    });
    if (this.#lastFatal !== null && !answer) return;
    store.updateSession(session.id, {
      provider: this.#providerId,
      model: this.#model,
      providerSessionId: this.#providerSessionId,
    });

    yield { type: 'done', text: answer, providerSessionId: this.#providerSessionId, usage };

    // Scheduled runs stay out of the memory: the "user" side of that
    // exchange is Rookery's own boilerplate plus the job's prompt, not
    // something the user said today, and quoting it would file the job
    // description again on every firing. Neither does a report-back, which
    // is Rookery speaking.
    if (session.kind !== 'schedule' && this.#plan.input.origin !== 'system') {
      this.#services.learn(session.id, this.#plan.prompt, answer, this.#providerId);
    }
  }
}
