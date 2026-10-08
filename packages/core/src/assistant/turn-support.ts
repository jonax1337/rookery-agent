import type { CronScheduler } from '../cron/scheduler.js';
import type { Logger } from '../logger.js';
import type { Store } from '../memory/store.js';
import type { OrgController } from '../org/controller.js';
import { assistantOrgBlock, type OrgSnapshot } from '../org/prompts.js';
import type { QuestionRegistry } from '../org/questions.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { renderExternalSkillsHint } from '../skills/shelf.js';
import { renderSkillsIndex, type Skill, type SkillStore } from '../skills/store.js';
import { matchSkills, renderSkillMatches } from '../skills/suggest.js';
import { dormantToolsHint } from '../tools/hub.js';
import type {
  AgentEvent,
  EffortLevel,
  Message,
  Project,
  ProviderId,
  RookeryConfig,
  ScoredMemory,
  Session,
} from '../types.js';
import type { DreamRecorder } from './dream-recorder.js';
import type { ConversationTerminals } from './terminals.js';
import type { ToolEvent, RecallEvent } from './turn-transcript.js';
import type { ChatInput } from './types.js';

/** The audience the assistant's own turns ask the hub, the skill shelf and the bridge about. */
export const ASSISTANT_AUDIENCE = 'assistant';

/**
 * How many provider processes one turn may use. Two, because a turn that
 * attaches a tool server needs a second process to actually get it, and
 * because a third would let the assistant loop over its own switches.
 */
export const MAX_PROVIDER_PASSES = 2;

/**
 * How many providers one turn may run on. The second only happens when the
 * first died on its usage limit with nothing to show for it, so a switch
 * costs one provider session, never the thread the turn was holding.
 */
export const MAX_PROVIDER_ATTEMPTS = 2;

/**
 * A promise nobody is going to await - its consumer walked away, or it is
 * fire-and-forget - must not fail unseen: a rejection with no handler is an
 * unhandled one. This is the handler, and it says what failed.
 */
export function reportIfRejected(pending: Promise<unknown>, log: Logger, what: string): void {
  void pending.catch((error: unknown) => {
    log.warn(what + ' failed', { error: String(error) });
  });
}

/**
 * What the second pass is asked. It is not the user talking, and it says so:
 * the assistant should pick the work back up, not answer this sentence.
 */
export function continuePrompt(servers: string[]): string {
  return [
    '[Rookery] The tool servers you just switched on are attached now: ' + servers.join(', ') + '.',
    'This message is from the system, not from your user, so do not address it and do not greet.',
    'Carry on with what you stopped for, using the new tools, and finish the answer without',
    'repeating what you already said.',
  ].join(' ');
}

/** The tool servers the hub offers now that are not attached to the running process yet. */
export function freshServerNames(servers: { name: string }[], attached: Iterable<string>): string[] {
  const known = new Set(attached);
  return servers.map((spec) => spec.name).filter((name) => !known.has(name));
}

/** The status line that says a continuation pass is starting with new tools. */
export function toolsAttachedStatus(fresh: string[]): AgentEvent {
  return { type: 'status', label: 'tools', detail: fresh.join(', ') + ' attached, carrying on' };
}

/**
 * One paragraph per attached server, plus what the assistant could attach but
 * has not: a switch it does not know about is a wall it cannot climb.
 */
export function toolHintsFor(config: RookeryConfig, hints: string[], projectId: string | undefined): string[] {
  return [...hints, dormantToolsHint(config, ASSISTANT_AUDIENCE, projectId)].filter(Boolean);
}

/** The few skills that look like this message, searched here rather than left to a tool call. */
export function skillMatchesFor(config: RookeryConfig, ownSkills: Skill[], prompt: string): string {
  return renderSkillMatches(matchSkills(config, ASSISTANT_AUDIENCE, ownSkills, prompt));
}

/**
 * Rookery's own shelf in full, and one paragraph for the far larger one
 * installed in Claude Code: what is there, not what it says. With a `prompt`,
 * the few skills that look like it are added.
 */
export function skillsIndexFor(config: RookeryConfig, ownSkills: Skill[], prompt?: string): string {
  return [
    renderSkillsIndex(ownSkills),
    renderExternalSkillsHint(config, ASSISTANT_AUDIENCE),
    prompt === undefined ? '' : skillMatchesFor(config, ownSkills, prompt),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The company block: who works here and what is running. */
export function companyBlock(
  context: Pick<TurnServices, 'config' | 'store' | 'cron' | 'org'>,
  orgId: string,
  project: Project | undefined,
  snapshot: OrgSnapshot = context.org.snapshot(orgId),
): string {
  return assistantOrgBlock(context.config, snapshot, project, context.cron.list(orgId), context.store);
}

/**
 * Everything a turn needs from the runtime that owns it. The `Assistant`
 * builds one of these; the turn steps depend on it rather than on the class.
 */
export interface TurnServices {
  readonly config: RookeryConfig;
  readonly store: Store;
  readonly log: Logger;
  readonly providers: ProviderRegistry;
  readonly org: OrgController;
  readonly skills: SkillStore;
  readonly cron: CronScheduler;
  readonly questions: QuestionRegistry;
  readonly terminals: ConversationTerminals;
  readonly recorder: DreamRecorder;
  /**
   * A tool call on the assistant's own emitter, not just the turn's stream: a
   * channel that is not the one that started the turn - the phone, watching a
   * schedule run - has no other way to see what is being done.
   */
  announceTool(event: ToolEvent): void;
  /** A conversation's stored state moved; every client may want to look again. */
  announceChanged(sessionId: string): void;
  /** Hand a finished exchange to memory extraction; a no-op when learning is off. */
  learn(sessionId: string, userText: string, assistantText: string, providerId: ProviderId): void;
}

/** Everything one conversational turn has settled before a provider is asked anything. */
export interface TurnPlan {
  turnId: string;
  input: ChatInput;
  session: Session;
  prompt: string;
  /** What the turn asked for, before a quota or a missing login moved it elsewhere. */
  wantedProvider: ProviderId;
  providerId: ProviderId;
  model: string | undefined;
  effort: EffortLevel | undefined;
  /** The provider's own thread is picked up again instead of rebuilt from history. */
  resumed: boolean;
  memories: ScoredMemory[];
  recall: RecallEvent | undefined;
  /** The stored conversation as it stood before this turn wrote its own message. */
  history: Message[];
  project: Project | undefined;
  organizationId: string;
  snapshot: OrgSnapshot;
  ownSkills: Skill[];
  skillsIndex: string;
}
