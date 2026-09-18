/**
 * Rookery Core - shared contracts.
 *
 * Everything in Rookery speaks these types: the CLI, the HTTP/WS server,
 * the web UI and the provider adapters. Changing something here is a
 * cross-package change.
 */

/**
 * Which provider backs a turn. Every turn runs on the `claude` binary; the
 * id only says what it is pointed at. `'claude'` is the local Claude Code
 * login and `'codex'` the ChatGPT subscription served through Rookery's own
 * bridge - both authenticated by a login session, never an API key. Any
 * other id names a configured `ProviderProfile` with its own backend and key.
 */
export type ProviderId = string;

export type Role = 'user' | 'assistant' | 'system';

/** A persisted conversation turn. */
export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  /** Provider tool events retained with the answer, including interrupted calls. */
  toolCalls?: Extract<AgentEvent, { type: 'tool' }>[];
  provider?: ProviderId;
  model?: string;
  /** Provenance only, never identity. Unset for an ordinary turn. */
  agent?: string;
  createdAt: number;
  /**
   * The journal's turn id (`runtime.ts:645`), carried onto the message so a
   * dream label can target this exact turn instead of guessing at it from
   * session position (concept 9.4, "one turn id instead of three").
   */
  turnId?: string;
  /** Token/cost accounting, when the provider reported it. */
  usage?: TurnUsage;
  /**
   * The turn as it actually happened: text, thinking and tool calls in the
   * order they arrived. `content` and `toolCalls` stay the flat compatibility
   * view (and the fallback for rows written before this existed); `blocks` is
   * the ordered transcript, built by `TurnBlocks` during the turn.
   */
  blocks?: MessageBlock[];
}

/**
 * One memory as an answer keeps it: the id a feedback click posts against
 * and the sentence its row shows. Deliberately not the whole `MemoryRecord` -
 * this is stored on every answer that recalled anything.
 */
export interface RecalledMemory {
  id: string;
  content: string;
}

/**
 * One segment of a turn, in arrival order: assistant text, model reasoning,
 * a tool call, or the memories the turn was given before it answered. A tool
 * block carries its whole event - the start event as it arrived, with
 * `status: 'end'` and the (clipped) result merged in once the matching end
 * event shows up. A memory block carries the journal's turn id, because a
 * verdict on one of its rows is a claim about this turn (concept 4.2b, S6).
 */
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; call: Extract<AgentEvent, { type: 'tool' }> }
  | { type: 'memory'; memories: RecalledMemory[]; turnId?: string };

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /**
   * Tokens the provider's context held on the turn's last request: prompt,
   * history, system prompt and tool definitions together. What a context
   * gauge shows.
   */
  contextTokens?: number;
  /** Size of the model's context window, when the provider reports it. */
  contextWindow?: number;
}

/** One rolling limit window of a subscription, as the vendor reports it. */
export interface QuotaWindow {
  /** Stable key, e.g. `five_hour`, `seven_day`, `weekly`. */
  kind: string;
  /** Human label, e.g. "5 hours". */
  label: string;
  /** 0..100, how much of the window is used up. */
  percent: number;
  /** ISO timestamp of the reset, when known. */
  resetsAt?: string;
}

/**
 * Subscription usage of one provider: the same numbers the CLIs show in
 * their own `/usage` panels, read with the login they store on disk.
 */
export interface ProviderQuota {
  provider: ProviderId;
  /** Plan name as the vendor reports it, e.g. "Max 5×", "Pro Lite". */
  plan?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  /** Why there are no windows: not logged in, endpoint down, rate limited. */
  error?: string;
}

/**
 * What a conversation is for. A `voice` session belongs to the hands-free
 * screen: the assistant answers in its spoken register there, whichever
 * surface a turn comes from, and the web UI files it apart from the chats.
 *
 * `mail` is not a conversation anyone holds. Answering a mail addressed to
 * the assistant needs a session to run the turn in, and that session used to
 * be indistinguishable from a chat - so every answered mail left a "Mail:
 * <subject>" thread in the conversations list that nobody had opened and
 * nobody could continue. Marking it as its own kind keeps the transcript
 * without pretending it is something to come back to: `listSessions` leaves
 * these out unless a caller asks for them by name.
 *
 * `schedule` is the same idea for a cron run: each firing gets its own fresh
 * session to think in, nobody is there to hold that conversation, and the
 * outcome is what gets read later (from the inbox and from the schedule's
 * own run history), not the transcript sitting in the chat list.
 */
export type SessionKind = 'chat' | 'voice' | 'mail' | 'schedule';

export interface Session {
  id: string;
  title: string;
  kind: SessionKind;
  provider: ProviderId;
  model?: string;
  /**
   * Working directory the assistant's own provider CLI is spawned in. This is
   * the Rookery workspace, never the directory Rookery was started from.
   */
  cwd: string;
  /** Project the conversation is about; assignments default to it. */
  projectId?: string;
  /**
   * The agent the user is talking to in this conversation. Unset for the
   * assistant. A direct chat with an agent runs in that agent's voice, with
   * its memory and its provider, like a direct message in a company chat.
   */
  agentId?: string;
  /** Native session id held by the provider CLI, used to resume its own context. */
  providerSessionId?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
}

/* ------------------------------------------------------------------ *
 * Streaming events
 * ------------------------------------------------------------------ */

/**
 * One offered answer to a question the assistant asked. Two to four of these
 * ride a `question` event; a surface renders them as buttons, radio rows or
 * a numbered list, whatever fits it.
 */
export interface QuestionOption {
  /** What the button says. Short - it has to fit a phone keyboard row. */
  label: string;
  /** One line under the label, when the label alone is not enough. */
  description?: string;
}

/**
 * What came back. `selected` holds indices into the question's `options`, in
 * the order they were offered; `text` carries a free answer, either from the
 * "Other" field or from a plain chat reply on a channel that has no buttons.
 * At least one of the two is always set.
 */
export interface QuestionAnswer {
  selected: number[];
  text?: string;
  /** Which surface answered, for the log. Unset when nobody recorded it. */
  source?: 'web' | 'tui' | 'telegram' | 'api';
  /** Epoch ms the answer arrived. */
  at?: number;
}

/**
 * The single event vocabulary Rookery streams to any frontend.
 * Provider adapters normalise their native JSON into exactly these.
 */
export type AgentEvent =
  | {
      type: 'session';
      sessionId: string;
      providerSessionId?: string;
      provider: ProviderId;
      model?: string;
    }
  /** Incremental assistant text. Concatenating every delta yields the reply. */
  | { type: 'text'; delta: string }
  /** Model reasoning trace, when the provider exposes it. */
  | { type: 'thinking'; delta: string }
  /**
   * The provider started or finished running one of its own tools.
   * `argsHash`/`input` are the recorder fidelity Phase 6 needs (concept
   * S28): a sha256 over the canonical JSON of the call's arguments, and the
   * canonical JSON itself up to a size limit, both set on the start event.
   * `detail` is unchanged - the surface still renders off it.
   */
  | {
      type: 'tool';
      name: string;
      status: 'start' | 'end';
      detail?: string;
      id?: string;
      result?: string;
      isError?: boolean;
      argsHash?: string;
      input?: string;
    }
  /** Rookery-level progress: memory recall, delegation, lifecycle. */
  | { type: 'status'; label: string; detail?: string }
  /**
   * A memory record was written or recalled. A `recalled` event carries the
   * journal's turn id (S6): it is what lets the chat highlight write a label
   * about THIS turn instead of about the session it happened in.
   */
  | { type: 'memory'; action: 'recalled' | 'stored'; count: number; items?: MemoryRecord[]; turnId?: string }
  /**
   * An assignment changed state. Sent when an agent is handed a task, while
   * it produces output, and once when it finishes or fails. Assignments a
   * turn started through the `assign` tool ride the turn's own stream.
   */
  | { type: 'assignment'; assignment: AssignmentView }
  /** A message between agents, their manager or the assistant was posted. */
  | { type: 'message'; message: AgentMessage }
  /** Mail was sent: the user, the assistant, or an agent, to To + Cc. */
  | { type: 'mail'; mail: Mail }
  /** A task on the board was created or changed state. */
  | { type: 'task'; task: Task }
  /** A schedule was created, edited, deleted, or one of its runs changed state. */
  | { type: 'cron'; job: CronJob; run?: CronRun; deleted?: boolean }
  /** The memory bank started, advanced through or finished a night's clean-up. */
  | { type: 'sleep'; run: SleepRun; phase?: string; cycle?: number }
  /** The provider reported the account's limit windows during the turn. */
  | { type: 'quota'; quota: ProviderQuota }
  /**
   * The assistant asked the person something and the turn is waiting on the
   * answer. Broadcast rather than confined to the turn that asked: whoever
   * is at a screen may answer, including a channel that did not start it.
   */
  | {
      type: 'question';
      /** Global, not scoped to a turn: any connection may answer this id. */
      id: string;
      /** Two or three words over the card, e.g. "Deploy target". */
      header: string;
      question: string;
      options: QuestionOption[];
      /** More than one option may be picked. */
      multiSelect: boolean;
      /** Epoch ms after which the question gives up and the turn moves on. */
      expiresAt: number;
    }
  /**
   * The question is over. Needed so a surface that is showing the card takes
   * it away again when the answer came from somewhere else - or when nobody
   * answered at all.
   */
  | { type: 'question-closed'; id: string; reason: 'answered' | 'cancelled' | 'expired'; answer?: QuestionAnswer }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; text: string; usage?: TurnUsage; providerSessionId?: string };

/**
 * One line of a running assignment's live log: the event as it arrived,
 * with a sequence number that stays monotone over the whole run - including
 * the reset a provider switch performs - so clients can order and merge a
 * snapshot against later frames without ever assuming continuity.
 */
export interface AssignmentLogEntry {
  seq: number;
  event: AgentEvent;
}

/** Point-in-time read of a running assignment's live log. */
export interface AssignmentLogSnapshot {
  /** The buffered entries, in arrival order. */
  events: AssignmentLogEntry[];
  /** True once the oldest whole entries were dropped to stay under the cap. */
  overflowed: boolean;
  /** False when no run holds the buffer: unknown or finished id alike. */
  active: boolean;
}

