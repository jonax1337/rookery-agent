/**
 * Mirror of the @rookery/core contract.
 *
 * These are copied rather than imported: core is a Node package (node:sqlite,
 * child_process) and must never end up in the browser bundle. Keep this file
 * in sync with packages/core/src/types.ts.
 */

export type ProviderId = 'claude' | 'codex';
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

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  /** Provider tool events retained with the answer, including interrupted calls. */
  toolCalls?: Extract<AgentEvent, { type: 'tool' }>[];
  provider?: ProviderId;
  model?: string;
  agent?: string;
  createdAt: number;
  usage?: TurnUsage;
}

/**
 * `voice` sessions belong to the hands-free screen and answer in its register.
 *
 * `mail` is the transcript of one answered mail, not a thread anyone
 * continues, so the server leaves it out of every list that does not ask for
 * it by name - it never reaches the conversations page.
 */
export type SessionKind = 'chat' | 'voice' | 'mail';

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
  maxMergeCalls: number;
  dormantAfterDays: number;
  minStrength: number;
  insights: number;
  /** How many of the day's conversations one night may read in full. */
  replaySessions: number;
  /** How many skills one night may distil out of the bank. */
  skills: number;
  /** How many skills one night may rewrite. Repair outranks invention. */
  skillRevisions: number;
  cycles: number;
  maxResolveCalls: number;
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

/* ----------------------------------- tasks ---------------------------------- */

export type TaskStatus = 'open' | 'planned' | 'running' | 'done' | 'failed' | 'cancelled';
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
export type CronTrigger = 'schedule' | 'manual';

/** A standing order: a prompt that fires on a cron expression while the server runs. */
export interface CronJob {
  id: string;
  orgId: string;
  name: string;
  /** Five-field cron expression, local time. */
  schedule: string;
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

/** GET /api/org/agents/:id */
export interface AgentDetail {
  agent: Agent;
  assignments: Assignment[];
  memories: MemoryRecord[];
  reports: Agent[];
}

/** GET /api/org/assignments/:id */
export interface AssignmentDetail {
  assignment: Assignment;
  agent: Agent | null;
  children: Assignment[];
  /** The board task this run belongs to, from the durable history, not `assignment_id` scans. */
  taskId: string | null;
}

/* --------------------------------- events -------------------------------- */

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
  | { type: 'memory'; action: 'recalled' | 'stored'; count: number; items?: MemoryRecord[] }
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

export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
  binary: string;
  version?: string;
  authenticated: boolean;
  detail?: string;
  /** Model names this provider accepts, for the picker. */
  models?: string[];
  modelOptions?: ProviderModel[];
  modelsError?: string;
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
}

export interface OrgConfig {
  maxConcurrentAssignments: number;
  maxDelegationDepth: number;
  assignmentTimeoutMs: number;
  /** Agents get the Ponytail ruleset in their system prompt. */
  lazyCoding: boolean;
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
  /** Where a server read out of Claude Code or Codex came from. */
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
 * One shelf of skills in the Claude Code or Codex installed on this machine:
 * a CLI's own folder, or one of its plugins. Read-only - Rookery only stores
 * whether the shelf counts here.
 */
export interface ExternalSource {
  id: string;
  kind: 'claude-code' | 'codex';
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

/** `GET /api/external`. */
export interface ExternalOverview {
  enabled: boolean;
  sources: ExternalSource[];
  skills: ExternalSkillRef[];
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

/** Who wrote a skill: a person, an agent at work, or the nightly run. */
export type SkillOrigin = 'user' | 'agent' | 'sleep';

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
  | { type: 'ping' };

/** One structural change somewhere in the company. */
export interface OrgChange {
  kind: string;
  id: string;
}

export type ServerFrame =
  | { type: 'event'; id: string; event: AgentEvent }
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
