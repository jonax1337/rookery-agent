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
export type MemoryKind = 'fact' | 'preference' | 'project' | 'event' | 'summary';

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
  provider?: ProviderId;
  model?: string;
  agent?: string;
  createdAt: number;
  usage?: TurnUsage;
}

/** `voice` sessions belong to the hands-free screen and answer in its register. */
export type SessionKind = 'chat' | 'voice';

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
  sourceSessionId?: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
  accessCount: number;
  forgotten: boolean;
}

export interface ScoredMemory extends MemoryRecord {
  score: number;
  reason: string;
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
  createdAt: number;
  updatedAt: number;
  archived: boolean;
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

export type CronJobKind = 'assistant' | 'agent';
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
  | { type: 'tool'; name: string; status: 'start' | 'end'; detail?: string; id?: string }
  | { type: 'status'; label: string; detail?: string }
  | { type: 'memory'; action: 'recalled' | 'stored'; count: number; items?: MemoryRecord[] }
  /** An assignment changed state. Rides the turn's stream and the broadcast. */
  | { type: 'assignment'; assignment: AssignmentView }
  /** A message between agents, their manager or the assistant was posted. */
  | { type: 'message'; message: AgentMessage }
  /** A task on the board was created or changed state. */
  | { type: 'task'; task: Task }
  /** A schedule was created, edited, deleted, or one of its runs changed state. */
  | { type: 'cron'; job: CronJob; run?: CronRun; deleted?: boolean }
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

export interface ProviderStatus {
  id: ProviderId;
  available: boolean;
  binary: string;
  version?: string;
  authenticated: boolean;
  detail?: string;
  /** Model names this provider accepts, for the picker. */
  models?: string[];
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

export interface MemoryConfig {
  enabled: boolean;
  recallLimit: number;
  recallThreshold: number;
  autoExtract: boolean;
  workingWindow: number;
  contextBudget: number;
}

export interface OrgConfig {
  maxConcurrentAssignments: number;
  maxDelegationDepth: number;
  assignmentTimeoutMs: number;
  activeOrganizationId?: string;
}

/** The subset of RookeryConfig the server exposes. It never includes the token. */
export interface PublicConfig {
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
  install: 'bundled' | 'on-demand' | 'custom';
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
  prepare?: { label: string };
  custom?: { name: string; command: string; args: string[]; hint: string };
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

export interface Skill {
  name: string;
  description: string;
  audience: ToolServerAudience;
  body: string;
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
  /** Broadcast: a task on the board was created or changed state. */
  | { type: 'task'; event: AgentEvent }
  /** Broadcast: a schedule or one of its runs changed. */
  | { type: 'cron'; event: AgentEvent }
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