/** One live-log entry on its way to a watcher of the run it belongs to. */
export interface AssignmentLogFrame {
  assignmentId: string;
  entry: AssignmentLogEntry;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

/**
 * Long-term memory kinds.
 * - fact:       stable truth about the user or their world
 * - preference: how the user wants things done
 * - project:    ongoing work, goals, constraints
 * - event:      something that happened, where the timestamp matters
 * - summary:    a compressed digest of an older conversation span
 * - insight:    a conclusion drawn across several memories; written only by
 *               the sleep run, never by a turn, and always backed by evidence
 */
export type MemoryKind = 'fact' | 'preference' | 'project' | 'event' | 'summary' | 'insight';

/** Who wrote a memory. `user` is protected from everything the night does. */
export type MemoryOrigin = 'extract' | 'user' | 'sleep';

/** The assistant's own memory bank. Agents own theirs under their agent id. */
export const ASSISTANT_MEMORY_OWNER = 'assistant';

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** The memory itself, written as one self-contained sentence. */
  content: string;
  /** Free-form tags used for filtering and for boosting recall. */
  tags: string[];
  /** 0..1 - how much this should outrank other candidates. */
  importance: number;
  /** Whose memory this is: `assistant`, or an agent id. */
  owner: string;
  /**
   * The words this memory stands on, quoted from whoever said them: the
   * user's own message for the assistant's bank, the assignment or the report
   * for an agent's. An extracted memory that cannot produce one is not
   * written at all - see `memory/gate.ts`. Absent on the rows the user wrote
   * by hand and on what the night condensed out of memories that each carry
   * their own.
   */
  evidence?: string;
  /** Session this was learned in, when known. */
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
  /** Recall bookkeeping - drives the recency/frequency part of scoring. */
  lastAccessedAt?: number;
  accessCount: number;
  /** Soft delete, so a forgotten memory can still be audited. */
  forgotten: boolean;
  /** Who wrote it. Decides what the sleep run may do with it. */
  origin: MemoryOrigin;
  /** The user pinned this: never dormant, never merged away. */
  pinned: boolean;
  /**
   * Asleep since. A dormant memory is out of recall and out of the core
   * profile, but stays in the table, in search and in the inspector. This is
   * how the night shrinks the bank without ever losing anything.
   */
  dormantAt?: number;
  /** The condensed memory that took this one's place. */
  supersededBy?: string;
  /** The sleep run that wrote this memory, when one did. */
  sleepRunId?: string;
  /**
   * Set when the agent this belonged to was replaced (agent-performance-
   * management, phase 4). Archived memories stay out of recall for good but
   * remain visible, audit-only, on the retired agent's own page.
   */
  archivedAt?: number;
  /**
   * 0..1 - how often this memory actually got recalled. Separate from
   * `importance` on purpose: importance says how much it should matter,
   * usefulness says how much it demonstrably did.
   */
  usefulness: number;
}

export interface MemoryQuery {
  text: string;
  limit?: number;
  kinds?: MemoryKind[];
  minImportance?: number;
  /** Defaults to the assistant's own bank. */
  owner?: string;
}

export interface ScoredMemory extends MemoryRecord {
  score: number;
  /** Why this memory surfaced - shown in the memory inspector. */
  reason: string;
  /** How it was reached: directly, or through an entity or an edge. */
  hop?: MemoryHop;
}

/** Whether a recalled memory matched the question itself or a neighbour of a match. */
export type MemoryHop = 'direct' | 'entity' | 'edge';

/* --------------------------- the memory graph --------------------------- */

/** What an entity is a name for. */
export type EntityKind = 'person' | 'project' | 'tool' | 'place' | 'org' | 'topic';

/**
 * A named thing several memories talk about. Entities are what makes recall
 * work past wording: two sentences about "Rookery" are related even when
 * they share no other word.
 */
