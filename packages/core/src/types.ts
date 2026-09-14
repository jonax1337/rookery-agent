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
  /** Token/cost accounting, when the provider reported it. */
  usage?: TurnUsage;
}

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
  /** The provider started or finished running one of its own tools. */
  | { type: 'tool'; name: string; status: 'start' | 'end'; detail?: string; id?: string; result?: string; isError?: boolean }
  /** Rookery-level progress: memory recall, delegation, lifecycle. */
  | { type: 'status'; label: string; detail?: string }
  /** A memory record was written or recalled. */
  | { type: 'memory'; action: 'recalled' | 'stored'; count: number; items?: MemoryRecord[] }
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
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; text: string; usage?: TurnUsage; providerSessionId?: string };

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
 */
export type SleepStage = 'replay' | 'light' | 'deep' | 'rem';

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
  /** Small-model calls spent. Capped by config. */
  modelCalls: number;
  /** Two or three sentences a person can read. */
  report?: string;
  error?: string;
  /** Set when the run was rolled back. */
  undoneAt?: number;
}

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

export type TaskStatus = 'open' | 'planned' | 'running' | 'done' | 'failed' | 'cancelled';
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
/** Whether the clock started a run or somebody pressed "run now". */
export type CronTrigger = 'schedule' | 'manual';

/**
 * A standing order: a prompt that runs on a cron schedule while the server
 * is up. Times are the machine's local time; a five-field expression such as
 * `0 8 * * 1-5` (weekdays at 08:00).
 */
export interface CronJob {
  id: string;
  orgId: string;
  name: string;
  /** Five-field cron expression, normalised. */
  schedule: string;
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
}

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
  /** The MCP hub: which servers run for whom. */
  tools: ToolsConfig;
  /** What is taken over from the Claude Code installed here. */
  external: ExternalConfig;
  /** Where skills live, one folder per skill. Defaults to `<home>/skills`. */
  skillsDir: string;
  /** Alternative backends for the `claude` binary. Empty by default: opt-in per provider. */
  providerProfiles: ProviderProfile[];
  /** The Rookery-managed `claude-code-router` process, used by `via: 'router'` profiles. */
  router: RouterConfig;
  /** Name the assistant answers to, used in the persona and as wake word base. */
  assistantName: string;
  userName?: string;
  /** Address the user formally: German "Sie", never "du"; formal register elsewhere. */
  formalAddress: boolean;
  /** What the assistant calls the user now and then, e.g. "Master" or "Sir". Empty: the name. */
  honorific: string;
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

export interface SleepConfig {
  enabled: boolean;
  /** Five-field cron expression for the nightly run. */
  schedule: string;
  /** Which banks sleep: only the assistant's, or every agent's too. */
  scope: 'assistant' | 'all';
  /** Upper bound on condensation calls per night. */
  maxMergeCalls: number;
  /** Untouched for this long and weak enough, a memory goes dormant. */
  dormantAfterDays: number;
  /** Blended strength below which a memory may be put to sleep. */
  minStrength: number;
  /** How many insights one night may write. */
  insights: number;
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
  /** Explicitly chosen company; the newest one otherwise. */
  activeOrganizationId?: string;
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
