/**
 * Mirror of the @rookery/core contract.
 *
 * These are copied rather than imported: core is a Node package (node:sqlite,
 * child_process) and must never end up in the browser bundle. Keep this file
 * in sync with packages/core/src/types.ts.
 */

/** 'claude' (Claude login) and 'codex' (ChatGPT) are built in; any other id names a configured ProviderProfile. */
export type ProviderId = string;
export type Role = 'user' | 'assistant' | 'system';
export type PermissionLevel = 'chat' | 'read' | 'write' | 'full';
export type MemoryKind = 'fact' | 'preference' | 'project' | 'event' | 'summary' | 'insight';
export type MemoryOrigin = 'extract' | 'user' | 'sleep';

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  durationMs?: number;
  /** Tokens in the model's context on the turn's last request. */
  contextTokens?: number;
  /** The model's context window, when the provider reports it. */
  contextWindow?: number;
}

/**
 * One segment of an assistant answer in arrival order - the interleaved
 * transcript the original Claude Code window shows.
 *
 * Mirror of `MessageBlock` in packages/core/src/types.ts: the web cannot
 * import core (a Node package), so the JSON shape is copied and must stay
 * wire-compatible. `content`/`toolCalls` remain the flat compatibility view
 * written beside it; old rows without `blocks` fall back to it.
 */
export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; call: Extract<AgentEvent, { type: 'tool' }> }
  | { type: 'memory'; memories: RecalledMemory[]; turnId?: string };

/**
 * One memory as an answer keeps it: the id a feedback click posts against and
 * the sentence its row shows - not the whole `MemoryRecord`, because this is
 * stored on every answer that recalled anything.
 *
 * A type alias rather than an interface: the card reaches assistant-ui as a
 * message part whose `args` must be `ReadonlyJSONValue`, and only an alias
 * gets the implicit index signature that assignment needs.
 */
export type RecalledMemory = {
  id: string;
  content: string;
};

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  /** Provider tool events retained with the answer, including interrupted calls. */
  toolCalls?: Extract<AgentEvent, { type: 'tool' }>[];
  /** The ordered transcript, when the turn produced one. Old rows have none. */
  blocks?: MessageBlock[];
  provider?: ProviderId;
  model?: string;
  agent?: string;
  createdAt: number;
  usage?: TurnUsage;
}

/**
 * `voice` sessions belong to the hands-free screen and answer in its register.
 *
 * `mail` is the transcript of one answered mail and `schedule` the transcript
 * of one cron run, neither a thread anyone continues, so the server leaves
 * both out of every list that does not ask for them by name - they never
 * reach the conversations page.
 */
export type SessionKind = 'chat' | 'voice' | 'mail' | 'schedule';

export interface Session {
  id: string;
  title: string;
  kind: SessionKind;
  provider: ProviderId;
  model?: string;
  cwd: string;
  /** Project the conversation is about; assignments default to it. */
  projectId?: string;
  /**
   * The agent this conversation is with. Unset means the assistant. A session
   * keeps its counterpart for life, like a direct message thread.
   */
  agentId?: string;
  providerSessionId?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messageCount: number;
}

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  tags: string[];
  importance: number;
  /** Whose memory this is: `assistant`, or an agent id. */
  owner: string;
  /**
   * The words this memory stands on, quoted from what the user actually
   * wrote. Extraction cannot store anything without one; rows written by hand
   * and rows the night condensed have none.
   */
  evidence?: string;
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  forgotten: boolean;
  /** Who wrote it. `user` is protected from the nightly clean-up. */
  origin: MemoryOrigin;
  pinned: boolean;
  /** Asleep since: out of recall, still listed and one click from waking. */
  dormantAt?: number;
  /** The condensed memory that took this one's place. */
  supersededBy?: string;
  sleepRunId?: string;
  /** 0..1, from actual recalls rather than from being written again. */
  usefulness: number;
}

export interface ScoredMemory extends MemoryRecord {
  score: number;
  reason: string;
  /** Reached directly, or through a shared entity or an edge. */
  hop?: 'direct' | 'entity' | 'edge';
}

/* ------------------------------ memory graph ------------------------------ */

export type EntityKind = 'person' | 'project' | 'tool' | 'place' | 'org' | 'topic';