export interface MemoryEntity {
  id: string;
  owner: string;
  /** Display name, spelled the way the user spells it. */
  name: string;
  /** Normalised key: lower case, no diacritics. Unique per owner. */
  slug: string;
  kind: EntityKind;
  /** How many live memories mention it. Common entities are damped in recall. */
  mentions: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

/**
 * A directed relation between two memories.
 * - refines:     the target sharpens the source
 * - supersedes:  the source replaces the target, which goes dormant
 * - contradicts: both cannot be true; reported, never decided automatically
 * - caused_by:   the source is the way it is because of the target
 * - co_occurs:   they turn up together; weakest link, used for clustering
 */
export type MemoryRelation = 'refines' | 'supersedes' | 'contradicts' | 'caused_by' | 'co_occurs';

export interface MemoryEdge {
  id: string;
  owner: string;
  srcId: string;
  dstId: string;
  relation: MemoryRelation;
  /** 0..1 confidence. */
  weight: number;
  origin: 'sleep' | 'user' | 'gate';
  /** The sleep run that drew this edge, for undo. */
  runId?: string;
  createdAt: number;
}

/** One memory with everything hanging off it, for the inspector. */
export interface MemoryNeighbourhood {
  memory: MemoryRecord;
  entities: MemoryEntity[];
  /** Edges where this memory is the source, with the memory at the other end. */
  outgoing: (MemoryEdge & { other: MemoryRecord })[];
  incoming: (MemoryEdge & { other: MemoryRecord })[];
}

/** The graph as the web view wants it: nodes for entities and memories, plus links. */
export interface MemoryGraph {
  entities: MemoryEntity[];
  memories: MemoryRecord[];
  edges: MemoryEdge[];
  /** memory id -> entity ids, so the client does not need a second request. */
  links: { memoryId: string; entityId: string }[];
  /** True when the node cap cut the result short. */
  truncated: boolean;
}

/* -------------------------------- sleep -------------------------------- */

export type SleepStatus = 'running' | 'done' | 'failed';

/**
 * The stages of one night, in the order they run.
 *
 * Sleep is not one uniform chore, and modelling it as a flat list of steps
 * was wrong. Light sleep is bookkeeping and costs nothing. Deep sleep is
 * where the filing happens: what says the same thing becomes one sentence,
 * and what cannot both be true gets decided. Dream sleep is the loose,
 * associative part - links across distant subjects, and the conclusions that
 * only surface once the day's noise is gone.
 *
 * A night runs several cycles of the three, because condensing changes what
 * there is to connect: the second pass works on a bank the first one tidied.
 */
/**
 * `replay` runs once, before the cycles: the day's conversations are read
 * again, properly this time. The per-turn extractor sees one exchange at a
 * time through a small model, so anything that only becomes visible across a
 * whole conversation is invisible to it. Reading the transcripts at night
 * catches that - and it comes first so the day's harvest is in the bank
 * before deep sleep starts condensing, rather than waiting a day for it.
 *
 * `dream` is stage 2 (concept 11, Phase 3 on): the model-free grid probe,
 * evaluation and promotion gate. It sits between `replay` and `light` - the
 * probe reads the day's fresh traces before condensation starts folding
 * memories away, and it never runs inside the light/deep/rem cycle itself
 * (concept 5.5a: it must not see a bank `#condense` has already touched).
 */
export type SleepStage = 'replay' | 'dream' | 'light' | 'deep' | 'rem';

/**
 * One night's work on one memory bank. Every write a run makes carries its
 * id, which is what makes a night undoable in a single transaction.
 */
export interface SleepRun {
  id: string;
  owner: string;
  trigger: CronTrigger;
  status: SleepStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** How many live memories the run looked at. */
  readCount: number;
  /** Conversations the night read again in full. */
  replayedCount: number;
  /** Memories those conversations yielded that the day had missed. */
  learnedCount: number;
  /** How many memories were folded into a condensed one. */
  mergedCount: number;
  /** How many were put to sleep. */
  dormantCount: number;
  edgeCount: number;
  insightCount: number;
  /** Skills the night wrote out of what the bank kept repeating. */
  skillCount: number;
  /**
   * Skills the night rewrote because something they stood on changed, or
   * because a run that had them open failed. Counted apart from `skillCount`:
   * repairing a procedure and inventing one are different kinds of work.
   */
  skillRevisedCount: number;
  /** Contradictions found. */
  conflictCount: number;
  /** Contradictions actually decided, the loser filed away. */
  resolvedCount: number;
  /**
   * Dream traces the night's probe looked at. Optional on purpose: the only
   * places that build a complete `SleepRun` are written from AP7 / Schema 21
   * on, and a required field would break the wave-1 typecheck before then.
   */
  dreamTracesSeen?: number;
  /**
   * Dream frames the night's grid probe scored. In stage 1 this carries the
   * grid placements, not candidates. Set from AP7 / Schema 21 on.
   */
  dreamFramesScored?: number;
  /**
   * Model-written dream candidates. Reserved for Phase 3 and 0 until then,
   * so the counter cannot quietly change meaning. Set from AP7 / Schema 21 on.
   */
  dreamCandidates?: number;
  /**
   * Stage 2 counters, same reason these are optional as the three above:
   * only `createSleepRun`, `updateSleepRun`'s whitelist and `mapSleepRun`
   * from AP3/Schema 24 on set them, at the same four places in lockstep
   * (concept 8.8), and a required field would break the wave-1 typecheck
   * before AP3 lands.
   */
  /** Policy versions this run promoted. At most `dream.maxPromotionsPerNight`. */
  dreamPromoted?: number;
  /** Dream labels this run's replay and merge passes wrote (concept 4.2a/c). */
  dreamLabelsWritten?: number;
  /** Small-model calls spent. Capped by config. */
  modelCalls: number;
  /** Two or three sentences a person can read. */
  report?: string;
  error?: string;
  /** Set when the run was rolled back. */
  undoneAt?: number;
}

/* ------------------------------------------------------------------ *
 * Dream
 * ------------------------------------------------------------------ */

/**
 * The dream: recall decisions are recorded and replayed so the night can
 * measure the retrieval policy instead of guessing at it. See
 * docs/concepts/dream-and-recursive-self-improvement.md.
 *
 * Stage 1 records and measures, nothing else: no model call, no candidate
 * writer, no promotion. The types below are the shared vocabulary every
 * later package builds against, so they live here rather than in a `dream/`
 * module that two wave-2 packages would have to serialise on.
 */

/** Where a recall call came from. Stage 1 scores only `turn` (concept 3.5). */
export type DreamSite = 'turn' | 'extract' | 'tool' | 'inspect';

/**
 * Which post-processing chain a frame belongs to. The assistant path groups
 * by entity and drops contradicted memories; the agent path does neither.
 * Scoring one with the other's chain would score a prompt that never
 * existed (concept 3.6).
 */
export type DreamPipeline = 'assistant' | 'agent';

/** What kind of run opened a trace. */
export type DreamTraceKind = 'turn' | 'assignment' | 'night';

/**
 * How a recall call degraded. Three worlds, not two: "rows came, but all
 * fell below the threshold" is a legitimate miss that must be scored, never
 * inferred from an empty result (concept 3.4).
 */
export type DreamDegraded = 'no-tokens' | 'fts-threw';

/**
 * Where a policy value came from: the factory default, the user's config,
 * or a dream promotion.
 */
export type PolicyOrigin = 'default' | 'user' | 'dream';

/** The four recall scoring terms. `scoreFrame` normalises them to sum 1. */
export interface RecallWeights {
  relevance: number;
  importance: number;
  recency: number;
  usage: number;
}

/** Field-by-field provenance of a resolved policy (concept 9.3). */
export interface RecallPolicyOrigin {
  limit: PolicyOrigin;
  threshold: PolicyOrigin;
  hopEntity: PolicyOrigin;
  hopEdge: PolicyOrigin;
  relevance: PolicyOrigin;
  importance: PolicyOrigin;
  recency: PolicyOrigin;
  usage: PolicyOrigin;
}

/**
 * The declared parameter space a frame is closed under.
 *
 * A replay is honest exactly when the recorded surface is closed under this
 * box: every value `scoreFrame` may vary appears here as an interval, so a
 * replay can never need a row that was not fetched. `kinds` and
 * `minImportance` are SQL filters rather than scoring terms - widening them
 * admits rows that were never fetched - so they ride as literals
 * (concept 3.4).
 */
export interface RecallBox {
  /**
   * Upper bound for `limit`. With a trace open, the hop-1 frontier is
   * `max(limit, limitMax) * 4` rows, so one frame recorded at this corner
   * stays replayable for every `limit` below it.
   */
  limitMax: number;
  /** Weight interval per scoring term. */
  w: {
    relevance: [number, number];
    importance: [number, number];
    recency: [number, number];
    usage: [number, number];
  };
  threshold: [number, number];
  hopEntity: [number, number];
  hopEdge: [number, number];
  /** Kind filter, as the live call received it. */
  kinds: MemoryKind[];
  /** Importance floor, as the live call received it. */
  minImportance: number;
}

/**
 * One realisation of the recall parameters, inside the box.
 *
 * `resolvePolicy` (memory/dream/policy.ts) is the single truth for these
 * numbers: today two effective policies exist for one function, because the
 * agent path never passes the hop weights. A config value that deviates
 * from the factory default is classified `user`, so a later promotion
 * cannot silently override what the user set (concept 9.3).
 */
export interface RecallPolicy {
  limit: number;
  threshold: number;
  w: RecallWeights;
  hopEntity: number;
  hopEdge: number;
  kinds: MemoryKind[];
  minImportance: number;
  /** Where each value came from. `default` while nothing is promoted. */
  origin: RecallPolicyOrigin;
}

/** The query as it arrived, with everything derived from it at record time. */
export interface FrameQuery {
  /**
   * The user's literal question. Frames are verbatim storage: this text
   * never outlives the memory and the session it came from (R17).
   */
  text: string;
  /** The safe FTS5 MATCH expression built from the text (`toMatchQuery`). */
  matchQuery: string;
  /** The tokens the tag boost compared against (`tokenize`). */
  tokens: string[];
}

/** One hop-1 row: identity plus the frozen bm25 relevance SQL returned. */
export interface FrameHop1Row {
  id: string;
  relevance: number;
}

/** An entity attached to a reachable memory, as the frame froze it. */
export interface FrameEntityRef {
  entityId: string;
  name: string;
  mentions: number;
}

/**
 * An edge the second hop could follow: `refines`/`caused_by`, collected
 * from the possible seeds rather than the realised ones.
 */
export interface FrameEdgeRef {
  id: string;
  srcId: string;
  dstId: string;
  relation: MemoryRelation;
  weight: number;
}

/**
 * A frozen copy of one memory row, taken when the frame was recorded. Every
 * column the score reads is fixed here: reading `access_count` or
 * `importance` live at replay time replays a world that never existed
 * (concept 3.7 c).
 */
export type MemoryRecordSnapshot = MemoryRecord;

/**
 * The document-frequency fingerprint of one night, over the tokens of that
 * night's frames (R10). bm25 is frozen in the frame and can never be
 * revalidated, so the corpus is the only observable that correlates with a
 * frame going stale. The fingerprint is computed once per night into `meta`
 * and each frame carries only its id; the stamp is up to 24 hours younger
 * than the frames it certifies, which is approximate and reported as such.
 */
export interface FrameCorpus {
  /** Identifies the `meta` row; stamped onto each frame as `corpusStampId`. */
  id: string;
  owner: string;
  /** When the fingerprint was computed, epoch milliseconds. */
  at: number;
  /** Document frequency per frame token at that moment. */
  df: Record<string, number>;
}

/**
 * Why a frame was not scored. A box violation firing is a recorder error,
 * not a measurement; the rest are real abstentions (concept 5.4).
 * `corpus-invalidated` is for frames older than a `reindex` or bulk import
 * that moved the corpus stamp discontinuously, and is counted apart from
 * `corpus-drifted`.
 */
export type AbstainReason =
  | 'limit-out-of-box'
  | 'seeds-capped'
  | 'degraded-turn'
  | 'frame-missing'
  | 'corpus-drifted'
  | 'corpus-invalidated'
  | 'budget-changed'
  | 'no-reachable-label'
  | 'no-labelled-move'
  | 'pipeline-mismatch'
  | 'no-label-source'
  | 'unfinished';

/** What `scoreFrame` answers: a ranking, or an abstention with its reason. */
export type ScoreResult =
  | { ok: true; ranked: ScoredMemory[] }
  | { ok: false; reason: AbstainReason };

/**
 * A recorded recall decision: the permissive corner of the declared box,
 * not the path that was taken. Everything a replay needs, frozen.
 *
 * The reachable set R is `hop1` plus `profile` plus every `entityNeighbours`
 * list plus every edge destination; `entities` covers all of R, because
 * `groupByEntity` reads entities for every delivered memory, not just the
 * seeds (concept 3.4).
 */
export interface RecallFrame {
  v: 1;
  site: DreamSite;
  pipeline: DreamPipeline;
  owner: string;
  box: RecallBox;
  query: FrameQuery;
  /**
   * The clock the recency term was computed with. A replay that recomputes
   * it makes all rows decay together and shrinks exactly the spread a
   * candidate could have moved (concept 3.7 b).
   */
  now: number;
  corpusStampId: string;
  /**
   * The normaliser of the relevance term AFTER the `Math.max(..., 1)`
   * clamp. Renormalising without the clamp inflates queries with a low
   * bm25 by a plausible-looking factor (concept 3.7 g).
   */
  maxRelevanceClamped: number;
  /**
   * Budget and subject the block was rendered with. A drift against the
   * live config abstains with `budget-changed`, because the cost term's
   * denominator moved (concept 5.4).
   */
  budgetChars: number;
  subject: string;
  /** One store of frozen rows; everything else references them by id. */
  records: Record<string, MemoryRecordSnapshot>;
  /** The hop-1 frontier in SQL order. */
  hop1: FrameHop1Row[];
  /**
   * Superset of the true second-hop seeds, from interval arithmetic over
   * the box. An error in the bound degrades to an abstention, never to a
   * plausible wrong number.
   */
  possibleSeeds: string[];
  /** Entities per reachable memory id. */
  entities: Record<string, FrameEntityRef[]>;
  /**
   * Neighbour ids per entity, recorded WITHOUT `exclude`, `8 +
   * |possibleSeeds|` rows each. Superseded rows are included on purpose:
   * the SQL limit bites before `offer` filters them.
   */
  entityNeighbours: Record<string, string[]>;
  edges: FrameEdgeRef[];
  /** Contradiction pairs over the reachable set, for a store-free `dropContradicted`. */
  contradicts: { srcId: string; dstId: string }[];
  /**
   * The core profile at the box's most permissive corner. A profile
   * recorded at a realised `limit` is not closed over `limit`, so
   * `mergeProfile` slices this list per candidate instead.
   */
  profile: { id: string; reason: string }[];
  /** Three worlds, not two - see `DreamDegraded`. */
  degraded: DreamDegraded | null;
}

/** What a framed turn reports when it opens a trace (`Store.beginTrace`). */
export interface DreamTraceInput {
  /** Groups the calls of one turn; labels attach here (R19). */
  turnId: string;
  owner: string;
  kind: DreamTraceKind;
  site: DreamSite;
  pipeline: DreamPipeline;
  sessionId?: string;
  sessionKind?: SessionKind;
  assignmentId?: string;
  sleepRunId?: string;
  /** Position of the turn in its session. */
  turnIndex?: number;
  /** The policy set in effect per slot, as `resolvePolicy` returned it. */
  policySet: Record<string, RecallPolicy>;
  /**
   * Whether the session fell into the sample - drawn per session, never
   * per trace, so consecutive turns cannot split across both sides.
   */
  framed?: boolean;
  holdout?: boolean;
  /** Marks the frozen audit set (R3); its reader arrives with Phase 3. */
  audit?: boolean;
}

/** What a framed turn reports when it closes its trace (`Store.finishTrace`). */
export interface DreamTracePatch {
  /** How the recall call degraded, once known. Explicit `null` is a legitimate value. */
  degraded?: DreamDegraded | null;
}

/**
 * One recorded recall invocation. A turn groups several calls under one
 * `turnId` (R19): the assistant's turn calls `recall` twice, plus
 * `coreProfile` and the write gate.
 */
export interface DreamTrace {
  id: string;
  turnId: string;
  owner: string;
  kind: DreamTraceKind;
  site: DreamSite;
  pipeline: DreamPipeline;
  sessionId?: string;
  sessionKind?: SessionKind;
  assignmentId?: string;
  sleepRunId?: string;
  turnIndex: number;
  policySet: Record<string, RecallPolicy>;
  framed: boolean;
  holdout: boolean;
  /** Frozen audit set (R3): the column exists in stage 1, its reader arrives with Phase 3. */
  audit: boolean;
  degraded: DreamDegraded | null;
  startedAt: number;
  finishedAt?: number;
  createdAt: number;
}

/** A stored frame, as the night's read path (`Store.framesFor`) hands it over. */
export interface DreamFrame {
  traceId: string;
  /** Which slot the frame closed over. Stage 1 has exactly one: `recall`. */
  slot: string;
  frameV: number;
  /** Denormalised for the deletion paths, so `payload` is never read for them (R17). */
  owner: string;
  sessionId?: string;
  box: RecallBox;
  corpusStampId: string;
  payload: RecallFrame;
  /** Serialised size; `saveFrame` rejects frames above `dream.maxFrameBytes`. */
  bytes: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ *
 * Dream, stage 2+ - labels, policy promotion, episodes
 *
 * Stage 1 (above) only records and measures. From here on the vocabulary
 * every wave-2 package builds against for Phase 2 (labels), Phase 3
 * (promotion) and Phase 6 (trajectory evaluation) - see
 * docs/concepts/dream-and-recursive-self-improvement.md and
 * docs/concepts/dream-stage2plus-buildplan.md. Every field below mirrors,
 * 1:1, a column of the tables AP1 adds in Schema 24.
 * ------------------------------------------------------------------ */

/**
 * Where a dream label came from. `usefulness`/`access_count`/`memory_touches`
 * are deliberately not sources (concept 4.3, E9) - they are score inputs,
 * frozen into the frame, never a claim about a turn.
 */
export type DreamLabelSource = 'correction' | 'review' | 'merge' | 'user';

/**
 * Whether a label names an exact turn or only the session it fell in.
 * Only `scope: 'turn'` feeds `gain(m)`/DCG (concept 4.2a) - a session-wide
 * label from an unlocatable quote still counts for the label agreement
 * check and calibration, never for a score.
 */
export type DreamLabelScope = 'turn' | 'session';

/**
 * A claim that one memory should, or should not, have been in one turn's
 * prompt (concept 4.1): `(turnId, target, relevance in {0,1}, source,
 * evidence)`. `target` is a memory id, or the sentinel `'*'` for a `review`
 * assignment-level weight (concept 4.2d), which never enters DCG. `dead_at`
 * survives the row when its target is later removed (concept 8.3, S9) - the
 * label history is calibration material and is never deleted outright.
 */
export interface DreamLabel {
  turnId: string;
  /** Memory id, or `'*'` for a `review` assignment-level weight. */
  target: string;
  source: DreamLabelSource;
  /** 1 = proven relevant, 0 = proven irrelevant. `review` lands in (0,1). */
  relevance: number;
  scope: DreamLabelScope;
  /** Correction id / review id / route name + actor. */
  evidence?: string;
  /** Set once the target is gone; the row itself is never deleted (S9). */
  deadAt?: number;
  createdAt: number;
  /** Denormalised for the deletion paths, mirroring `DreamFrame.owner`. */
  owner: string;
  sessionId?: string;
}

/** The three recall-family slots stage 2 carries a policy for (concept 7.1). */
export type DreamSlot = 'recall' | 'budget' | 'retry';

/**
 * One resolved, versioned parameter set for one owner's slot: the factory
 * default, a user override, or a dream promotion (`PolicyOrigin`, already
 * declared above for `RecallPolicyOrigin`). `resolvePolicy` (AP10) reads the
 * highest `version` with `promotedAt` set and `retiredAt` unset; `prevActiveId`
 * is what was active right before this one was promoted, so a revert or a
 * night's undo has something to reactivate (concept 8.5).
 */
export interface PolicyVersion {
  id: string;
  owner: string;
  slot: DreamSlot;
  version: number;
  /** Full parameter set for `slot`; shape depends on which slot this is. */
  params: Record<string, unknown>;
  /** The box this version was validated against; shape depends on `slot`. */
  box: Record<string, unknown>;
  origin: PolicyOrigin;
  parentId?: string;
  /** What was active when this version was promoted. `undefined`: none was. */
  prevActiveId?: string;
  sleepRunId?: string;
  rationale?: string;
  replayScore?: number;
  replayN?: number;
  baselineScore?: number;
  /** Against the factory default parameter set, on the frozen audit set. */
  auditDelta?: number;
  auditCiLow?: number;
  onlineScore?: number;
  promotedAt?: number;
  retiredAt?: number;
  createdAt: number;
}

/**
 * The four freeze causes (concept 10.3). A frozen slot keeps measuring but
 * never promotes again until a person thaws it.
 */
export type DreamSlotFreezeReason = 'calibration' | 'staleness' | 'agreement' | 'manual';

/** Per-owner, per-slot promotion state: frozen or not, and the cooldown clock. */
export interface DreamSlotState {
  owner: string;
  slot: DreamSlot;
  frozenAt?: number;
  frozenReason?: DreamSlotFreezeReason;
  cooldownUntil?: number;
  lastPromoted?: number;
}

/**
 * One candidate evaluation: the paired, bootstrapped delta against the
 * incumbent, its validity certificate (concept 5.4) and its promotion
 * outcome. `abstainReasons` keys on `AbstainReason`; `signAgree` is the
 * freshness check's verdict (concept 5.5a) - `null` means "undetermined",
 * because `|delta_frozen| <= margin` makes the sign comparison moot.
 */
export interface DreamEval {
  id: string;
  sleepRunId: string;
  policyId: string;
  slot: DreamSlot;
  /** Offered. */
  traces: number;
  /** Closed and scored. */
  closed: number;
  abstained: number;
  abstainReasons: Partial<Record<AbstainReason, number>>;
  reachableRate: number;
  labelCoverage: number;
  costOnlyShare: number;
  score: number;
  baseline: number;
  delta: number;
  /** Cluster-bootstrap over sessions, 95 percent, reported as approximated. */
  ciLow: number;
  ciHigh: number;
  /** Against the factory default, on the frozen audit set. */
  auditDelta?: number;
  auditCiLow?: number;
  /** Freshness check: score against the live bank instead of frozen frames. */
  deltaLive?: number;
  /**
   * `null` is a legitimate value, not "not yet known" - it means
   * undetermined (`|delta| <= margin`), see the freshness check above. The
   * same pattern `DreamTrace.degraded` already uses.
   */
  signAgree: boolean | null;
  evalMs: number;
  /** sha256 over the sorted trace ids this evaluation closed over. */
  traceSetHash: string;
  /** Condensed reasoning, never verbatim text. */
  evidenceDigest?: string;
  promoted: boolean;
  /** Score per label source, gaming-admission counters. */
  detail?: Record<string, unknown>;
  createdAt: number;
}

/**
 * The index over one turn's or one assignment's existing `turn_events`
 * journal (concept, AP1 "dream_episodes"): not a second transcript store,
 * only what the journal does not already know - outcome, step count, and
 * whether this episode fell into the frozen audit set. `id` is the same id
 * as the underlying `turns`/`assignments` row.
 */
export interface DreamEpisode {
  id: string;
  owner: string;
  kind: 'turn' | 'assignment';
  sessionId?: string;
  /** Which slot's policy this episode is relevant to. */
  slot: string;
  steps: number;
  outcome: 'success' | 'failure' | 'unknown';
  holdout: boolean;
  audit: boolean;
  startedAt: number;
  finishedAt?: number;
  createdAt: number;
}

/**
 * One tool step of an episode, read back from `turn_events` rather than
 * stored anywhere new (`episodeFromEvents`, AP7). Observations are keyed on
 * `(step, argsHash)` - concept S28/S29 - so a diverging action can
 * structurally never match a recorded one.
 */
export interface DreamEpisodeStep {
  step: number;
  name: string;
  argsHash?: string;
  input?: string;
  result?: string;
  isError?: boolean;
  at: number;
}

/**
 * The first-divergence verdict (concept 7.2/S29): `k = n` is `no-change`;
 * `k < n` on a failed episode is `may-avoid-failure` and counts for nothing;
 * `k < n` on a successful episode is `regression-risk` at step `k`. Nothing
 * is claimed about steps after `k`.
 */
export type DreamVerdict = 'no-change' | 'may-avoid-failure' | 'regression-risk';

/**
 * Who caused a memory write or edit. `'model'` is the default for every
 * existing store call site so nothing breaks; only the HTTP path passes
 * `'user'` explicitly (concept 4.2b, S5), and `'sleep'` is the night itself.
 * Only `actor === 'user'` makes the store write a `user` dream label.
 */
export type MemoryActor = 'user' | 'model' | 'sleep';

/* ------------------------------------------------------------------ *
 * Organisation
 * ------------------------------------------------------------------ */

/**
 * The company the assistant runs.
 *
 * There is still exactly one conversational identity - the assistant - and
 * nothing here can take the conversation over. What changed is that the
 * people the assistant delegates to are durable: an agent is a record with a
 * role, a manager and its own memory, not a process that lives for one step.
 * Every assignment still starts a fresh provider process.
 */
export interface Organization {
  id: string;
  name: string;
  /** What the company is for, in one or two sentences. */
  mission?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  /** Directory assignments for this project run in. Unset: the workspace. */
  path?: string;
  /**
   * Whether this project's own `.mcp.json` may start processes for an
   * assignment. Unset: not yet decided, so its servers stay off. The
   * fingerprint is of the file's content, so an edit after approval is
   * noticed and needs approving again.
   */
  mcpTrust?: { fingerprint: string; approvedAt: number };
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  purpose?: string;
  /** Agent leading the team, when one is named. */
  leadId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  orgId: string;
  /** Stable handle used in tool calls and the CLI, e.g. `backend-dev`. */
  slug: string;
  name: string;
  /** Job title, e.g. "Backend Engineer". */
  title: string;
  /** The role's standing instructions. Never mixed into the assistant's voice. */
  instructions: string;
  /**
   * Two to four sentences on HOW this person writes - never what they can
   * do, which is what `instructions` is for. Nullable and usually empty:
   * an unset voice colours nothing, exactly today's behaviour (decision
   * E11, F5). Set at `hire_agent`, editable on the agent's own form.
   */
  voice?: string;
  teamId?: string;
  /** Direct manager. Unset: reports to the assistant. */
  managerId?: string;
  provider?: ProviderId;
  model?: string;
  permission?: PermissionLevel;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export type AssignmentStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

/** Who handed out an assignment. */
export type RequesterKind = 'user' | 'assistant' | 'agent';

export interface Assignment {
  id: string;
  orgId: string;
  agentId: string;
  projectId?: string;
  /** Conversation the assignment was started from, when it was. */
  sessionId?: string;
  /** The assignment whose tool call spawned this one, for delegation chains. */
  parentId?: string;
  requesterKind: RequesterKind;
  requesterAgentId?: string;
  /**
   * What this run is called - three to eight words, never the brief itself.
   * A run that belongs to a task carries that task's name (decision E17);
   * one that does not is named by whoever started it. Required here and
   * nullable in the column: a row written before the name existed is named
   * from its own first line when it is read, and never written back.
   */
  title: string;
  task: string;
  status: AssignmentStatus;
  result?: string;
  error?: string;
  provider?: ProviderId;
  model?: string;
  /** Characters of output produced so far, as a cheap progress signal. */
  chars: number;
  /** Nesting depth: 0 when the assistant delegated directly. */
  depth: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

/** An assignment as a client renders it live. */
export interface AssignmentView {
  id: string;
  agentId: string;
  agentSlug: string;
  agentName: string;
  /** The run's name, for lists; `task` stays the full brief underneath it. */
  title: string;
  task: string;
  status: AssignmentStatus;
  projectId?: string;
  parentId?: string;
  depth: number;
  provider?: ProviderId;
  chars?: number;
  /** Tail of the output, for a live preview line. */
  preview?: string;
  /** The most recent tool call this run made, for a live activity view. */
  lastActivity?: { kind: 'tool' | 'status'; label: string; at: number };
  durationMs?: number;
  error?: string;
}

/** Who judged a run: a hard signal with no model call, Jarvis, or the user. */
export type ReviewSource = 'user' | 'assistant' | 'system';

/**
 * A judgment of one completed assignment, always against the agent's own
 * role - never against other agents. `overall` is its own judgement rather
 * than an average of the five dimensions below: averaging would wash out
 * exactly the outlier that makes a review worth having.
 *
 * Organisation data, not a memory: it never enters `memories` and never
 * reaches the reviewed agent's own prompt (see
 * docs/concepts/agent-performance-management.md, decision E2).
 */
export interface AgentReview {
  id: string;
  orgId: string;
  agentId: string;
  /** Unset for a periodic review with no single run behind it. */
  assignmentId?: string;
  /** Convenience for the UI; the assignment id is the durable link. */
  taskId?: string;
  source: ReviewSource;
  /** 1..5, the only required judgement. */
  overall: number;
  quality?: number;
  completeness?: number;
  reliability?: number;
  communication?: number;
  efficiency?: number;
  /** One to three sentences on what was good or bad. */
  comment?: string;
  tags: string[];
  /**
   * A technically failed run (timeout, no provider, empty output) - counts
   * toward the agent's failure rate, never toward its quality average.
   */
  failedRun: boolean;
  createdAt: number;
}

export type AgentActionKind = 'note' | 'reconfig' | 'probation' | 'replace';

/**
 * The personnel record behind a review trail: what actually changed about an
 * agent, and why. Exists so a `reconfig` is a documented, reversible step
 * instead of `updateAgent` silently overwriting `instructions`.
 */
export interface AgentAction {
  id: string;
  orgId: string;
  agentId: string;
  kind: AgentActionKind;
  /** The escalation stage in effect when this action was taken. */
  stage: number;
  /** Internal diagnosis with evidence; the agent never sees this. */
  reason: string;
  /** Required together with `afterText` when `kind` is `reconfig`. */
  beforeText?: string;
  afterText?: string;
  /** Qualitative feedback addressed to the agent itself - no numbers, no dimension names. */
  agentNote?: string;
  /** Set on `replace`: the condensed handover for the successor. */
  handoverText?: string;
  /** The reviews that justified this action. */
  reviewIds: string[];
  decidedBy: 'user' | 'assistant';
  /** Set on `replace`: the newly hired agent taking over. */
  successorAgentId?: string;
  createdAt: number;
}

/**
 * The computed, never-materialised view of one agent's standing: a rolling
 * average over effective reviews, a trend, the escalation stage, and a
 * failure rate kept apart from it so infrastructure trouble never reads as a
 * quality problem. See `OrgStore.performance()`.
 */
export interface AgentPerformance {
  /** Mean `overall` of the last 10 effective, non-failed reviews. Null with fewer than 3. */
  average: number | null;
  /** How many effective reviews fed the average. */
  count: number;
  /** avg(last 5) - avg(previous 5). Null with fewer than 10 effective reviews. */
  trend: number | null;
  /** 0 normal, 1 flagged, 2 reconfigured/on probation, 3 replacement proposed. */
  stage: 0 | 1 | 2 | 3;
  /** Technically failed runs over the last 20 effective reviews, 0..1. */
  failureRate: number;
  lastReviewAt?: number;
}

export interface AgentMessage {
  id: string;
  orgId: string;
  /** Unset: the assistant wrote it. */
  fromAgentId?: string;
  /** Unset: addressed to the assistant. */
  toAgentId?: string;
  assignmentId?: string;
  content: string;
  createdAt: number;
  readAt?: number;
}

/**
 * Company mail: To + Cc, a subject, threading, and per-recipient read state -
 * the real replacement for `AgentMessage`. Mailing an agent's To line
 * triggers a real run of that agent (see org/controller.ts `#deliverMail`);
 * Cc only ever delivers, it never starts anything.
 */

/** Whose mailbox: the user, the assistant, or one agent (`id` set). */
export interface MailWho {
  kind: RequesterKind;
  /** Agent id. Set only when `kind` is 'agent'. */
  id?: string;
}

/**
 * What a mail thread *is*, decided once when the thread is created and
 * inherited by every reply. `chat` is plain conversation; `assignment` is a
 * work order that created a task; `report` is a thread a run started (self
 * reports, cron results, an agent writing first). The kind is what routes a
 * thread into the fixed inbox folders.
 */
export type MailThreadKind = 'chat' | 'assignment' | 'report';

/**
 * The fixed inbox folders, the same for every mailbox. `outbox` is not one of
 * them - what you sent is routed by sender, not by what the thread is.
 */
export type MailFolder = 'inbox' | 'tasks' | 'reports' | 'archiv';

/** The protocol row behind one `threadId` - see `mail_threads` in memory/db.ts. */
export interface MailThread {
  threadId: string;
  orgId: string;
  kind: MailThreadKind;
  /** The task an assignment thread created; what makes the work traceable. */
  taskId?: string;
  archivedAt?: number;
  createdAt: number;
}

export interface Mail {
  id: string;
  orgId: string;
  fromKind: RequesterKind;
  /** Set only when `fromKind` is 'agent'. */
  fromAgentId?: string;
  subject: string;
  body: string;
  /** Shared by every mail in a reply chain; equals `id` for the root mail. */
  threadId: string;
  inReplyTo?: string;
  /** Auto-trigger hop count, the loop guard for mail-triggered runs. */
  depth: number;
  /** The run this mail's body came from, when it is an automatic reply. */
  assignmentId?: string;
  createdAt: number;
  recipients: MailRecipient[];
  /** The thread's kind, joined in from `mail_threads`. */
  threadKind?: MailThreadKind;
  /** Set when the thread is an assignment with a task on the board. */
  taskId?: string;
  taskTitle?: string;
  /** Set when the whole thread has been archived. */
  threadArchivedAt?: number;
}

export interface MailRecipient {
  id: string;
  mailId: string;
  recipientKind: RequesterKind;
  /** Set only when `recipientKind` is 'agent'. */
  recipientId?: string;
  box: 'to' | 'cc';
  readAt?: number;
}

/**
 * `blocked` is the state a task is in while it waits for an answer: its run
 * ended with a question to whoever assigned it, so the work is neither done
 * nor failed. The next mail in its thread continues it.
 */
export type TaskStatus = 'open' | 'planned' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';

/**
 * A task on the company board.
 *
 * Tasks are how work is tracked before and after it runs; assignments are
 * the runs themselves. A task can be planned into subtasks, each given to
 * one agent, and executed in dependency order. The planning decision - one
 * agent or a split, and who - is made by a cheap model reading the board and
 * the org chart (see org/planner.ts).
 */
export interface Task {
  id: string;
  orgId: string;
  projectId?: string;
  /** The task this is a subtask of. */
  parentId?: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Agent the task is (planned to be) done by. */
  assigneeId?: string;
  /** The assignment that ran it, once it did. */
  assignmentId?: string;
  createdBy: RequesterKind;
  createdByAgentId?: string;
  /** Sibling task ids that must finish first. */
  dependsOn: string[];
  /** Why the planner decided what it decided. */
  planNote?: string;
  result?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Manual board position within its status column; drag&drop only. */
  sortOrder: number;
}

/* ------------------------------------------------------------------ *
 * Schedules
 * ------------------------------------------------------------------ */

/**
 * Who does the work when a schedule fires: the assistant itself, as a turn
 * of its own in a conversation dedicated to the job, or one agent as an
 * assignment. Either way the outcome lands in the assistant's inbox.
 */
export type CronJobKind = 'assistant' | 'agent' | 'sleep' | 'script';
export interface CronScript {
  /** Absolute path to the reviewed copy under Rookery's imported-scripts directory. */
  path: string;
  runtime: 'python' | 'node' | 'bash' | 'powershell';
  noAgent?: boolean;
}
export type CronRunStatus = 'running' | 'done' | 'failed';
/** What started a run: the clock, a person pressing "run now", or something that happened. */
export type CronTrigger = 'schedule' | 'manual' | 'event';

/**
 * Whether the clock fires a schedule at all.
 *
 * `schedule` is the original behaviour, and an event may fire such a job on
 * top - the clock is then the backstop for events that never arrived.
 * `event` means there is no clock: the job waits for a webhook call or a
 * heartbeat listener, and its `schedule` expression may be empty.
 */
export type CronTriggerMode = 'schedule' | 'event';

/**
 * A standing order: a prompt that runs on a cron schedule while the server
 * is up. Times are the machine's local time; a five-field expression such as
 * `0 8 * * 1-5` (weekdays at 08:00).
 */
export interface CronJob {
  id: string;
  orgId: string;
  name: string;
  /** Five-field cron expression, normalised; empty when only events fire this job. */
  schedule: string;
  /** Whether the clock fires this job, or only an event does. */
  triggerMode: CronTriggerMode;
  /**
   * The secret an outside caller puts in the webhook URL to fire this job.
   * Unset while no webhook exists; one job, one secret, revocable on its own
   * without touching the server's shared token.
   */
  webhookToken?: string;
  /**
   * Shortest gap between two runs before an event may start another. An
   * event that arrives inside the gap is not dropped - it waits for the gap
   * to pass and then fires once, however many arrived meanwhile.
   */
  eventCooldownMs?: number;
  kind: CronJobKind;
  script?: CronScript;
  /** Remaining attempts for a finite schedule; omitted means unlimited. */
  remainingRuns?: number;
  /** What to do, written for whoever runs it. */
  prompt: string;
  /** The agent, for the `agent` kind. */
  agentId?: string;
  projectId?: string;
  /** The assistant's conversation for this job; one per job, reused across runs. */
  sessionId?: string;
  /** Provider permission for the assistant's own runs; the config default otherwise. */
  permission?: PermissionLevel;
  enabled: boolean;
  /** Fire once, then switch off: "tomorrow at 15:00" rather than "every day". */
  once: boolean;
  createdBy: RequesterKind;
  createdAt: number;
  updatedAt: number;
  /** When the clock will fire next; unset while disabled or unschedulable. */
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  runCount: number;
}

/** One execution of a schedule. */
export interface CronRun {
  id: string;
  jobId: string;
  orgId: string;
  trigger: CronTrigger;
  status: CronRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: string;
  error?: string;
  /** The conversation the assistant ran in, for the `assistant` kind. */
  sessionId?: string;
  /** The assignment that ran, for the `agent` kind. */
  assignmentId?: string;
  /**
   * What fired an `event` run, in words a person reads: `webhook` for a call
   * that came in over HTTP, or a listener's id such as `imap:work`. Unset for
   * the clock and for "run now", whose trigger already says everything.
   */
  source?: string;
}

/**
 * What came of offering an event to a schedule.
 *
 * An event is never silently dropped: it either starts a run, joins the run
 * already under way, or waits for the cooldown to pass and fires once for all
 * the events that arrived meanwhile.
 */
export type CronEventOutcome =
  | { status: 'started'; run: CronRun }
  /** A run was already under way; one more follows when it finishes. */
  | { status: 'coalesced' }
  /** Inside the cooldown; it fires in `waitMs`. */
  | { status: 'queued'; waitMs: number }
  /** Nothing will happen, and why: unknown, switched off, or out of runs. */
  | { status: 'ignored'; reason: string };

/* ------------------------------------------------------------------ *
 * Aggregate statistics
 * ------------------------------------------------------------------ */

/**
 * Whole-database counts, every one of them a `COUNT(*)`.
 *
 * They exist because every list endpoint is capped: a total counted from a
 * page of 500 stops being true the moment the cap bites, and a dashboard
 * that quietly rounds down is worse than one that shows nothing. Sessions,
 * messages and memories span the database; the company's numbers belong to
 * the active organisation, the memory numbers to one owner.
 */
export interface StatsTotals {
  /** Conversations that are not archived. */
  sessions: number;
  archivedSessions: number;
  /** Transcript rows across every conversation. */
  messages: number;
  assignments: number;
  /** Assignments still pending or running. */
  runningAssignments: number;
  /** Top-level tasks and subtasks together. */
  tasks: number;
  /** Tasks in `open`, `planned` or `running` - what is still ahead. */
  openTasks: number;
  cronJobs: number;
  cronRuns: number;
  /** Live memories of the asked-for owner; the same figure as `memoryStats().total`. */
  memories: number;
  /** Agents that are not archived. */
  agents: number;
}

/**
 * One local calendar day of the time series.
 *
 * A day only appears once something happened on it. The gaps are left in on
 * purpose: only the client knows which window it means to draw, so filling
 * them is its job, not the database's.
 *
 * Every figure counts what was created that day, whatever became of it
 * since - a conversation archived last week still counts on the day it
 * started. That is why the series and `StatsTotals` answer different
 * questions and need not add up to each other.
 */
export interface StatsDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  sessions: number;
  messages: number;
  assignments: number;
  tasks: number;
  cronRuns: number;
  memories: number;
  /** Prompt tokens summed over the day's messages; 0 when none were recorded. */
  inputTokens: number;
  /** Completion tokens, same caveat. */
  outputTokens: number;
}

/** What `GET /api/stats` answers with: the counts, and how they came about. */
export interface StatsSnapshot {
  /** Start of the series window, epoch milliseconds, inclusive. */
  since: number;
  /** End of the window, epoch milliseconds, inclusive - "now" in practice. */
  until: number;
  /** The company the organisation numbers belong to. */
  orgId: string;
  /** The memory bank the memory numbers belong to. */
  owner: string;
  totals: StatsTotals;
  /** Ascending by day, gaps left in. */
  series: StatsDay[];
  /**
   * False when no message in the window carried usage data at all. Then the
   * token figures are zero because nothing was recorded, not because nothing
   * was spent - the difference matters on a chart.
   */
  tokensAvailable: boolean;
}

/* ------------------------------------------------------------------ *
 * Provider adapter contract
 * ------------------------------------------------------------------ */

/** A stdio MCP server the provider CLI should start for this turn. */
export interface McpServerSpec {
  /** Server name as the CLI sees it; tools become `mcp__<name>__<tool>`. */
  name: string;
  /**
   * How the CLI reaches it. Absent means `stdio`, the only shape Rookery's
   * own catalogue produces; the hosted endpoints come in with the servers
   * read out of a Claude Code plugin (`context7`, `vercel`).
   */
  transport?: 'stdio' | 'http' | 'sse';
  /** stdio only. */
  command?: string;
  args: string[];
  env: Record<string, string>;
  /** http and sse only. */
  url?: string;
  headers?: Record<string, string>;
}

/**
 * One subagent type handed to the provider CLI for a single turn, as the file
 * it was approved from. The body never travels through argv: a Windows shim
 * spawn goes through `cmd.exe` in verbatim mode, where no escaping of ours can
 * guarantee that foreign text stays one argument, so the provider copies the
 * file into a generated plugin folder instead and points `--plugin-dir` at it.
 */
export interface ProviderAgentFile {
  /** The name the model calls the subagent by, from the file's frontmatter. */
  name: string;
  /** The approved source file, copied verbatim at spawn time. */
  path: string;
}

/**
 * The settings document for one turn, written to a file and passed to
 * `--settings` by path. It carries Rookery's own `permissions.deny`
 * groundwork and nothing a plugin wrote: foreign text reaches the spawn
 * through files, never through this document. Left open on purpose - the
 * provider owns the schema, Rookery only assembles it.
 */
export interface ProviderSettings {
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  [key: string]: unknown;
}

/**
 * Approved hook handlers for one turn, merged across sources into the
 * `hooks.json` of the generated plugin folder. Opaque on purpose: the table is
 * the plugin's own format, read back verbatim after the fingerprint matched.
 */
export type ProviderHookTable = Record<string, unknown[]>;

export interface ProviderTurnOptions {
  prompt: string;
  /** Prepended context: persona, recalled memories, conversation digest. */
  systemPrompt?: string;
  /**
   * `append` adds the system prompt to the CLI's own (a coding agent that
   * knows Rookery); `replace` makes it the whole system prompt (someone who
   * is Rookery). Providers that cannot replace fall back to append.
   */
  systemPromptMode?: 'append' | 'replace';
  /** Resume the provider's own session rather than starting cold. */
  providerSessionId?: string;
  model?: string;
  /** How hard the model may think. Unset leaves the provider's own default. */
  effort?: EffortLevel;
  cwd?: string;
  /** How much the provider's own tools are allowed to do. */
  permission?: PermissionLevel;
  /** Rookery's own tools, offered to the model through MCP. */
  mcp?: McpServerSpec;
  /** Further MCP servers for this turn, e.g. computer control. */
  mcpExtra?: McpServerSpec[];
  /**
   * Subagent types for this turn, as approved files the provider copies into
   * its generated plugin folder. Empty or unset passes nothing, so the CLI
   * keeps whatever it would have had.
   */
  handoffAgents?: ProviderAgentFile[];
  /** Rookery's own permission floor for this turn, passed as a settings file. */
  settings?: ProviderSettings;
  /** Approved hook handlers for this turn, merged into the plugin folder. */
  hooks?: ProviderHookTable;
  /**
   * Plugin folders to load whole for this turn. A source loaded this way is
   * not additionally passed as curated skills, agents or hooks - otherwise
   * the same shelf would stand there twice.
   */
  pluginDirs?: string[];
  signal?: AbortSignal;
}

/**
 * - chat:  no tools that touch the machine (read-only assistant)
 * - read:  may read files and search
 * - write: may edit files inside cwd
 * - full:  may run commands, still inside the provider's own sandbox rules
 */
export type PermissionLevel = 'chat' | 'read' | 'write' | 'full';

/**
 * Reasoning effort, the same ladder for every provider. Both CLIs take the
 * value verbatim; whether a given model supports the top levels is theirs to
 * report.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

/**
 * A configured alternative backend for the `claude` binary: same adapter,
 * same event parsing, just pointed at another Anthropic-compatible endpoint
 * via env vars. `authToken` is the only field never sent to the browser; see
 * `publicConfig` in the server package.
 */
export interface ProviderProfile {
  /** Slug used as this profile's ProviderId, e.g. "glm". */
  id: string;
  displayName: string;
  /** Anthropic-Messages-compatible endpoint. */
  baseUrl: string;
  /** Stored the same way as `gateways.telegram.token`: empty string means unset. */
  authToken: string;
  defaultModel?: string;
  /**
   * `'direct'`: the endpoint speaks Anthropic Messages natively (z.ai, Moonshot,
   * MiniMax, ...). `'router'`: reach it through the Rookery-managed
   * `claude-code-router` process instead, for backends with no native
   * Anthropic-compatible API (OpenRouter, DeepSeek, Ollama, ...).
   * `'codex-bridge'`: Rookery's own in-process bridge, which serves the
   * ChatGPT Codex backend as Anthropic Messages on the session `codex login`
   * created - a subscription rather than an API key.
   */
  via: 'direct' | 'router' | 'codex-bridge';
}

export interface ProviderStatus {
  id: ProviderId;
  /** For a UI rendering an id it has no hardcoded label for, e.g. a profile. */
  displayName: string;
  available: boolean;
  binary: string;
  version?: string;
  authenticated: boolean;
  /** Human-readable reason when unavailable or logged out. */
  detail?: string;
}

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Probe binary and login state. Cheap enough to call on startup. */
  status(): Promise<ProviderStatus>;
  /** Run one turn, streaming normalised events. */
  run(options: ProviderTurnOptions): AsyncGenerator<AgentEvent, void, unknown>;
  /** Models this provider accepts, for UI pickers. */
  models(): string[] | Promise<ProviderModel[]>;
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export interface RookeryConfig {
  /** Root for db, logs and config. Defaults to ~/.rookery */
  home: string;
  /**
   * Directory the assistant's own provider process runs in. Defaults to
   * `<home>/workspace`, so the assistant never sees the directory Rookery
   * happened to be started from.
   */
  workspace: string;
  port: number;
  host: string;
  defaultProvider: ProviderId;
  defaultModel?: string;
  /** Unset means each provider's own default effort. */
  defaultEffort?: EffortLevel;
  defaultPermission: PermissionLevel;
  /** Shared secret for non-loopback access. Empty disables remote auth. */
  token: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  memory: MemoryConfig;
  voice: VoiceConfig;
  org: OrgConfig;
  gateways: GatewaysConfig;
  /** Connections held open so a schedule can react instead of poll. */
  listeners: ListenersConfig;
  /** The MCP hub: which servers run for whom. */
  tools: ToolsConfig;
  /** What is taken over from the Claude Code installed here. */
  external: ExternalConfig;
  /** How long the assistant waits when it asks the user something. */
  questions: QuestionsConfig;
  /** Where skills live, one folder per skill. Defaults to `<home>/skills`. */
  skillsDir: string;
  /** Alternative backends for the `claude` binary. Empty by default: opt-in per provider. */
  providerProfiles: ProviderProfile[];
  /** The Rookery-managed `claude-code-router` process, used by `via: 'router'` profiles. */
  router: RouterConfig;
  /** Switching providers when one runs low on quota. */
  providerFallback: ProviderFallbackConfig;
  /** Name the assistant answers to, used in the persona and as wake word base. */
  assistantName: string;
  userName?: string;
  /** Address the user formally: German "Sie", never "du"; formal register elsewhere. */
  formalAddress: boolean;
  /** What the assistant calls the user now and then, e.g. "Master" or "Sir". Empty: the name. */
  honorific: string;
}

/**
 * Routing around a provider whose quota is running out: one that reports a
 * window this full is avoided while a roomier one is signed in, and one whose
 * turn died on a usage limit is left alone until the window resets.
 */
export interface ProviderFallbackConfig {
  enabled: boolean;
  /** A window at or above this share of its quota counts as "running low". */
  thresholdPercent: number;
  /**
   * Which provider to try after the preferred one, in this order. Empty: the
   * preferred provider, then the rest as they were configured.
   */
  order: ProviderId[];
}

export interface MemoryConfig {
  enabled: boolean;
  /** Max memories injected into a single turn's context. */
  recallLimit: number;
  /** Minimum blended score for a memory to be injected. */
  recallThreshold: number;
  /** Run fact extraction after each turn. */
  autoExtract: boolean;
  /** Turns kept verbatim before older ones get summarised. */
  workingWindow: number;
  /** Rough character budget for the assembled context block. */
  contextBudget: number;
  /** The gate in front of the write path: what may become a memory at all. */
  gate: MemoryGateConfig;
  /** The second hop: how far recall reaches past a literal match. */
  graph: MemoryGraphConfig;
  /**
   * The dream: recording and replaying recall so the night can measure the
   * retrieval policy, and - stage 2 on - promoting what measurably wins.
   * Every switch ships off (`enabled`, `record`, `promote`); this stage
   * delivers the machine, not its start (concept 11, plan section 1.2).
   */
  dream: DreamConfig;
  /** The nightly clean-up. */
  sleep: SleepConfig;
}

export interface MemoryGateConfig {
  /** How many candidates one turn may store at most. */
  maxPerTurn: number;
  /** Candidates below this are dropped unless they name a known entity. */
  minImportance: number;
  /** Similarity at or above which a candidate reinforces instead of inserting. */
  duplicateThreshold: number;
  /** Similarity at or above which two memories are queued for the night. */
  clusterThreshold: number;
}

export interface MemoryGraphConfig {
  /** Score a memory inherits through a shared entity. */
  hopEntity: number;
  /** Score a memory inherits through a `refines` or `caused_by` edge. */
  hopEdge: number;
  /** Hard cap on nodes handed to the graph view. */
  maxNodes: number;
}

/**
 * The dream's own settings, beside `memory.sleep`. Every key names its
 * reader - the key table sits above the `dream:` block in config.ts - and a
 * key without a reader does not ship (E20). Stage 2 adds the keys the
 * candidate writer, the evaluation machinery and the promotion gate read;
 * see docs/concepts/dream-stage2plus-buildplan.md section 3, AP2.
 */
export interface DreamConfig {
  /** The whole dream. Off means: no recorder, no night probe. */
  enabled: boolean;
  /** Only the recorder. Separate, so it can be switched off without losing the night. */
  record: boolean;
  /**
   * The promotion gate. Off means: the night still measures and writes
   * `dream_evals`, but never touches `policy_versions` (concept 10.2,
   * condition 8; E20/E22 - this stage ships it off).
   */
  promote: boolean;
  /** Share of sessions that get framed at all. Drawn per session, never per trace. */
  frameRate: number;
  /** The most permissive corner: up to which `limit` a frame stays replayable. */
  limitMax: number;
  /** The grid: fixed placements the night scores against the incumbent. */
  gridSize: number;
  /** Weight of the cost term in the block measure. */
  costWeight: number;
  /** Relative change in the frame tokens' document frequency at which a trace abstains. */
  corpusTolerance: number;
  /** Hard ceiling on frame size in bytes; above it, nothing is framed. */
  maxFrameBytes: number;
  /** Wall-clock ceiling for the model-free night evaluation, in milliseconds. */
  maxEvalMs: number;
  /** Retention for frames (large, kept only for replay). */
  frameRetainDays: number;
  /** Retention for traces and touches (small, they carry the calibration). */
  retainDays: number;
  /**
   * Run-global ceiling over all owners. Zero in stage 1, where nothing spent
   * a call; from stage 2 on the candidate writer does, so this is the wallet
   * for it (concept 9.4).
   */
  maxCallsPerNight: number;
  /** Which slots the night carries a policy for. Stage 2 ships `['recall']` alone. */
  slots: DreamSlot[];
  /** Candidates the candidate writer proposes per slot per night (concept 6.2). */
  candidates: number;
  /** Model for the candidate writer. Never `smallModelFor`/`ask`'s wired `'low'` effort (S16). */
  model: string;
  /** Reasoning effort for that same caller. Never `'low'`: designing a policy is judgement (E14). */
  effort: 'medium' | 'high';
  /** Below this many closed traces (post-intersection), an evaluation is invalid, not lost (validity rule 3). */
  minTraces: number;
  /** Promotion needs `delta > margin` on the holdout, and the freshness check's sign-agreement tolerance. */
  margin: number;
  /** Below this `label_coverage`, an evaluation is invalid (concept 4.4). */
  coverageFloor: number;
  /** Above this `cost_only_share`, an evaluation is invalid (concept 4.4). */
  costOnlyCeiling: number;
  /** Candidate abstain rate may exceed the baseline's by at most this (validity rule 2). */
  abstainEps: number;
  /** Both arms' abstain rate must stay under this (validity rule 2). */
  abstainFloor: number;
  /** Below this mean `reachable_rate`, an evaluation is invalid (validity rule 4). */
  reachableFloor: number;
  /**
   * Below this precision, the `correction` label source is not a source
   * (concept 4.2a) - the fallback is `labelModelCalls` below.
   */
  correctionPrecisionFloor: number;
  /** Model calls spent labelling corrections directly, when precision falls short. Zero: modelfree. */
  labelModelCalls: number;
  /** Milliseconds: the session window a `user` label's HTTP edit is attributed over (concept 4.2b). */
  userLabelWindow: number;
  /** Below this Cohen's kappa between label sources, the label agreement check is unvalidated (concept 5.5b). */
  agreementFloor: number;
  /** Traces after promotion before the wake test's regression alarm runs (concept 5.5c). */
  calibrationTraces: number;
  /** Replay-vs-online score drift the wake test tolerates before it freezes the slot. */
  tolerance: number;
  /** Nights a slot must wait between promotions (concept 5.3, `trace_set_hash` disjointness). */
  cooldownNights: number;
  /** Hard cap on promotions per night, across every slot (concept 10.2, condition 8). */
  maxPromotionsPerNight: number;
  /** Share of nights that spend a free exploration instead of a promotion attempt (E17). Zero: none. */
  explorationRate: number;
  /**
   * Trial episodes for Phase 6's first-divergence evaluation. Zero in this
   * stage on purpose (concept 11, Phase 6; plan section 1.2): the mechanism
   * ships, its validation gate does not open itself.
   */
  trialEpisodes: number;
}

export interface SleepConfig {
  enabled: boolean;
  /** Five-field cron expression for the nightly run. */
  schedule: string;
  /** Which banks sleep: only the assistant's, or every agent's too. */
  scope: 'assistant' | 'all';
  /**
   * Hard cap on the night's expensive model calls across the consolidation
   * phases (condense, resolve, link, reflect, revise, practise). The budget
   * is not spent by the clock: each phase first measures how much work there
   * actually is, and only that demand is funded, up to this ceiling. A quiet
   * week costs a few calls; a loud one runs until the cap. The replay pass
   * sits outside the wallet - it is bounded by `replaySessions`, and its
   * cheap triage pass does not count against anything.
   */
  nightBudget: number;
  /** Ceiling on condensation calls per night; the adaptive budget may spend less. */
  maxMergeCalls: number;
  /** Ceiling on the calls that draw new edges between memories. */
  maxLinkCalls: number;
  /** Untouched for this long and weak enough, a memory goes dormant. */
  dormantAfterDays: number;
  /** Blended strength below which a memory may be put to sleep. */
  minStrength: number;
  /** How many insights one night may write. */
  insights: number;
  /** How far back the insight phase looks for a pattern. */
  insightWindowDays: number;
  /**
   * How many skills one night may write. A memory says what is true; a skill
   * says how something is done, and the night is where the second is
   * distilled out of the first. Zero switches the distillation off and leaves
   * skill writing to the `write_skill` tool alone.
   */
  skills: number;
  /**
   * How many of the day's conversations one night may read in full. A cheap
   * model sorts them first, so this caps only the expensive half: the deep
   * read of the ones that looked like they held something.
   */
  replaySessions: number;
  /**
   * How many skills one night may rewrite. Deliberately larger than
   * `skills`: a procedure that has gone wrong costs more than a procedure
   * that was never written, so repair outranks invention and runs first.
   * Zero switches the revision pass off.
   */
  skillRevisions: number;
  /**
   * How often the three stages repeat in one night. More than one because
   * deep sleep changes what dream sleep has to work with.
   */
  cycles: number;
  /** Upper bound on contradiction decisions per night. */
  maxResolveCalls: number;
  /** An agent bank sleeps only after this many new memories. */
  agentThreshold: number;
  /**
   * Model for condensing and linking. Not the cheapest one on purpose:
   * deciding that two sentences mean the same thing, and writing the one
   * sentence that replaces both, is a judgement call. A weak model merges
   * things that do not belong together. Empty falls back to the provider's
   * small default.
   */
  model: string;
  /**
   * Model for the single nightly insight call. It is the hardest thing the
   * system does and it happens once a night, so it is worth paying for.
   * Empty means "same as `model`".
   */
  insightModel: string;
}

/**
 * Computer control: the assistant sees the screen and works mouse and
 * keyboard through a second MCP server. Off by default; the user switches
 * it on, never the assistant.
 */
export const COMPUTER_PROFILES = ['core', 'ax', 'scripting', 'windows-admin', 'full'] as const;
/** How much authority the zavora engine gets: observation and input up to scripting and admin. */
export type ComputerProfile = (typeof COMPUTER_PROFILES)[number];

/** Who gets a tool server or a skill: the assistant, the agents, or both. */
export type ToolServerAudience = 'assistant' | 'agents' | 'both';

/** One MCP server in the hub: a catalogue entry the user configured, or a custom one. */
export interface ToolServerConfig {
  /** Catalogue id, or `custom-<slug>`. */
  id: string;
  enabled: boolean;
  audience: ToolServerAudience;
  /** Catalogue option values, e.g. the computer profile or the browser. */
  options: Record<string, string>;
  /** Environment for the server process: API keys and the like. */
  env: Record<string, string>;
  /** Custom servers only: how to start it and what to tell the model. */
  custom?: { name: string; command: string; args: string[]; hint: string };
  /**
   * Project ids this server is limited to. Empty or unset: every project
   * (and the workspace), the behaviour before this field existed.
   */
  projectIds?: string[];
}

export interface ToolsConfig {
  servers: ToolServerConfig[];
}

/**
 * The locally managed `claude-code-router` process. Only started when at
 * least one enabled `ProviderProfile` has `via: 'router'`.
 */
export interface RouterConfig {
  enabled: boolean;
  /** Defaults to the router's own default port, 3456. */
  port?: number;
}

/**
 * What Rookery takes over from the Claude Code installed beside it.
 *
 * Claude Code already carries a curated set of skills, plugins and MCP
 * servers on this machine, and Rookery runs on its session anyway. This
 * block is the consent layer in front of that: reading is always safe, but a
 * skills shelf of three hundred entries and a server that starts a process
 * are not things that arrive unannounced. Rookery never writes back into
 * `~/.claude`.
 */
/**
 * One decision about something found in that installation. The fingerprint is
 * taken over the definition at the moment of approval, so anything edited in
 * `~/.claude` afterwards goes inactive until a person looks at it again - the
 * rule `servers` already follows, spelled out once for everything else.
 */
export interface ExternalApproval {
  enabled: boolean;
  audience: ToolServerAudience;
  fingerprint: string;
}

export interface ExternalConfig {
  /** Look at that installation at all. */
  enabled: boolean;
  /**
   * Source id (`claude-code:home`, `claude-code:plugin/ecc@ecc`) to whether
   * its skills are available. A source nobody decided about follows the
   * default in `sourceEnabled`: Claude Code's own folder yes, a plugin no.
   */
  skillSources: Record<string, boolean>;
  /**
   * Discovered MCP server id to what was decided about it. The fingerprint is
   * over the start definition at the time of approval, so an edit in Claude
   * Code's own configuration takes the server out of service until a person
   * looks at it again.
   */
  servers: Record<string, { enabled: boolean; audience: ToolServerAudience; projectIds?: string[]; fingerprint: string }>;
  /**
   * Discovered subagent id (`<sourceId>/<name>`) to what was decided about
   * it. Nothing is on until somebody says so: a subagent carries a system
   * prompt and a tool list into a turn Rookery otherwise composes itself.
   */
  agents: Record<string, ExternalApproval>;
  /**
   * Hook-set id to what was decided about it. Off everywhere by default and
   * meant to stay that way for agents: a hook is a command line that runs
   * around every tool call of an unattended run, so it is approved per source
   * *and* per audience, and the assistant gets the first try, not the agents.
   */
  hooks: Record<string, ExternalApproval>;
  /**
   * Source id to the "load the whole plugin" switch, for a plugin that is
   * trusted outright. With `loadWhole` on, the source is handed to the CLI as
   * a plugin directory and its curated skills, agents and hooks are *not*
   * passed a second time.
   */
  plugins: Record<string, ExternalApproval & { loadWhole: boolean }>;
}

/** The `ask_user` tool: how long a question stays open. */
export interface QuestionsConfig {
  /**
   * Milliseconds a question waits before it resolves itself as unanswered
   * and the turn carries on. Has to stay well under the provider's own MCP
   * tool timeout (six hours for Claude Code), or the call the question is
   * blocking dies before the question can give up.
   */
  timeoutMs: number;
}

export interface OrgConfig {
  /** Provider processes that may run assignments at the same time. */
  maxConcurrentAssignments: number;
  /** How deep delegation chains may nest below the assistant. */
  maxDelegationDepth: number;
  /** Hard stop for a single assignment, in milliseconds. */
  assignmentTimeoutMs: number;
  /**
   * Put the Ponytail ruleset (org/ponytail.ts) into every agent's system
   * prompt: understand the problem, then stop at the first rung of the
   * laziness ladder that holds. Costs roughly 600 tokens per run and pays for
   * itself on anything that writes code. Off leaves agents to their own
   * judgement.
   */
  lazyCoding: boolean;
  /**
   * Jarvis's own judgment of every finished assignment, one model call in
   * the background (agent-performance-management, phase 2). On by default;
   * off leaves only the automatic `system` review that hard failures write
   * with no model call at all.
   */
  autoReview: boolean;
  /**
   * On, a mail-born run writes its result as a letter in the agent's own
   * voice instead of a report (decision E10, section 6.3). Off restores
   * today's report register everywhere, unconditionally. Global, not
   * per-agent (decision E6/F6): the tone is a property of the company.
   */
  roleplay: boolean;
  /** Explicitly chosen company; the newest one otherwise. */
  activeOrganizationId?: string;
}

/* ------------------------------------------------------------------ *
 * Listeners
 * ------------------------------------------------------------------ */

/**
 * What a listener watches. Only mailboxes so far.
 *
 * A listener is the other half of an event-driven schedule: it holds one
 * connection open, waits for something to happen, and fires a schedule when
 * it does. Where a gateway carries a conversation, a listener carries a
 * single fact - "something changed" - and the schedule decides what that is
 * worth.
 */
export type ListenerKind = 'imap';

export interface ListenersConfig {
  /** Mailboxes watched over IMAP, one entry per account. */
  imap: ImapListenerConfig[];
}

/**
 * One watched mailbox.
 *
 * IMAP has no webhook and never will; what it has is IDLE, a connection the
 * server holds open and speaks into the moment mail arrives. That is why this
 * is a listener rather than a schedule: the waiting costs one socket, not one
 * model call every few minutes.
 */
export interface ImapListenerConfig {
  /** Stable name, chosen by whoever adds it; runs record it as `imap:<id>`. */
  id: string;
  /** Off by default: this holds a password and opens a connection. */
  enabled: boolean;
  host: string;
  port: number;
  /** TLS from the first byte, the usual 993. Off means STARTTLS on 143. */
  secure: boolean;
  user: string;
  /**
   * The mailbox password. It lives here for the same reason the bot token
   * does (see `TelegramGatewayConfig.token`): local user state a person must
   * be able to set from the page that exists to set it.
   *
   * It must never reach a browser. `publicConfig` blanks it on the way out,
   * and a listener's status reports only whether one is present.
   */
  password: string;
  /** Which mailbox to watch. */
  mailbox: string;
  /** The schedule this listener fires when something arrives. */
  jobId: string;
}

/** Which chat gateway a config section belongs to. Only Telegram for now. */
export type GatewayId = 'telegram';

export interface GatewaysConfig {
  telegram: TelegramGatewayConfig;
}

export interface TelegramGatewayConfig {
  /** Channel on/off. */
  enabled: boolean;
  /**
   * The bot token from BotFather. It lives here, beside `RookeryConfig.token`
   * and under the same file permissions, rather than in an environment file:
   * both are local user state, and a channel that can only be set up by
   * editing a dotfile and restarting cannot be set up from the page that
   * exists to set it up. `TELEGRAM_BOT_TOKEN` still wins where it is set, for
   * headless installs.
   *
   * It must never reach a browser. `publicConfig` blanks it on the way out,
   * exactly as it drops the bearer token, and `GatewayStatus` reports only
   * whether one is present and where it came from.
   */
  token: string;
  /**
   * Numeric Telegram user ids allowed to talk to the assistant through this
   * gateway. Empty means off, on purpose: there is no "everyone" option,
   * because a bot token that ends up in the wrong hands must not become an
   * open door into the assistant.
   */
  allowedUserIds: number[];
  /**
   * Pairing mode: run the poller with an empty allowlist so `/id` can answer.
   *
   * Without it the first setup is a closed loop - the allowlist needs a
   * number, the number comes from asking the bot, and the bot does not listen
   * until the allowlist has a number in it. While this is on, every message
   * still fails the guard as `not_allowed`; the single thing that comes back
   * is the sender's own id, which tells them nothing they did not already
   * know. What it does cost is the silence: a stranger who found the bot
   * learns it is alive. Hence a switch the user throws on purpose, off by
   * default, and cleared again as soon as the first id is allowed.
   */
  pairing: boolean;
  /** Rights for turns that arrive through this channel. */
  permission: PermissionLevel;
  model?: string;
  /**
   * Photos, voice notes, documents: taken in and handed to the turn, or
   * dropped in silence the way everything non-textual used to be. Off is the
   * cautious setting, not the safe one - what arrives is still only ever a
   * file the allowlist itself sent.
   */
  media: boolean;
  /** Which engine turns a voice note into words. See `TranscribeEngine`. */
  transcribe: TranscribeEngine;
  /**
   * The local Whisper model, used by `local` and as `auto`'s last resort.
   * `base` is the balance that holds on a laptop; `small` hears more and
   * takes about four times as long.
   */
  transcribeModel: string;
  /**
   * Largest attachment accepted, in MB. Telegram's own bot download ceiling
   * is 20 MB, so anything above that is a promise the Bot API cannot keep.
   */
  maxAttachmentMb: number;
  /**
   * Write the answer as it is produced, by rewriting one message, instead of
   * sending it whole at the end. Telegram has no streaming of its own; this
   * is `editMessageText` on a timer, and the timer is why it can be switched
   * off - a slow line or a rate-limited account is better served by one
   * message that arrives once.
   */
  stream: boolean;
  push: TelegramPushConfig;
}

/**
 * Where speech becomes text.
 *
 *   auto        - a configured key first (OpenAI, then ElevenLabs), the local
 *                 model when there is none or the key fails. The default, and
 *                 the only value that cannot end in "no engine available".
 *   local       - Whisper on this machine through `@huggingface/transformers`.
 *                 No key, no account, no audio leaving the house; the model is
 *                 fetched once and cached under `<home>/models`.
 *   openai      - gpt-4o-mini-transcribe. Needs the OpenAI key the voice page
 *                 already stores.
 *   elevenlabs  - Scribe v1. Needs the ElevenLabs key.
 *   off         - a voice note arrives as a file and nothing more.
 */
export type TranscribeEngine = 'auto' | 'local' | 'openai' | 'elevenlabs' | 'off';

/**
 * What kind of file came in. The distinction is not cosmetic: it decides
 * whether the turn gets a transcript (anything with a sound track), a path
 * to look at (a photo), or a path to open (a document).
 */
export type GatewayAttachmentKind =
  | 'photo'
  | 'voice'
  | 'audio'
  | 'video'
  | 'video_note'
  | 'animation'
  | 'document'
  | 'sticker';

/**
 * One file hanging off an incoming message, as the guard reports it.
 *
 * Still only a reference: `fileId` is Telegram's handle, and nothing has
 * been downloaded at this point. Every field beyond the id and the kind is
 * optional because it comes from foreign JSON - a missing `mime` is normal,
 * a missing `size` means Telegram did not say, and neither may be asserted.
 */
export interface GatewayAttachment {
  kind: GatewayAttachmentKind;
  fileId: string;
  /** Stable across bots and re-sends; the key for "this is the same file". */
  uniqueId?: string;
  mime?: string;
  fileName?: string;
  /** Bytes, as Telegram reports them. */
  size?: number;
  /** Seconds, for anything with a sound track. */
  duration?: number;
}

export interface TelegramPushConfig {
  enabled: boolean;
  assignments: boolean;
  cron: boolean;
  sleep: boolean;
  tasks: boolean;
  /** Mail the user is To or Cc on, pushed to the phone. See `mailFrom`. */
  mail: boolean;
  /**
   * The running commentary the web app shows as toasts: a memory stored, a
   * skill written, an agent or a project saved. Off by default - this is a
   * line per thing that happens, and the phone is not a log viewer - but on
   * it is the closest thing to watching over the assistant's shoulder.
   */
  activity: boolean;
  /**
   * Every tool the assistant reaches for, one short line each, batched.
   * Louder than `activity` by an order of magnitude, and never buffered:
   * when it is quiet hours these are dropped rather than delivered later,
   * because a tool call from this morning is not news.
   */
  tools: boolean;
  /**
   * Which senders a mail push is worth it for. 'assistant' is the quiet
   * default: the assistant is the only one who writes to the user on their
   * own initiative anyway. 'leads' adds the agents named as a team's lead,
   * so a team reaches the user through one voice; 'all' pushes every mail
   * that lands in the user's mailbox, which is what the web inbox is for.
   */
  mailFrom: 'assistant' | 'leads' | 'all';
  /** "22:00"; empty means no quiet hours. */
  quietFrom: string;
  /** "08:00" */
  quietUntil: string;
  maxPerHour: number;
  /** Subset of allowedUserIds; empty falls back to the first allowed id. */
  recipients: number[];
}

/**
 * The assistant's own initiative to reach the user: something worth saying
 * without a conversation running. Carried from the `notify` tool through
 * `Assistant`'s event stream to whatever channel is listening - Telegram
 * push, today - which decides how (and whether quiet hours apply); nothing
 * in core ever sends it anywhere itself.
 */
export interface NotifyEvent {
  text: string;
  urgency: 'normal' | 'high';
  at: number;
}

/**
 * Where spoken answers are synthesised.
 *
 *   browser     - the browser's own speechSynthesis; no server round trip.
 *   edge        - Microsoft Edge neural voices, via the server. Free, no key.
 *   elevenlabs  - ElevenLabs, needs ELEVENLABS_API_KEY in the server's env.
 *   openai      - OpenAI gpt-4o-mini-tts, needs OPENAI_API_KEY in the env.
 */
export type VoiceEngine = 'browser' | 'edge' | 'elevenlabs' | 'openai';

export interface VoiceConfig {
  enabled: boolean;
  /** Spoken wake word for hands-free mode in the web UI. */
  wakeWord: string;
  /** BCP-47 tag for speech recognition and synthesis. */
  lang: string;
  /** Preferred SpeechSynthesis voice name; empty picks the best local match. */
  voiceName: string;
  rate: number;
  pitch: number;
  /** Strip code blocks and markdown before speaking. */
  speakCleanText: boolean;
  /** Which synthesiser produces the voice. */
  engine: VoiceEngine;
  /** Edge neural voice short name, e.g. `en-GB-RyanNeural`. */
  edgeVoice: string;
  /** ElevenLabs voice id; empty falls back to the library's default voice. */
  elevenLabsVoiceId: string;
  /** ElevenLabs model: v2 for quality, flash for latency, v3 for expressiveness. */
  elevenLabsModel: 'eleven_multilingual_v2' | 'eleven_flash_v2_5' | 'eleven_v3';
  /** OpenAI voice name, e.g. `onyx`. */
  openaiVoice: string;
  /** Light EQ and comms-style slapback on playback, for the Jarvis feel. */
  jarvisEffect: boolean;
  /** How spoken answers are phrased: plain, or the composed butler register. */
  style: 'neutral' | 'jarvis';
}
