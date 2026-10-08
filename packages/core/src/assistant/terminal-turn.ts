import { renderMemoryBlock } from '../memory/recall.js';
import { toolServersFor } from '../tools/hub.js';
import type { AgentEvent, ConversationTerminalTurn, TurnUsage } from '../types.js';
import { formatNow } from '../util/time.js';
import { EventQueue } from '../util/queue.js';
import { deriveTitle } from '../agents/persona.js';
import { MEMORY_BLOCK_BUDGET_SHARE } from './dream-recorder.js';
import { DEFAULT_SESSION_TITLE } from './sessions.js';
import type { ChatTerminal, TerminalWant, TypedTurn } from './terminals.js';
import {
  ASSISTANT_AUDIENCE,
  MAX_PROVIDER_PASSES,
  companyBlock,
  continuePrompt,
  freshServerNames,
  skillMatchesFor,
  reportIfRejected,
  toolsAttachedStatus,
  type TurnPlan,
  type TurnServices,
} from './turn-support.js';
import { TurnTranscript } from './turn-transcript.js';

/** How a turn typed into the terminal ended, for storing and reporting it. */
interface TerminalOutcome {
  terminal: ChatTerminal;
  /** The model the transcript says answered. */
  answeredBy: string | undefined;
  failure: string | undefined;
  startedAt: number;
}

/**
 * A conversational turn answered by typing into the conversation's Claude
 * Code terminal (T1). Recall, the stored user message and the provider
 * choice are shared with the headless turn; what follows differs: the
 * process is long-lived, so what a headless turn rebuilds into its system
 * prompt every time goes in through the prompt hook instead (T2).
 */
export class TerminalTurn {
  readonly #services: TurnServices;
  readonly #plan: TurnPlan;
  readonly #transcript: TurnTranscript;

  constructor(services: TurnServices, plan: TurnPlan) {
    this.#services = services;
    this.#plan = plan;
    this.#transcript = new TurnTranscript(plan.recall);
  }

  async *run(): AsyncGenerator<AgentEvent, void, unknown> {
    const { session, input } = this.#plan;
    const startedAt = Date.now();
    const want: TerminalWant = {
      providerId: this.#plan.providerId,
      model: this.#plan.model,
      effort: this.#plan.effort,
      permission: input.permission ?? this.#services.config.defaultPermission,
    };

    let terminal: ChatTerminal;
    try {
      terminal = await this.#terminalFor(want);
    } catch (error) {
      yield { type: 'error', message: (error as Error).message, fatal: true };
      return;
    }

    let prompt = this.#plan.prompt;
    let promptContext: string | undefined = this.#promptContext();
    let answeredBy = terminal.model;
    let failure: string | undefined;
    for (let pass = 1; pass <= MAX_PROVIDER_PASSES; pass += 1) {
      yield {
        type: 'session',
        sessionId: session.id,
        providerSessionId: terminal.handle.providerSessionId,
        provider: this.#plan.providerId,
        ...(terminal.model ? { model: terminal.model } : {}),
      };
      const result = yield* this.#submit(terminal, prompt, promptContext);
      answeredBy = result.model ?? answeredBy;
      if (result.model) terminal.models.add(result.model);
      this.#transcript.addUsage(result.usage);
      this.#transcript.appendAnswer(result.answer);
      if (result.error) {
        failure = result.error;
        break;
      }
      if (result.interrupted || input.signal?.aborted || pass === MAX_PROVIDER_PASSES) break;

      // The continuation (T3): a tool server switched on during the turn
      // needs a process that has it attached. The terminal restarts on the
      // same session with it, and the work carries on.
      const next = toolServersFor(this.#services.config, ASSISTANT_AUDIENCE, this.#plan.providerId, session.projectId);
      const fresh = freshServerNames(next.specs, terminal.servers);
      if (!fresh.length) break;
      yield toolsAttachedStatus(fresh);
      try {
        terminal = await this.#restart({ ...want, model: answeredBy ?? this.#plan.model });
      } catch (error) {
        failure = (error as Error).message;
        break;
      }
      prompt = continuePrompt(fresh);
      promptContext = undefined;
    }

    yield* this.#finish({ terminal, answeredBy, failure, startedAt });
  }

  /**
   * A turn nobody typed brings no settings of its own - it takes the
   * terminal as the person left it rather than restarting it onto the
   * defaults (a different model, other rights) in the middle of their work.
   */
  async #terminalFor(want: TerminalWant): Promise<ChatTerminal> {
    const { terminals } = this.#services;
    const { session, input } = this.#plan;
    const running = terminals.running(session.id);
    return input.origin === 'system' && running?.handle.alive() ? running : terminals.ensure(session, want);
  }