export interface MemoryEntity {
  id: string;
  owner: string;
  name: string;
  slug: string;
  kind: EntityKind;
  mentions: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export type MemoryRelation = 'refines' | 'supersedes' | 'contradicts' | 'caused_by' | 'co_occurs';

export interface MemoryEdge {
  id: string;
  owner: string;
  srcId: string;
  dstId: string;
  relation: MemoryRelation;
  weight: number;
  origin: 'sleep' | 'user' | 'gate';
  runId?: string;
  createdAt: number;
}

export interface MemoryGraph {
  entities: MemoryEntity[];
  memories: MemoryRecord[];
  edges: MemoryEdge[];
  links: { memoryId: string; entityId: string }[];
  truncated: boolean;
}

export interface MemoryNeighbourhood {
  memory: MemoryRecord;
  entities: MemoryEntity[];
  outgoing: (MemoryEdge & { other: MemoryRecord })[];
  incoming: (MemoryEdge & { other: MemoryRecord })[];
}

/* --------------------------------- sleep --------------------------------- */

export type SleepStatus = 'running' | 'done' | 'failed';

export interface SleepRun {
  id: string;
  owner: string;
  trigger: 'schedule' | 'manual';
  status: SleepStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  readCount: number;
  /** Conversations the night read again in full. */
  replayedCount: number;
  /** Memories those conversations yielded that the day had missed. */
  learnedCount: number;
  mergedCount: number;
  dormantCount: number;
  edgeCount: number;
  insightCount: number;
  /** Skills the night wrote out of what the bank kept repeating. */
  skillCount: number;
  /** Skills the night rewrote because their ground moved, or a run using them failed. */
  skillRevisedCount: number;
  conflictCount: number;
  resolvedCount: number;
  modelCalls: number;
  /**
   * The five dream counters, exactly as `SleepRun` in `packages/core/src/types.ts`
   * declares them: optional there because the runs written before schema 21 / 24
   * have no column for them, and optional here for the same reason. A night from
   * an older database answers `undefined`, which is not the same claim as zero -
   * the table and the report draw them through `formatNumber(value ?? 0)` only
   * where the column itself says what it counts.
   */
  dreamTracesSeen?: number;
  dreamFramesScored?: number;
  dreamCandidates?: number;
  dreamPromoted?: number;
  dreamLabelsWritten?: number;
  report?: string;
  error?: string;
  undoneAt?: number;
}

/**
 * The nightly clean-up's settings, exactly as `config.memory.sleep` in core.
 *
 * `GET /api/sleep/status` hands this object straight out, so it is the same
 * shape in both places and is declared once.
 */
export interface SleepConfig {
  enabled: boolean;
  /** Five-field cron expression for the nightly run. */
  schedule: string;
  /** Which banks sleep: only the assistant's, or every agent's too. */
  scope: 'assistant' | 'all';
  /** Hard cap on the night's expensive model calls; phases are funded by measured demand. */
  nightBudget: number;
  maxMergeCalls: number;
  maxResolveCalls: number;
  maxLinkCalls: number;
  dormantAfterDays: number;
  minStrength: number;
  insights: number;
  /** How far back the insight phase looks for a pattern. */
  insightWindowDays: number;
  /** How many of the day's conversations one night may read in full. */
  replaySessions: number;
  /** How many skills one night may distil out of the bank. */
  skills: number;
  /** How many skills one night may rewrite. Repair outranks invention. */
  skillRevisions: number;
  cycles: number;
  /** An agent bank sleeps only after this many new memories. */
  agentThreshold: number;
  model: string;
  /** Empty means "same as `model`". */
  insightModel: string;
}

/** What `GET /api/sleep/status` answers. */
export interface SleepStatusView {
  owner: string;
  running: boolean;
  activeOwners: string[];
  lastRun: SleepRun | null;
  schedule: CronJob | null;
  config: SleepConfig;
}

/* --------------------------------- dream ---------------------------------- */

/**
 * The dream's own shapes, as `routes/dream.ts` hands them out.
 *
 * Every one of these mirrors a declaration in `packages/core/src/types.ts`
 * field for field; the server maps the rows and answers with numbers and this
 * vocabulary, never with a word of the frames behind them (concept E19). They
 * are optional-heavy on purpose: a version nobody has measured yet carries no
 * score, and a slot nobody has promoted in carries no state but its own name.
 */

/** The three recall-family slots a policy exists for (concept 7.1). */
export type DreamSlot = 'recall' | 'budget' | 'retry';

/** The four causes a slot can be frozen for (concept 10.3). */
export type DreamSlotFreezeReason = 'calibration' | 'staleness' | 'agreement' | 'manual';

/** Factory default, a user override, or a promotion the night made. */
export type PolicyOrigin = 'default' | 'user' | 'dream';

/**
 * One versioned parameter set for one slot.
 *
 * Read the row by its numbers, the way the route's own comment does:
 * `promotedAt` set and `retiredAt` unset is in force; `replayScore` set and
 * not promoted is measured and passed over; `replayScore` unset is a proposal
 * nobody has measured yet.
 */
export interface PolicyVersion {
  id: string;
  owner: string;
  slot: DreamSlot;
  version: number;
  /** Full parameter set for `slot`; the shape depends on which slot this is. */
  params: Record<string, unknown>;
  box: Record<string, unknown>;
  origin: PolicyOrigin;
  parentId?: string;
  /** What was in force right before this was promoted - what a revert restores. */
  prevActiveId?: string;
  sleepRunId?: string;
  rationale?: string;
  /** Score on the held-out half, 0..1. Unset: never measured. */
  replayScore?: number;
  replayN?: number;
  baselineScore?: number;
  /** Against the factory default, on the frozen audit set. */
  auditDelta?: number;
  auditCiLow?: number;
  onlineScore?: number;
  promotedAt?: number;
  retiredAt?: number;
  createdAt: number;
}

/** Whether a slot still promotes, and when it may do so again. */
export interface DreamSlotState {
  owner: string;
  slot: DreamSlot;
  frozenAt?: number;
  frozenReason?: DreamSlotFreezeReason;
  cooldownUntil?: number;
  lastPromoted?: number;
}

/** One row of `GET /api/dream/policies`: a slot, what is in force, its state. */
export interface DreamSlotView {
  slot: DreamSlot;
  /** `null` until the slot's first promotion - the normal case. */
  active: PolicyVersion | null;
  state: DreamSlotState;
}

/**
 * One evaluation: the paired delta against the incumbent, its validity
 * certificate (concept 5.4) and whether it led to a promotion.
 */
export interface DreamEval {
  id: string;
  sleepRunId: string;
  policyId: string;
  slot: DreamSlot;
  /** Traces offered. */
  traces: number;
  /** Traces closed and scored. */
  closed: number;
  abstained: number;
  abstainReasons: Record<string, number>;
  reachableRate: number;
  labelCoverage: number;
  costOnlyShare: number;
  score: number;
  baseline: number;
  delta: number;
  /** Cluster bootstrap over sessions, 95 percent, reported as approximated. */
  ciLow: number;
  ciHigh: number;
  auditDelta?: number;
  auditCiLow?: number;
  deltaLive?: number;
  /** `null` is a value, not a gap: the sign comparison was undetermined. */
  signAgree: boolean | null;
  evalMs: number;
  traceSetHash: string;
  evidenceDigest?: string;
  promoted: boolean;
  detail?: Record<string, unknown>;
  createdAt: number;
}

/**
 * What `POST /api/dream/policies/:id/revert` answers, field for field the
 * `RevertResult` of `memory/dream/promote.ts`.
 *
 * `restored: null` with `ok: true` is an outcome, not a failure: the reverted
 * promotion was the first one in its slot, so what comes back into force is
 * the configured default rather than an older version.
 */
export interface PolicyRevertResult {
  ok: boolean;
  /** The version that was in force and no longer is. */
  retired: PolicyVersion | null;
  /** What `prevActiveId` pointed at, back in force. `null` when there was none. */
  restored: PolicyVersion | null;
  /** Why nothing happened. Empty exactly when `ok`. */
  findings: string[];
}

/* ------------------------------ organisation ------------------------------ */

/** The company the assistant runs. There is exactly one active one. */
export interface Organization {
  id: string;
  name: string;
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
  /** Whether this project's own `.mcp.json` may start processes. Unset: not yet decided. */
  mcpTrust?: { fingerprint: string; approvedAt: number };
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface ProjectMcpServer {
  name: string;
  command: string;
  args: string[];
}

/** GET /api/org/projects/:id/mcp */
export interface ProjectMcpInfo {
  status: 'none' | 'pending' | 'trusted' | 'changed';
  servers: ProjectMcpServer[];
}

export interface Team {
  id: string;
  orgId: string;
  name: string;
  purpose?: string;
  leadId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  title: string;
  instructions: string;
  /** Two to four sentences on HOW this person writes. Never steers the work; only colours mail. */
  voice?: string;
  teamId?: string;
  managerId?: string;
  provider?: ProviderId;
  model?: string;
  permission?: PermissionLevel;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export type AssignmentStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type RequesterKind = 'user' | 'assistant' | 'agent';

export interface Assignment {
  id: string;
  orgId: string;
  agentId: string;
  projectId?: string;
  sessionId?: string;
  parentId?: string;
  requesterKind: RequesterKind;
  requesterAgentId?: string;
  /** What this run is called; a run of a task carries that task's name. */
  title: string;
  task: string;
  status: AssignmentStatus;
  result?: string;
  error?: string;
  provider?: ProviderId;
  model?: string;
  chars: number;
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
  preview?: string;
  /** The most recent tool call this run made, for a live activity view. */
  lastActivity?: { kind: 'tool' | 'status'; label: string; at: number };
  durationMs?: number;
  error?: string;
}

/**
 * One line of a running assignment's live log, as `GET /api/org/assignments/:id/log`
 * and the `assignment-log` frames carry it. `seq` stays monotone over the whole
 * run - including the reset a provider switch performs - so a client can merge
 * a snapshot against later frames without ever assuming continuity: a gap in
 * seq means overflow, never wire loss.
 */
export interface AssignmentLogEntry {
  seq: number;
  event: AgentEvent;
}

/** What the log endpoint answers while the run holds its buffer. */
export interface AssignmentLogSnapshot {
  events: AssignmentLogEntry[];
  /** True once the oldest whole entries were dropped to stay under the cap. */
  overflowed: boolean;
  /** Whether more is coming: a journalled run answers after its end too. */
  active: boolean;
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
 * What a mail thread *is*, decided once when the thread is created and
 * inherited by every reply - the protocol layer that routes mail into the
 * fixed folders: `assignment` threads are work orders, `report` threads are
 * run results, `chat` is everything else.
 */
export type MailThreadKind = 'chat' | 'assignment' | 'report';

/** The thread row behind one `threadId`, as the server joins it in. */
export interface MailThread {
  threadId: string;
  orgId: string;
  kind: MailThreadKind;
  taskId?: string;
  archivedAt?: number;
  createdAt: number;
}

/**
 * The fixed inbox folders, the same for every mailbox. `outbox` is not one
 * of them - what you sent is routed by sender, not by what the thread is.
 */
export type MailFolder = 'inbox' | 'tasks' | 'reports' | 'archiv' | 'outbox';

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
  /** The thread's kind, joined in from the server's thread table. */
  threadKind?: MailThreadKind;
  /** Set when the thread is an assignment with a task on the board. */
  taskId?: string;
  taskTitle?: string;
  /** Set when the whole thread has been archived. */
  threadArchivedAt?: number;
}

/* ----------------------------------- tasks ---------------------------------- */

/** `blocked` is a task whose run ended with a question and waits for an answer. */
export type TaskStatus = 'open' | 'planned' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high';

/**
 * A task on the company board.
 *
 * Tasks track work before and after it runs; assignments are the runs
 * themselves. A task can be planned into subtasks, each given to one agent,
 * and executed in dependency order.
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

export interface PlannedSubtask {
  title: string;
  description: string;
  /** Agent slug. */
  agent: string;
  /** Indices into the subtask list that must finish first. */
  dependsOn: number[];
}

/** What the planner decided for one task. */
export interface TaskPlan {
  mode: 'single' | 'split';
  reason: string;
  /** Agent slug, for `single`. */
  assignee?: string;
  subtasks: PlannedSubtask[];
}

/** GET /api/org/tasks/:id */
export interface TaskDetail {
  task: Task;
  children: Task[];
  assignee: Agent | null;
  assignment: Assignment | null;
  /** The mail thread the task was born in, when it arrived as an assignment mail. */
  thread: MailThread | null;
}

/** POST /api/org/tasks/:id/plan */
export interface TaskPlanResult {
  plan: TaskPlan;
  task: Task;
  children: Task[];
}

/* ------------------------------- schedules ------------------------------- */

/**
 * `sleep` is the system's own row: `ensureSleepSchedule` keeps exactly one of
 * them, it carries no prompt a person wrote, and it must not be offered for
 * deletion in the schedules table.
 */
export type CronJobKind = 'assistant' | 'agent' | 'sleep' | 'script';
export type CronRunStatus = 'running' | 'done' | 'failed';
export type CronTrigger = 'schedule' | 'manual' | 'event';

/**
 * Whether the clock fires this job at all. `event` means it has no timetable
 * and `schedule` may be empty; an event can fire either mode, so a job on the
 * clock keeps its expression as a backstop.
 */
export type CronTriggerMode = 'schedule' | 'event';

/** A standing order: a prompt that fires on a cron expression while the server runs. */
export interface CronJob {
  id: string;
  orgId: string;
  name: string;
  /** Five-field cron expression, local time. Empty for an event-only job. */
  schedule: string;
  triggerMode: CronTriggerMode;
  /**
   * The per-job webhook secret. Unlike every other secret in this app it does
   * reach the browser: the URL is useless to anyone who cannot already read
   * this page, and there is nowhere else to copy it from.
   */
  webhookToken?: string;
  /** The rest after a run; events arriving inside it collapse into one run. */
  eventCooldownMs?: number;
  kind: CronJobKind;
  script?: { path: string; runtime: 'python' | 'node' | 'bash' | 'powershell'; noAgent?: boolean };
  remainingRuns?: number;
  prompt: string;
  agentId?: string;
  projectId?: string;
  /** The assistant's conversation for this job, reused across runs. */
  sessionId?: string;
  permission?: PermissionLevel;
  enabled: boolean;
  once: boolean;
  createdBy: RequesterKind;
  createdAt: number;
  updatedAt: number;
  nextRunAt?: number;
  lastRunAt?: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  runCount: number;
}

export interface CronRun {
  id: string;
  jobId: string;
  orgId: string;
  trigger: CronTrigger;
  /** What raised the event, e.g. `webhook` or `imap:work`. Only for `event`. */
  source?: string;
  status: CronRunStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  result?: string;
  error?: string;
  sessionId?: string;
  assignmentId?: string;
}

/** GET /api/cron */
export interface CronOverview {
  jobs: CronJob[];
  runs: CronRun[];
  /** Ids of jobs with a run in flight. */
  running: string[];
}

/** GET /api/cron/:id */
export interface CronJobDetail {
  job: CronJob;
  scriptSource?: string;
  scriptError?: string;
  runs: CronRun[];
  running: boolean;
  agent: Agent | null;
  project: Project | null;
  session: Session | null;
  /** The next few runs, as timestamps. */
  next: number[];
  description: string;
}

/** GET /api/cron/preview */
export interface CronPreview {
  ok: boolean;
  schedule: string;
  description: string;
  next: number[];
  error?: string;
}

/** Everything the company page needs, in one call. */
export interface OrgSnapshot {
  organization: Organization;
  teams: Team[];
  agents: Agent[];
  projects: Project[];
  /** Assignments currently pending or running. */
  active: Assignment[];
}

/** A short reference to another agent - the identity chain, never the full record. */
export interface AgentRef {
  id: string;
  name: string;
  slug: string;
}

/** GET /api/org/agents/:id */
export interface AgentDetail {
  agent: Agent;
  assignments: Assignment[];
  memories: MemoryRecord[];
  reports: Agent[];
  performance: AgentPerformance;
  actions: AgentAction[];
  /** Set when this agent was hired to replace another one. */
  predecessor: AgentRef | null;
  /** Set when this agent was replaced by another one. */
  successor: AgentRef | null;
  /** Set only for a successor: the condensed handover from its predecessor. */
  handover?: string;
}

export type ReviewSource = 'user' | 'assistant' | 'system';

/** A judgment of one assignment, against the agent's own role. */
export interface AgentReview {
  id: string;
  orgId: string;
  agentId: string;
  assignmentId?: string;
  taskId?: string;
  source: ReviewSource;
  overall: number;
  quality?: number;
  completeness?: number;
  reliability?: number;
  communication?: number;
  efficiency?: number;
  comment?: string;
  tags: string[];
  failedRun: boolean;
  createdAt: number;
}

/** The computed, never-materialised view of one agent's standing. */
export interface AgentPerformance {
  average: number | null;
  count: number;
  trend: number | null;
  stage: 0 | 1 | 2 | 3;
  failureRate: number;
  lastReviewAt?: number;
}

export type AgentActionKind = 'note' | 'reconfig' | 'probation' | 'replace';

/** One entry in an agent's personnel record. */
export interface AgentAction {
  id: string;
  orgId: string;
  agentId: string;
  kind: AgentActionKind;
  stage: number;
  reason: string;
  beforeText?: string;
  afterText?: string;
  agentNote?: string;
  handoverText?: string;
  reviewIds: string[];
  decidedBy: 'user' | 'assistant';
  successorAgentId?: string;
  createdAt: number;
}

/** One row of GET /api/org/performance - the company-wide Performance view. */
export interface OrgPerformanceEntry {
  agent: { id: string; name: string; slug: string; title: string };
  performance: AgentPerformance;
  pendingProposal: AgentAction | null;
}

/** GET /api/org/assignments/:id */
export interface AssignmentDetail {
  assignment: Assignment;
  agent: Agent | null;
  children: Assignment[];
  /** The board task this run belongs to, from the durable history, not `assignment_id` scans. */
  taskId: string | null;
  /** At most one per source - the run's own `system` verdict, Jarvis's, the user's. */
  reviews: AgentReview[];
}

/* --------------------------------- events -------------------------------- */

/** One offered answer to a question the assistant asked. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * What came back: indices into the question's `options`, plus a free answer
 * from the "Other" field. At least one of the two is always set.
 */
export interface QuestionAnswer {
  selected: number[];
  text?: string;
  source?: 'web' | 'tui' | 'telegram' | 'api';
  at?: number;
}

export type AgentEvent =
  | {
      type: 'session';
      sessionId: string;
      providerSessionId?: string;
      provider: ProviderId;
      model?: string;
    }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool'; name: string; status: 'start' | 'end'; detail?: string; id?: string; result?: string; isError?: boolean }
  | { type: 'status'; label: string; detail?: string }
  // `turnId` rides the recall so a highlighted row can carry a real turn
  // reference into a feedback label (concept 4.2b, S6); mirrors
  // `packages/core/src/types.ts`'s `AgentEvent`.
  | { type: 'memory'; action: 'recalled' | 'stored'; count: number; items?: MemoryRecord[]; turnId?: string }
  /** An assignment changed state. Rides the turn's stream and the broadcast. */
  | { type: 'assignment'; assignment: AssignmentView }
  /** A message between agents, their manager or the assistant was posted. */
  | { type: 'message'; message: AgentMessage }
  /** Mail was sent - a new mail in someone's inbox or outbox. */
  | { type: 'mail'; mail: Mail }
  /** A task on the board was created or changed state. */
  | { type: 'task'; task: Task }
  /** A schedule was created, edited, deleted, or one of its runs changed state. */
  | { type: 'cron'; job: CronJob; run?: CronRun; deleted?: boolean }
  /** The memory started, advanced through or finished a night's clean-up. */
  | { type: 'sleep'; run: SleepRun; phase?: string; cycle?: number }
  /** The provider reported the account's limit windows during the turn. */
  | { type: 'quota'; quota: ProviderQuota }
  /**
   * The assistant asked something and the turn is waiting on the answer. Any
   * connection may answer - the id is the question's, not the turn's.
   */
  | {
      type: 'question';
      id: string;
      header: string;
      question: string;
      options: QuestionOption[];
      multiSelect: boolean;
      /** Epoch ms after which the question gives up and the turn moves on. */
      expiresAt: number;
    }
  /** The question is over: whoever is showing the card takes it away again. */
  | { type: 'question-closed'; id: string; reason: 'answered' | 'cancelled' | 'expired'; answer?: QuestionAnswer }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'done'; text: string; usage?: TurnUsage; providerSessionId?: string };

/** One rolling limit window of a subscription, as the vendor reports it. */
export interface QuotaWindow {
  kind: string;
  label: string;
  /** 0..100 used. */
  percent: number;
  resetsAt?: string;
}

/** GET /api/providers/:id/usage */
export interface ProviderQuota {
  provider: ProviderId;
  plan?: string;
  windows: QuotaWindow[];
  fetchedAt: number;
  error?: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
}

/** GET/PATCH /api/providers/profiles/:id - never carries the API key itself. */
export interface ProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  defaultModel?: string;
  via: 'direct' | 'router';
  authTokenSet: boolean;
}

