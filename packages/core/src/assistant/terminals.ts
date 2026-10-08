import type { CronScheduler } from '../cron/scheduler.js';
import type { Logger } from '../logger.js';
import type { Store } from '../memory/store.js';
import type { OrgController, ToolContext } from '../org/controller.js';
import type { QuestionRegistry } from '../org/questions.js';
import { loadPty, tuiSessions } from '../providers/claude-tui.js';
import type { LoopbackEndpoint } from '../providers/loopback-server.js';
import { ModelGateway } from '../providers/model-gateway.js';
import { remapModel } from '../providers/provider-catalog.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { renderExternalSkillsHint } from '../skills/shelf.js';
import { renderSkillsIndex, type SkillStore } from '../skills/store.js';
import { externalTurnExtras, toolServersFor } from '../tools/hub.js';
import { buildSystemPrompt } from '../agents/persona.js';
import type {
  ConversationTerminalHandle,
  EffortLevel,
  McpServerSpec,
  PermissionLevel,
  Project,
  Provider,
  ProviderId,
  ProviderProfile,
  ProviderTerminalHandlers,
  RookeryConfig,
  Session,
} from '../types.js';
import { ASSISTANT_AUDIENCE, companyBlock, toolHintsFor } from './turn-support.js';
import type { ChatInput } from './types.js';

/** The terminal registry's key for a conversation - runs use their assignment id. */
export function conversationTerminalKey(sessionId: string): string {
  return 'chat:' + sessionId;
}

/** How long a closed terminal gets to leave the registry before the caller moves on, and how often that is checked. */
const TERMINAL_EXIT_WAIT_MS = 5000;
const TERMINAL_EXIT_POLL_MS = 100;

/** A conversation's Claude Code process, and what it was started with. */
export interface ChatTerminal {
  handle: ConversationTerminalHandle;
  /** Effort, rights, project and tool servers - a change restarts it (T3). */
  signature: string;
  /**
   * Every name its model has gone by: the one it was started with, the one
   * that was asked for, the full id the transcript reports. A turn asking
   * for any of them is asking for the model it already runs - comparing one
   * spelling restarted the terminal on every other turn.
   */
  models: Set<string>;
  /** The tool servers it was started with, for the continuation check. */
  servers: string[];
  /** The context its bridge token answers with; `emit` points at the current turn. */
  context: ToolContext;
  model: string | undefined;
}

/** What a turn needs its terminal to be. */
export interface TerminalWant {
  providerId: ProviderId;
  model: string | undefined;
  effort: EffortLevel | undefined;
  permission: PermissionLevel;
}

/** A turn a person typed straight into the terminal. */
export type TypedTurn = Parameters<ProviderTerminalHandlers['onTurn']>[0];

/** What the terminals need from the runtime around them. */
export interface TerminalHost {
  readonly config: RookeryConfig;
  readonly store: Store;
  readonly log: Logger;
  readonly providers: ProviderRegistry;
  readonly org: OrgController;
  readonly skills: SkillStore;
  readonly cron: CronScheduler;
  readonly questions: QuestionRegistry;
  /** After every answer typed into a terminal by a person, with the model the terminal was opened with. */
  onTypedTurn(sessionId: string, turn: TypedTurn, openedWith: string | undefined): void;
  /** A terminal opened or went away; the conversation's state moved. */
  onChanged(sessionId: string): void;
}

/** A Claude provider that is known to have a terminal of its own. */
type TerminalProvider = Provider & Required<Pick<Provider, 'openTerminal'>>;

/** A model-gateway entry for the TUI's `/model` menu. */
interface PickerEntry {
  model: string;
  label: string;
  description?: string;
}

/** The directly reachable profiles and their models. */
interface DirectProfile {
  profile: ProviderProfile;
  models: string[];
}

/** Where the process points its API traffic, and the models its `/model` menu offers. */
interface GatewayAccess extends LoopbackEndpoint {
  picker: PickerEntry[];
}

/** Everything settled before a terminal is started. */
interface TerminalPlan {
  session: Session;
  want: TerminalWant;
  /** The model the process starts with, in the spelling its provider uses. */
  model: string | undefined;
  project: Project | undefined;
  extra: { specs: McpServerSpec[]; hints: string[] };
  servers: string[];
  signature: string;
  gateway: GatewayAccess;
}

/** Whether a running terminal already runs the model a turn asks for, under any of its names. */
function runsModel(entry: ChatTerminal, model: string | undefined, askedFor: string | undefined): boolean {
  return !model || entry.models.has(model) || (askedFor !== undefined && entry.models.has(askedFor));
}

/** Waits until the registry has let go of a closed terminal, or gives up after a while. */
async function waitUntilGone(key: string): Promise<void> {
  for (let waited = 0; waited < TERMINAL_EXIT_WAIT_MS && tuiSessions.info(key); waited += TERMINAL_EXIT_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, TERMINAL_EXIT_POLL_MS));
  }
}

