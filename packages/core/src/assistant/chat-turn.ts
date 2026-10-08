import { deriveTitle } from '../agents/persona.js';
import { resolvePolicy } from '../memory/dream/policy.js';
import { providerBlocked, providerLow } from '../providers/quota.js';
import type { AgentEvent, ProviderId, RookeryConfig, ScoredMemory, Session } from '../types.js';
import { ASSISTANT_MEMORY_OWNER } from '../types.js';
import { HeadlessTurn } from './headless-turn.js';
import type { TurnJournalState } from './journalled-turn.js';
import { DEFAULT_SESSION_TITLE, pinProject, resolveSession, sessionPermissionKey } from './sessions.js';
import { TerminalTurn } from './terminal-turn.js';
import { skillsIndexFor, ASSISTANT_AUDIENCE, type TurnPlan, type TurnServices } from './turn-support.js';
import type { RecallEvent } from './turn-transcript.js';
import type { ChatInput } from './types.js';

/** What a turn brought back from the bank before the provider is asked anything. */
interface Recalled {
  memories: ScoredMemory[];
  /**
   * The recall as it went out on the wire, kept so the ordered transcript
   * can carry it too: the recall happens before the first provider attempt,
   * and the transcript is only born once one is about to start.
   */
  recall: RecallEvent | undefined;
}

/**
 * What to say when a turn starts on a provider it did not ask for. Quota
 * reasons first - they are the ones the user cannot see anywhere else - and
 * a missing login last, which the provider list already shows.
 */
function switchReason(config: RookeryConfig, wanted: ProviderId, chosen: ProviderId): string {
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
  if (config.providerFallback.enabled && providerLow(wanted, config.providerFallback.thresholdPercent)) {
    return wanted + ' is nearly out of quota, using ' + chosen + ' for now';
  }
  return wanted + ' is not logged in, using ' + chosen;
}

/**
 * One conversational turn: resolve the session, settle the provider, recall
 * memories, store what was said, then hand over to whoever answers - the
 * conversation's terminal, or a headless provider process.
 *
 * `journal` is told as soon as the session is resolved, which is when the
 * turn becomes journalled; events yielded before that are ephemeral.
 */
export async function* chatTurn(
  services: TurnServices,
  input: ChatInput,
  turnId: string,
  journal: TurnJournalState,
): AsyncGenerator<AgentEvent, void, unknown> {
  const prompt = input.text.trim();
  if (!prompt) {
    yield { type: 'error', message: 'Nothing to send.', fatal: true };
    return;
  }

  const session = openTurn(services, input, turnId, journal);
  const wantedProvider = input.provider ?? session.provider;
  const providerId = yield* selectProvider(services, wantedProvider);
  if (!providerId) return;

  const { memories, recall } = yield* recallForTurn(services, session, prompt, turnId);
  const plan = planTurn(services, { turnId, input, session, prompt, wantedProvider, providerId, memories, recall });
  storeUserMessage(services, plan);

  // Chat and terminal are one process (T1): an ordinary conversation is
  // answered by typing into its Claude Code terminal. Everything above -
  // the recall, the stored message - is shared; what follows differs.
  if (await services.terminals.canTakeTurn(session, input, providerId)) {
    yield* new TerminalTurn(services, plan).run();
    return;
  }
  // Answered headless this time - a voice turn, say. The terminal must not
  // go on writing to the same transcript in parallel.
  await services.terminals.close(session.id);
  yield* new HeadlessTurn(services, plan).run();
}

/** Resolves the conversation, opens the journal on it and pins the project the caller names. */
function openTurn(
  services: TurnServices,
  input: ChatInput,
  turnId: string,
  journal: TurnJournalState,
): Session {
  const { store } = services;
  const session = resolveSession(services, input);
  store.turns.begin(turnId, session.id, 'chat', Date.now());
  journal.begun = true;
  journal.sessionId = session.id;
  pinProject(store, session, input.projectId);
  return session;
}

/**
 * The provider this turn runs on: the one asked for, or the one that is
 * usable instead. Says so when it moved, and fails the turn when none is.
 */