export interface RouterConfig {
  enabled: boolean;
  port?: number;
}

/** GET /api/providers/catalog - one row per provider Rookery can set up. */
export interface ProviderCatalogItem {
  id: string;
  name: string;
  description: string;
  /** What the person supplies. Only API keys, now that ChatGPT is built in. */
  needs: 'api-key';
  hint: string;
  /** Whether a profile for it exists at all. */
  configured: boolean;
  authTokenSet: boolean;
}

/** Why the runtime is routing around a provider: its quota is spent. */
export interface UsageBlock {
  reason: 'limit' | 'failure';
  until?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  /** For rendering an id with no hardcoded label, e.g. a profile. */
  displayName: string;
  available: boolean;
  binary: string;
  version?: string;
  authenticated: boolean;
  detail?: string;
  /** Model names this provider accepts, for the picker. */
  models?: string[];
  modelOptions?: ProviderModel[];
  modelsError?: string;
  /** Set while the runtime is routing around this provider for quota. */
  usageBlocked?: UsageBlock | null;
}

/** Reasoning effort ladder, shared by both providers. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type VoiceEngine = 'browser' | 'edge' | 'elevenlabs' | 'openai';

export interface VoiceConfig {
  enabled: boolean;
  wakeWord: string;
  lang: string;
  voiceName: string;
  rate: number;
  pitch: number;
  speakCleanText: boolean;
  engine: VoiceEngine;
  edgeVoice: string;
  elevenLabsVoiceId: string;
  elevenLabsModel: 'eleven_multilingual_v2' | 'eleven_flash_v2_5' | 'eleven_v3';
  openaiVoice: string;
  jarvisEffect: boolean;
  style: 'neutral' | 'jarvis';
}

/** One synthesiser voice, as GET /api/tts/voices lists them. */
export interface TtsVoice {
  id: string;
  name: string;
  lang: string;
  gender: string;
}