/**
 * The conversations' Claude Code terminals (T1): at most one per
 * conversation, started as a turn needs it, restarted when what it was
 * started with no longer fits, and released when it exits.
 */
export class ConversationTerminals {
  readonly #host: TerminalHost;
  readonly #open = new Map<string, ChatTerminal>();
  /** The model gateway conversation terminals share, started with the first one. */
  #gateway: ModelGateway | undefined;
  /** The directly reachable profiles and their models, refreshed with every terminal. */
  #gatewayProfiles: DirectProfile[] = [];

  constructor(host: TerminalHost) {
    this.#host = host;
  }

  /** The terminal this conversation has, alive or not. */
  running(sessionId: string): ChatTerminal | undefined {
    return this.#open.get(sessionId);
  }

  /**
   * Whether this turn is typed into the conversation's terminal (T1, T5):
   * switched on, an ordinary conversation, not a spoken turn or the watcher,
   * a provider the model gateway can reach, and a pty on this machine.
   */
  async canTakeTurn(session: Session, input: Pick<ChatInput, 'voice' | 'watching'>, providerId: ProviderId): Promise<boolean> {
    const { config, providers } = this.#host;
    if (!config.turns.terminal) return false;
    if (session.kind !== 'chat' || input.voice || input.watching) return false;
    if (!providers.has('claude') || !providers.get('claude').openTerminal) return false;
    if (providerId !== 'claude' && providerId !== 'codex') {
      const profile = providers.profiles().find((entry) => entry.id === providerId);
      if (profile?.via !== 'direct') return false;
    }
    return (await loadPty()) !== null;
  }