  /** The terminal again on the same session, with the tool servers the hub offers now. */
  async #restart(want: TerminalWant): Promise<ChatTerminal> {
    const { store, terminals } = this.#services;
    const { session } = this.#plan;
    return terminals.ensure(store.getSession(session.id) ?? session, want);
  }

  /**
   * The context the prompt hook hands Claude Code with this message: the
   * recall, the company as it is right now, the skills that look like it.
   */
  #promptContext(): string {
    const { config, store } = this.#services;
    const budget = config.memory.contextBudget;
    return [
      renderMemoryBlock(this.#plan.memories, Math.floor(budget * MEMORY_BLOCK_BUDGET_SHARE), 'this user', store),
      companyBlock(this.#services, this.#plan.organizationId, this.#plan.project),
      skillMatchesFor(config, this.#plan.ownSkills, this.#plan.prompt),
      'It is now ' + formatNow() + '.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  /** Types one message into the terminal and streams what comes back until it is answered. */
  async *#submit(
    terminal: ChatTerminal,
    prompt: string,
    context: string | undefined,
  ): AsyncGenerator<AgentEvent, ConversationTerminalTurn, unknown> {
    const { signal } = this.#plan.input;
    const queue = new EventQueue<AgentEvent>();
    // The bridge token outlives the turn; its events belong to whichever
    // turn is typing into the terminal right now.
    terminal.context.emit = (event) => queue.push(event);
    // And its signal: an `assign` this turn waits on is stopped with it.
    terminal.context.signal = signal;
    const submitted = terminal.handle
      .submit({ prompt, context, onEvent: (event) => queue.push(event), signal })
      .finally(() => queue.close());
    let drained = false;
    try {
      for await (const event of queue.drain()) {
        this.#record(event);
        yield event;
      }
      drained = true;
    } finally {
      terminal.context.emit = () => undefined;
      terminal.context.signal = undefined;
      // A consumer that walked away never awaits the result.
      if (!drained) reportIfRejected(submitted, this.#services.log, 'Terminal turn, after its stream ended,');
    }
    return await submitted;
  }

  #record(event: AgentEvent): void {
    if (event.type === 'tool') {
      this.#transcript.record(event);
      this.#services.announceTool(event);
    } else if (event.type === 'text' || event.type === 'thinking') {
      this.#transcript.record(event);
    }
  }

  /** Stores the answer, moves the session onto what answered it, and says `done`. */
  async *#finish(outcome: TerminalOutcome): AsyncGenerator<AgentEvent, void, unknown> {
    const { store, terminals } = this.#services;
    const { session, turnId, providerId } = this.#plan;
    const { terminal, answeredBy, failure } = outcome;
    const answer = this.#transcript.answer;
    const providerSessionId = terminal.handle.providerSessionId;

    if (failure) yield { type: 'error', message: failure, fatal: !answer };
    this.#transcript.reconcile(answer);
    const usage: TurnUsage = { ...this.#transcript.usage, durationMs: Date.now() - outcome.startedAt };
    const answeredOn = terminals.gatewayOwner(answeredBy, providerId);
    store.addMessage({
      sessionId: session.id,
      role: 'assistant',
      turnId,
      provider: answeredOn,
      model: answeredBy,
      usage,
      ...this.#transcript.storedViews(),
    });
    store.updateSession(session.id, { provider: answeredOn, model: answeredBy, providerSessionId });
    if (failure && !answer) return;

    yield { type: 'done', text: answer, providerSessionId, usage };

    if (this.#plan.input.origin !== 'system') {
      this.#services.learn(session.id, this.#plan.prompt, answer, answeredOn);
    }
  }
}

/** A turn a person typed straight into the terminal, stored like a chat turn. */
export function storeTypedTurn(
  services: TurnServices,
  sessionId: string,
  turn: TypedTurn,
  openedWith: string | undefined,
): void {
  const { store, terminals } = services;
  if (turn.prompt) store.addMessage({ sessionId, role: 'user', content: turn.prompt });
  // Stored the way a chat turn stores itself: the tool calls, and the
  // ordered transcript the thread renders them from - or the chat would
  // show a terminal turn as bare text.
  const transcript = new TurnTranscript();
  for (const event of turn.events) transcript.record(event);
  transcript.reconcile(turn.answer);
  transcript.appendAnswer(turn.answer);
  // Whoever actually answered: `/model` in the terminal may have moved
  // the conversation to another provider since it opened.
  const answeredBy = turn.model ?? openedWith;
  const answeredOn = terminals.gatewayOwner(answeredBy, 'claude');
  store.addMessage({
    sessionId,
    role: 'assistant',
    provider: answeredOn,
    model: answeredBy,
    usage: turn.usage,
    ...transcript.storedViews(),
  });
  titleFromFirstPrompt(services, sessionId, turn.prompt);
  store.updateSession(sessionId, { provider: answeredOn, model: answeredBy, providerSessionId: turn.providerSessionId });
  services.announceChanged(sessionId);
  if (turn.prompt) services.learn(sessionId, turn.prompt, turn.answer, answeredOn);
}

/** A conversation still called `New conversation` takes its name from what was first typed. */
function titleFromFirstPrompt(services: Pick<TurnServices, 'store'>, sessionId: string, prompt: string): void {
  if (!prompt) return;
  const current = services.store.getSession(sessionId);
  if (current && current.title === DEFAULT_SESSION_TITLE) {
    services.store.updateSession(sessionId, { title: deriveTitle(prompt) });
  }
}