export interface TtsCatalogue {
  /** Which engines the server can actually drive right now. */
  engines: Record<VoiceEngine, boolean>;
  edge: TtsVoice[];
  /** Premade voices, plus the account's own library when a key is set. */
  elevenlabs: TtsVoice[];
  openai: TtsVoice[];
}

/** The gate in front of the write path: what may become a memory at all. */
export interface MemoryGateConfig {
  maxPerTurn: number;
  minImportance: number;
  duplicateThreshold: number;
  clusterThreshold: number;
}

/** The second hop: how far recall reaches past a literal match. */
export interface MemoryGraphConfig {
  hopEntity: number;
  hopEdge: number;
  maxNodes: number;
}

/**
 * `GET /api/config` hands out the whole `config.memory`, sub-objects included.
 *
 * `gate`, `graph` and `sleep` are optional here on purpose: the settings page
 * edits only the six flat fields, and `PATCH /api/config` is a deep merge, so
 * a patch that leaves them out must still typecheck as a `MemoryConfig`.
 */
export interface MemoryConfig {
  enabled: boolean;
  recallLimit: number;
  recallThreshold: number;
  autoExtract: boolean;
  workingWindow: number;
  contextBudget: number;
  gate?: MemoryGateConfig;
  graph?: MemoryGraphConfig;
  sleep?: SleepConfig;
  dream?: MemoryDreamConfig;
}