  /** Which provider a model name belongs to, as the gateway routes it. */
  gatewayOwner(model: string | undefined, fallback: ProviderId): ProviderId {
    if (!this.#gateway || !model) return fallback;
    const route = this.#gateway.route(model);
    return route.kind === 'codex' ? 'codex' : route.kind === 'profile' ? route.profile.id : 'claude';
  }

  /**
   * The conversation's terminal, started as this turn needs it. A terminal
   * already running with the same model, effort, rights, project and tool
   * servers is reused; any difference ends it and starts it again on the same
   * Claude Code session (T3) - the context is in the transcript, not in the
   * process, so nothing of the conversation is lost.
   *
   * What a headless turn rebuilds every time is built once here: the system
   * prompt, the tool servers. What changes per message - the recall, the
   * company's current state - goes in through the prompt hook instead.
   */
  async ensure(session: Session, want: TerminalWant): Promise<ChatTerminal> {
    const provider = this.#claudeProvider();
    const gateway = await this.#startGateway();

    // A name another provider owns (the chat's `sonnet` on a GPT turn)
    // becomes that provider's own default instead of silently going to Claude.
    const model =
      want.model && this.gatewayOwner(want.model, 'claude') === want.providerId
        ? want.model
        : remapModel(want.providerId, want.model);
    const project = session.projectId ? (this.#host.store.org.getProject(session.projectId) ?? undefined) : undefined;
    const extra = toolServersFor(this.#host.config, ASSISTANT_AUDIENCE, want.providerId, project?.id);
    const servers = extra.specs.map((spec) => spec.name).sort();
    const signature = JSON.stringify([want.effort ?? '', want.permission, project?.id ?? '', servers]);

    const open = this.#open.get(session.id);
    if (open && open.handle.alive() && open.signature === signature && runsModel(open, model, want.model)) return open;
    // Whatever a person is doing in it right now finishes first; a restart
    // must not cut off a turn somebody typed into the terminal view.
    if (open?.handle.alive()) await open.handle.whenIdle();
    await this.close(session.id);

    return this.#launch({ session, want, model, project, extra, servers, signature, gateway }, provider);
  }

  /** Ends a conversation's terminal and waits until its process is gone. */
  async close(sessionId: string): Promise<void> {
    const open = this.#open.get(sessionId);
    if (!open) return;
    this.#open.delete(sessionId);
    open.handle.close();
    await waitUntilGone(conversationTerminalKey(sessionId));
  }

  /** Ends the conversation's terminal now. False when it had none. */
  closeNow(sessionId: string): boolean {
    const key = conversationTerminalKey(sessionId);
    const had = this.#open.has(sessionId) || tuiSessions.info(key) !== null;
    void this.close(sessionId);
    tuiSessions.kill(key);
    return had;
  }

  /** The runtime is closing: no terminal and no gateway outlives it. */
  shutdown(): void {
    for (const terminal of [...this.#open.values()]) terminal.handle.close();
    this.#open.clear();
    void this.#gateway?.close().catch((error: unknown) => {
      this.#host.log.warn('Could not close the model gateway', { error: String(error) });
    });
  }

  #claudeProvider(): TerminalProvider {
    const provider = this.#host.providers.get('claude');
    if (!provider.openTerminal) throw new Error(provider.displayName + ' has no terminal of its own.');
    return provider as TerminalProvider;
  }

  /**
   * Starts the gateway on first use and refreshes what it can route to: every
   * model Rookery can reach, for the gateway's routing and the TUI's `/model`
   * menu - Claude's own entries are already in that menu.
   */
  async #startGateway(): Promise<GatewayAccess> {
    const { providers } = this.#host;
    const picker: PickerEntry[] = [];
    const direct: DirectProfile[] = [];
    for (const status of await providers.statuses()) {
      if (status.id === 'claude' || !status.available || !status.authenticated) continue;
      const profile = providers.profiles().find((entry) => entry.id === status.id);
      // The gateway speaks to ChatGPT and to Anthropic-compatible endpoints;
      // a router-backed profile stays reachable from headless turns only.
      if (status.id !== 'codex' && profile?.via !== 'direct') continue;
      const models = await providers.models(status.id).catch(() => []);
      if (profile) direct.push({ profile, models: models.map((entry) => entry.id) });
      for (const entry of models) {
        picker.push({ model: entry.id, label: entry.name || entry.id, description: status.displayName });
      }
    }
    this.#gatewayProfiles = direct;
    this.#gateway ??= new ModelGateway({ profiles: () => this.#gatewayProfiles });
    return { ...(await this.#gateway.start()), picker };
  }

  /** The system prompt the process starts with: the persona, the company, the shelf - not the per-message recall. */
  #systemPrompt(plan: TerminalPlan, current: Session, orgId: string): string {
    const { config, store, skills } = this.#host;
    const resumed = Boolean(current.providerSessionId);
    return buildSystemPrompt({
      config,
      query: '',
      memories: [],
      history: resumed ? [] : store.getMessages(plan.session.id, config.memory.workingWindow),
      resumed,
      voice: false,
      orgBlock: companyBlock(this.#host, orgId, plan.project),
      toolHints: toolHintsFor(config, plan.extra.hints, plan.project?.id),
      skillsIndex: [renderSkillsIndex(skills.for(ASSISTANT_AUDIENCE)), renderExternalSkillsHint(config, ASSISTANT_AUDIENCE)]
        .filter(Boolean)
        .join('\n\n'),
      store,
    });
  }

  /**
   * Opens the process and registers it. The bridge token lives as long as the
   * terminal: the MCP bridge answers the assistant's own tools for exactly
   * that long, and `emit` is pointed at whichever turn is typing into it.
   */
  async #launch(plan: TerminalPlan, provider: TerminalProvider): Promise<ChatTerminal> {
    const { session, want, model, extra, servers, signature, gateway } = plan;
    const { config, store, org, questions } = this.#host;

    // Read again: a restart must resume the session the last process wrote.
    const current = store.getSession(session.id) ?? session;
    const organization = org.activeOrganization();
    const systemPrompt = this.#systemPrompt(plan, current, organization.id);

    const context: ToolContext = {
      orgId: organization.id,
      audience: ASSISTANT_AUDIENCE,
      agentId: undefined,
      sessionId: session.id,
      projectId: session.projectId,
      depth: -1,
      scheduled: false,
      watching: false,
      emit: () => undefined,
      signal: undefined,
    };
    const token = org.register(context);
    const release = (): void => {
      org.unregister(token);
      questions.cancelForOwner(token);
    };

    let entry: ChatTerminal | undefined;
    try {
      const mcp = await org.bridge.spec(token);
      const opened = await provider.openTerminal(
        {
          prompt: '',
          systemPrompt,
          systemPromptMode: 'replace',
          ...(current.providerSessionId ? { providerSessionId: current.providerSessionId } : {}),
          ...(model ? { model } : {}),
          ...(want.effort ? { effort: want.effort } : {}),
          cwd: config.workspace,
          permission: want.permission,
          mcp,
          ...(extra.specs.length ? { mcpExtra: extra.specs } : {}),
          ...externalTurnExtras(config, ASSISTANT_AUDIENCE),
          gateway,
          tui: { key: conversationTerminalKey(session.id) },
        },
        {
          // Something a person typed into the terminal itself. What Rookery
          // types comes back to the turn that typed it and is stored there.
          onTurn: (typed) => {
            // A model picked with `/model` in the terminal is this terminal's
            // model from now on; the chat asking for it must not restart it.
            if (entry && typed.model) entry.models.add(typed.model);
            this.#host.onTypedTurn(session.id, typed, model);
          },
          onExit: () => {
            release();
            if (entry && this.#open.get(session.id) === entry) this.#open.delete(session.id);
            this.#host.onChanged(session.id);
          },
        },
      );
      const models = new Set<string>([model, want.model].filter((name): name is string => Boolean(name)));
      entry = { handle: opened.terminal, signature, models, servers, context, model };
      this.#open.set(session.id, entry);
      // Stored at once, so the next message - or a headless turn - resumes
      // this very session even if nothing was said in the terminal yet.
      store.updateSession(session.id, {
        provider: want.providerId,
        ...(model ? { model } : {}),
        providerSessionId: opened.providerSessionId,
      });
    } catch (error) {
      release();
      throw error;
    }
    this.#host.onChanged(session.id);
    return entry;
  }
}
