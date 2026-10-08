import type {
  AgentEvent,
  EffortLevel,
  MemoryRecord,
  PermissionLevel,
  ProviderId,
  RookeryConfig,
} from '../types.js';
import type { Logger } from '../logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Store } from '../memory/store.js';

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
   * Who is speaking. `system` is Rookery itself - a report-back from work
   * handed off earlier (R3). It is stored as a system message rather than as
   * something the user said, never titles the conversation and never feeds
   * the memory: only the user's own words may stand behind a memory.
   */
  origin?: 'user' | 'system';
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

/**
 * A report-back turn has ended (R3). The web sees the turn itself through
 * the hub; this is for channels that only hear about turns they started -
 * Telegram sends `text` to the chat the conversation belongs to.
 */
export interface FollowUpEvent {
  sessionId: string;
  taskId?: string;
  text: string;
  error?: string;
}

/**
 * Whoever hosts the runtime and can show a turn to people - the server,
 * through its turn hub - takes over a turn nobody typed: a report-back. Left
 * unset, the runtime drains it itself and the result still lands in the
 * conversation.
 */
export type TurnRunner = (turn: {
  turnId: string;
  sessionId: string;
  controller: AbortController;
  events: AsyncGenerator<AgentEvent, void, unknown>;
}) => void;