/**
 * The part of `config.memory.dream` the nights page reads (S22/E20).
 *
 * The block carries some thirty more keys; only these reach a label, and a key
 * without a reader has no business in a browser type. The three switches are
 * `false` by default, which is why the dream section's empty state can say
 * "switched off" rather than "nothing here yet" - and why they are switches on
 * that page rather than rows on the settings page, which has no honest label
 * for a number whose effect shows up only in a nightly run.
 */
export interface MemoryDreamConfig {
  /** The whole stage. Off by default. */
  enabled: boolean;
  /** The recorder alone - frames and traces, without the night's probe. */
  record: boolean;
  /** The promotion gate. Off by default: the machine ships, not its start. */
  promote: boolean;
  /** Which slots the candidate loop runs for at all. */
  slots?: DreamSlot[];
  /** Share of eligible turns the recorder frames, 0..1. */
  frameRate?: number;
  /** Candidates the writer proposes per slot per night. */
  candidates?: number;
  /** The model that writes them. Never the cheap one: this is judgement. */
  model?: string;
}

export interface OrgConfig {
  maxConcurrentAssignments: number;
  maxDelegationDepth: number;
  assignmentTimeoutMs: number;
  /** Agents get the Ponytail ruleset in their system prompt. */
  lazyCoding: boolean;
  /** On, a mail-born run answers as a letter in the agent's own voice instead of a report. */
  roleplay: boolean;
  activeOrganizationId?: string;
}