async function* selectProvider(
  services: TurnServices,
  wanted: ProviderId,
): AsyncGenerator<AgentEvent, ProviderId | undefined, unknown> {
  const { config, providers } = services;
  const providerId = await providers.resolveUsable(wanted);
  if (!providerId) {
    const statuses = await providers.statuses();
    // A provider parked for quota says so here rather than hiding behind
    // its login state: "out of quota" tells the user what to wait for.
    const detail = statuses
      .map((s) => s.id + ': ' + (providerBlocked(s.id) ? 'out of quota' : (s.detail ?? 'unavailable')))
      .join(' | ');
    yield { type: 'error', message: 'No AI provider is ready. ' + detail, fatal: true };
    return undefined;
  }
  if (providerId !== wanted) {
    yield { type: 'status', label: 'provider', detail: switchReason(config, wanted, providerId) };
  }
  return providerId;
}

/** Searches the memory bank for what this prompt calls to mind; chat is the assistant's own conversation. */
function* recallForTurn(
  services: TurnServices,
  session: Session,
  prompt: string,
  turnId: string,
): Generator<AgentEvent, Recalled, unknown> {
  const { store, config, recorder } = services;
  if (!config.memory.enabled) return { memories: [], recall: undefined };
  yield { type: 'status', label: 'recalling', detail: 'searching memory' };
  // One truth about the recall parameters (concept 9.3): the resolver
  // clamps at read time and both the turn and the recorder read it here,
  // so a config change cannot leave the record and the live turn
  // disagreeing about which policy produced the prompt.
  const policy = resolvePolicy(store, config, ASSISTANT_MEMORY_OWNER, 'recall');
  const memories = recorder.turnMemories(session, ASSISTANT_MEMORY_OWNER, prompt, policy, turnId);
  if (!memories.length) return { memories, recall: undefined };
  // The turn id travels with the list the surface is about to render:
  // a click on one of these rows becomes a label about THIS turn, not
  // about the session it happened in (S6, concept 4.2b).
  const recall: RecallEvent = { type: 'memory', action: 'recalled', count: memories.length, items: memories, turnId };
  yield recall;
  return { memories, recall };
}

/** Everything the turn needs to know about the conversation, the company and the shelf, read once. */
function planTurn(
  services: TurnServices,
  settled: Pick<
    TurnPlan,
    'turnId' | 'input' | 'session' | 'prompt' | 'wantedProvider' | 'providerId' | 'memories' | 'recall'
  >,
): TurnPlan {
  const { config, store, org, skills } = services;
  const { input, session, prompt, providerId } = settled;
  const organization = org.activeOrganization();
  const ownSkills = skills.for(ASSISTANT_AUDIENCE);
  return {
    ...settled,
    model: input.model ?? session.model ?? config.defaultModel,
    effort: input.effort ?? config.defaultEffort,
    // Resuming the provider's own thread only works on the same provider.
    resumed: Boolean(session.providerSessionId) && session.provider === providerId,
    // Read before the turn stores its own user message: a retry that cannot
    // resume the dead provider's thread rebuilds its prompt from this.
    history: store.getMessages(session.id, config.memory.workingWindow),
    project: session.projectId ? (store.org.getProject(session.projectId) ?? undefined) : undefined,
    organizationId: organization.id,
    snapshot: org.snapshot(organization.id),
    ownSkills,
    // Rookery's own shelf in full, one paragraph for the one installed in
    // Claude Code, and the few that look like this turn - searched here
    // rather than left to a tool call the model has to think of, the same
    // way its memories arrive.
    skillsIndex: skillsIndexFor(config, ownSkills, prompt),
  };
}

/**
 * Stores what was said. The journal's id goes on the message (concept 9.4):
 * it is what makes a quote from this prompt locatable to this exact turn
 * later, instead of to a position counted off the transcript.
 */
function storeUserMessage(services: TurnServices, plan: TurnPlan): void {
  const { store } = services;
  const { session, input, prompt, turnId } = plan;
  const fromSystem = input.origin === 'system';
  // The rights this conversation was last used with, so a turn nobody
  // typed - a report-back - runs with them rather than with the default.
  if (!fromSystem && input.permission) store.setMeta(sessionPermissionKey(session.id), input.permission);
  store.addMessage({ sessionId: session.id, role: fromSystem ? 'system' : 'user', content: prompt, turnId });
  if (!fromSystem && session.messageCount === 0 && session.title === DEFAULT_SESSION_TITLE) {
    store.updateSession(session.id, { title: deriveTitle(prompt) });
  }
}