/* ------------------------------- gateways -------------------------------- */

/** Which chat gateway a config section belongs to. Only Telegram for now. */
export type GatewayId = 'telegram';

export interface GatewaysConfig {
  telegram: TelegramGatewayConfig;
}

export interface TelegramGatewayConfig {
  /** Channel on/off. */
  enabled: boolean;
  /**
   * Write-only. `GET /api/config` always answers with an empty string, so the
   * real token never reaches the browser. On a PATCH: a value sets it, `null`
   * clears it, and an empty string - what an untouched form sends back -
   * leaves the stored one alone.
   */
  token: string | null;
  /**
   * Run with an empty allowlist so `/id` can answer - the only way out of the
   * setup loop, since the bot otherwise does not listen until an id is
   * allowed. Every message still fails the guard; only `/id` replies.
   */
  pairing: boolean;
  /**
   * Numeric Telegram user ids allowed to talk to the assistant through this
   * gateway. Empty means off - there is no "everyone" option.
   */
  allowedUserIds: number[];
  /** Rights for turns that arrive through this channel. */
  permission: PermissionLevel;
  model?: string;
  /** Take photos, voice messages and documents in, or drop them in silence. */
  media: boolean;
  /** Where a voice message becomes text. `local` needs no key at all. */
  transcribe: TranscribeEngine;
  /** Hub id of the local Whisper model, e.g. `onnx-community/whisper-base`. */
  transcribeModel: string;
  /** Ceiling for one attachment, in MB. Telegram itself stops at 20. */
  maxAttachmentMb: number;
  /** Rewrite one message as the answer is produced, instead of sending it whole. */
  stream: boolean;
  push: TelegramPushConfig;
}

/**
 * Speech-to-text engines. `auto` uses a configured key when there is one and
 * the local model otherwise, so a voice message always has somewhere to go.
 */
export type TranscribeEngine = 'auto' | 'local' | 'openai' | 'elevenlabs' | 'off';

export interface TelegramPushConfig {
  enabled: boolean;
  assignments: boolean;
  cron: boolean;
  sleep: boolean;
  tasks: boolean;
  /** Mail the user is To or Cc on, pushed to the phone. See `mailFrom`. */
  mail: boolean;
  /** Whose mail is worth a push: the assistant, plus team leads, or everyone. */
  mailFrom: 'assistant' | 'leads' | 'all';
  /** Memories stored, skills written, records saved - the app's toasts. */
  activity: boolean;
  /** Every tool call, one short line, batched. Loud by nature. */
  tools: boolean;
  /** "22:00"; empty means no quiet hours. */
  quietFrom: string;
  /** "08:00" */
  quietUntil: string;
  maxPerHour: number;
  /** Subset of allowedUserIds; empty falls back to the first allowed id. */
  recipients: number[];
}

/** `GET /api/gateways` - one entry per channel, its live state next to its label. */
export interface GatewayStatus {
  id: GatewayId;
  label: string;
  /** A bot token is set, wherever it came from - never the token itself. */
  configured: boolean;
  /** Where it came from: the settings page, the environment, or nowhere yet. */
  tokenSource: 'config' | 'env' | 'none';
  enabled: boolean;
  running: boolean;
  botUsername?: string;
  allowedCount: number;
  /**
   * Stopped for something that will not pass on its own - a rejected token,
   * another process on the same bot. Nothing is being retried; it takes a new
   * token or an off/on to start again.
   */
  blocked: boolean;
  lastError?: string;
  lastEventAt?: number;
}

/**
 * `POST /api/gateways/:id/test` - one push message, sent to the first push
 * recipient. A channel that cannot send (not running, nobody to send to)
 * answers with a 400 instead, which `request()` turns into a thrown
 * `ApiError` - so there is no `ok: false` branch to model here.
 */
export interface GatewayTestResult {
  ok: true;
  recipient: number;
}

/* ------------------------------- listeners ------------------------------- */

/** What kind of connection a listener holds open. Only IMAP for now. */
export type ListenerKind = 'imap';

export interface ListenersConfig {
  imap: ImapListenerConfig[];
}

/**
 * One watched mailbox. IMAP has no webhook; what it has is IDLE, a connection
 * the server keeps open and speaks into the moment mail arrives - which is why
 * a listener costs one socket instead of a model call every few minutes.
 */
export interface ImapListenerConfig {
  /** Stable name, chosen by whoever adds it; runs record it as `imap:<id>`. */
  id: string;
  enabled: boolean;
  host: string;
  port: number;
  /** TLS from the first byte, the usual 993. Off means STARTTLS on 143. */
  secure: boolean;
  user: string;
  /**
   * Write-only, like `TelegramGatewayConfig.token`: `GET /api/config` always
   * answers with an empty string. On a PATCH a value sets it, `null` clears
   * it, and the empty string an untouched form sends back keeps the stored
   * one.
   */
  password: string | null;
  mailbox: string;
  /** The schedule this mailbox fires. */
  jobId: string;
}

/** `GET /api/listeners` - one entry per configured listener, with its live state. */
export interface ListenerStatus {
  id: string;
  kind: ListenerKind;
  label: string;
  /** A password is set - never the password itself. */
  configured: boolean;
  enabled: boolean;
  running: boolean;
  jobId: string;
  /** The schedule's name, when it still exists. */
  jobName?: string;
  /**
   * Stopped for something that will not pass on its own - wrong credentials, a
   * missing mailbox. A sentence to show, not a flag: only changed settings
   * start it again, so the reason is the whole point.
   */
  blocked?: string;
  lastError?: string;
  /** When the connection last saw something happen. */
  lastEventAt?: number;
  /** When that last turned into a run. */
  lastFiredAt?: number;
}

/** Routing around a provider whose quota is running out, as the server exposes it. */
export interface ProviderFallbackConfig {
  enabled: boolean;
  /** A window at or above this share counts as "running low". */
  thresholdPercent: number;
  /** Which provider to try after the preferred one, in this order. */
  order: ProviderId[];
}

/** The subset of RookeryConfig the server exposes. It never includes the token. */
export interface PublicConfig {
  /**
   * Where the server listens, straight from its own config. Read-only: PATCH
   * ignores both. The page cannot work this out for itself - in development it
   * talks to Vite, which proxies on, so its own origin names the wrong port.
   */
  host?: string;
  port?: number;
  assistantName: string;
  userName?: string;
  /** Address the user formally ("Sie"). */
  formalAddress: boolean;
  /** What the assistant calls the user now and then, e.g. "Master". */
  honorific: string;
  defaultProvider: ProviderId;
  defaultModel?: string;
  /** Unset or empty means each provider's own default; empty clears it. */
  defaultEffort?: EffortLevel | '';
  defaultPermission: PermissionLevel;
  voice: VoiceConfig;
  memory: MemoryConfig;
  org: OrgConfig;
  gateways: GatewaysConfig;
  listeners: ListenersConfig;
  router?: RouterConfig;
  providerFallback?: ProviderFallbackConfig;
}

/* ------------------------------ tool hub ------------------------------ */

export type ToolServerAudience = 'assistant' | 'agents' | 'both';

export interface ToolCatalogOption {
  key: string;
  label: string;
  hint?: string;
  type: 'select' | 'text';
  choices?: { value: string; label: string }[];
  default: string;
}

export interface ToolCatalogEnv {
  name: string;
  label: string;
  hint?: string;
  required: boolean;
  secret: boolean;
}

/** One server on the Werkzeuge page: catalogue recipe plus the user's state. */
export interface ToolServer {
  id: string;
  name: string;
  description: string;
  homepage: string;
  install: 'bundled' | 'on-demand' | 'custom' | 'external';
  enabled: boolean;
  audience: ToolServerAudience;
  options: Record<string, string>;
  optionDefs: ToolCatalogOption[];
  envDefs: ToolCatalogEnv[];
  /** Which keys are set; values never travel to the browser. */
  envSet: Record<string, boolean>;
  missingEnv: string[];
  installed: boolean;
  active: boolean;
  /** Project ids this server is limited to; empty means every project. */
  projectIds: string[];
  prepare?: { label: string };
  custom?: { name: string; command: string; args: string[]; hint: string };
  /** Where a server read out of Claude Code came from. */
  source?: string;
  /** Approved once, but its start definition has changed since. */
  changed?: boolean;
  /** Only a person may switch this on; the assistant cannot. */
  approvalRequired?: boolean;
  /** How it would start. Environment and headers travel as key names only. */
  external?: {
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args: string[];
    url?: string;
    envKeys: string[];
    headerKeys: string[];
    projectPath?: string;
  };
}

/**
 * One shelf of skills in the Claude Code installed on this machine: its own
 * folder, or one of its plugins. Read-only - Rookery only stores whether the
 * shelf counts here.
 */
export interface ExternalSource {
  id: string;
  label: string;
  origin: 'home' | 'plugin';
  plugin?: string;
  dir: string;
  skillCount: number;
  enabled: boolean;
}

/** A skill on one of those shelves; the body is only read when it is opened. */
export interface ExternalSkillRef {
  id: string;
  name: string;
  description: string;
  sourceId: string;
  path: string;
}

/**
 * A subagent type on one of those shelves. Off until somebody says otherwise:
 * it carries its own system prompt and tool list into a turn.
 */
export interface ExternalAgentRef {
  id: string;
  name: string;
  description: string;
  sourceId: string;
  path: string;
  model?: string;
  tools?: string[];
  enabled: boolean;
  audience: ToolServerAudience;
  /** False once the file changed after approval - it has to be read again. */
  active: boolean;
}

/**
 * The hook handlers one source declares. A hook set is a list of command
 * lines that run around every tool call, so the page has to show them before
 * anybody switches it on, and nothing here is ever written back.
 */
export interface ExternalHookSet {
  sourceId: string;
  path: string;
  /** Event names it hooks, e.g. `PreToolUse`. */
  events: string[];
  handlerCount: number;
  /** The command lines, for reading only. */
  commands: string[];
  enabled: boolean;
  audience: ToolServerAudience;
  /** False once `hooks.json` changed after approval. */
  active: boolean;
}

/** The "load the whole plugin" switch for one source. */
export interface ExternalPluginState {
  sourceId: string;
  loadWhole: boolean;
  audience: ToolServerAudience;
  active: boolean;
}

/** `GET /api/external`. */
export interface ExternalOverview {
  enabled: boolean;
  sources: ExternalSource[];
  skills: ExternalSkillRef[];
  /**
   * The three newer shelves. Optional so a server that does not send them yet
   * still satisfies the type; read them as `?? []`.
   */
  agents?: ExternalAgentRef[];
  hooks?: ExternalHookSet[];
  plugins?: ExternalPluginState[];
}

export interface CustomToolInput {
  name: string;
  command: string;
  args: string[];
  hint: string;
  audience: ToolServerAudience;
  env?: Record<string, string>;
}

/* ------------------------------- skills ------------------------------- */

/**
 * Who wrote a skill: a person, an agent at work, the nightly run - or
 * Rookery itself, for the handful that ship with it and have no folder.
 */
export type SkillOrigin = 'user' | 'agent' | 'sleep' | 'builtin';

export interface Skill {
  name: string;
  description: string;
  audience: ToolServerAudience;
  body: string;
  /** Anything not marked otherwise counts as the user's, and is never overwritten. */
  origin: SkillOrigin;
  files: string[];
  path: string;
  updatedAt: number;
}

export interface SkillInput {
  description: string;
  audience: ToolServerAudience;
  body: string;
}

/** One entry of the public skills shelf. */
export interface SkillSourceEntry {
  source: string;
  name: string;
  description: string;
  needsShell: boolean;
}

/** POST /api/skills/import: the skill, or the candidates inside a collection. */
export type SkillImportResult = { skill: Skill } | { candidates: string[] };

export interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  forgotten: number;
  /** Asleep: still stored, out of recall. */
  dormant: number;
  pinned: number;
  entities: number;
  edges: number;
}

/* --------------------------- aggregate statistics -------------------------- */

/**
 * Whole-database counts, every one of them a `COUNT(*)` on the server.
 *
 * They exist because every list endpoint is capped: a total counted from a
 * page of 500 stops being true the moment the cap bites. Sessions, messages
 * and memories span the database; the company's numbers belong to the active
 * organisation, the memory numbers to one owner.
 */
export interface StatsTotals {
  /** Conversations that are not archived. */
  sessions: number;
  archivedSessions: number;
  /** Transcript rows across every conversation. */
  messages: number;
  assignments: number;
  /** Assignments still `pending` or `running`. */
  runningAssignments: number;
  /** Top-level tasks and subtasks together. */
  tasks: number;
  /** Tasks in `open`, `planned` or `running` - what is still ahead. */
  openTasks: number;
  cronJobs: number;
  cronRuns: number;
  /** Live memories of the asked-for owner; the same figure as `MemoryStats.total`. */
  memories: number;
  /** Agents that are not archived. */
  agents: number;
}

/**
 * One local calendar day of the time series.
 *
 * A day only appears once something happened on it - the gaps are left in and
 * `fillDayGaps` in `lib/stats.ts` closes them for the window being drawn.
 *
 * Every figure counts what was *created* that day, whatever became of it
 * since: a conversation archived last week still counts on the day it
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
  /** Dated by `startedAt`. */
  cronRuns: number;
  memories: number;
  /** Prompt tokens summed over the day's messages; 0 when none were recorded. */
  inputTokens: number;
  /** Completion tokens, same caveat. */
  outputTokens: number;
}

/** What `GET /api/stats` answers: the counts, and how they came about. */
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
   * was spent - the difference matters on a chart, so a token card must check
   * this before it claims a number.
   */
  tokensAvailable: boolean;
}

export interface ChatPayload {
  text: string;
  sessionId?: string;
  provider?: ProviderId;
  model?: string;
  effort?: EffortLevel;
  permission?: PermissionLevel;
  /** Project the turn is about; assignments started from it inherit it. */
  projectId?: string;
  /**
   * Talk to this agent instead of the assistant. Honoured only when the turn
   * opens a new session; an existing session keeps its own counterpart.
   */
  agentId?: string;
  voice?: boolean;
}

/** What the server expects for a direct assignment. */
export interface AssignPayload {
  /** Agent slug or id. */
  agent: string;
  task: string;
  projectId?: string;
  sessionId?: string;
}

/* ----------------------------- socket frames ----------------------------- */

/** What the server expects to run a task from the board. */
export interface RunTaskPayload {
  taskId: string;
}

export type ClientFrame =
  | { type: 'chat'; id: string; payload: ChatPayload }
  | { type: 'assign'; id: string; payload: AssignPayload }
  | { type: 'run_task'; id: string; payload: RunTaskPayload }
  | { type: 'abort'; id: string }
  /** Opt this socket into the live log of one running assignment. */
  | { type: 'watch'; assignmentId: string }
  /** Opt back out. Watching never affects the run itself. */
  | { type: 'unwatch'; assignmentId: string }
  /**
   * An answer to a question the assistant asked. `id` is the question's, not
   * a request id: the waiting turn may have been started elsewhere, so this
   * frame opens no stream and gets no per-request reply.
   */
  | { type: 'answer'; id: string; selected: number[]; text?: string }
  /**
   * Rejoin a conversation: this socket wants the live tail of whatever turn
   * runs there. The replay of what already happened came over REST, from the
   * journal; the `attached` reply lines the two up.
   */
  | { type: 'attach'; sessionId: string }
  | { type: 'ping' };

/** One structural change somewhere in the company. */
export interface OrgChange {
  kind: string;
  id: string;
}

export type ServerFrame =
  /**
   * One event of a turn. `seq` is the journal position: a client that
   * rebuilt the turn over REST applies only frames above where its replay
   * ended, so replay and live neither duplicate nor drop an event.
   */
  | { type: 'event'; id: string; seq?: number; event: AgentEvent }
  /**
   * Reply to `attach`: the turn running in that session - whose live events
   * this socket now receives - or `null` when none is.
   */
  | { type: 'attached'; id: string | null; seq: number }
  | { type: 'memory'; event: { sessionId: string; stored: MemoryRecord[] } }
  | { type: 'assignment'; event: AgentEvent }
  | { type: 'message'; event: AgentEvent }
  /** Broadcast: mail was sent - a new mail in someone's inbox or outbox. */
  | { type: 'mail'; event: AgentEvent }
  /** Broadcast: a task on the board was created or changed state. */
  | { type: 'task'; event: AgentEvent }
  /** Broadcast: a schedule or one of its runs changed. */
  | { type: 'cron'; event: AgentEvent }
  /** Broadcast: the memory is asleep, working, or done for the night. */
  | { type: 'sleep'; event: AgentEvent }
  /** Broadcast: the assistant asked something and a turn is waiting on it. */
  | { type: 'question'; event: AgentEvent }
  /** Broadcast: that question is over, so the card goes away. */
  | { type: 'question-closed'; event: AgentEvent }
  /**
   * Watchers only: one live-log entry of a running assignment, in arrival
   * order. `seq` is monotone over the whole run, so a client can merge these
   * frames onto a REST snapshot without assuming continuity.
   */
  | { type: 'assignment-log'; assignmentId: string; seq: number; event: AgentEvent }
  | { type: 'changed'; change: OrgChange }
  | { type: 'pong' }
  | { type: 'error'; id?: string; message: string };

/** One line in the live activity rail. */
export interface ActivityItem {
  id: string;
  kind: 'tool' | 'status' | 'assignment' | 'memory' | 'thinking';
  label: string;
  detail?: string;
  at: number;
  done?: boolean;
}
