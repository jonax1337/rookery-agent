import type {
  CustomToolInput,
  ExternalOverview,
  ExternalSource,
  Skill,
  SkillImportResult,
  SkillInput,
  SkillSourceEntry,
  ToolServer,
  ToolServerAudience,
  Agent,
  AgentDetail,
  AgentMessage,
  AgentReview,
  Assignment,
  AssignmentDetail,
  AssignmentLogSnapshot,
  AssignmentStatus,
  CronJob,
  CronJobDetail,
  CronJobKind,
  CronOverview,
  CronPreview,
  CronTriggerMode,
  GatewayId,
  GatewayStatus,
  GatewayTestResult,
  ListenerStatus,
  Mail,
  MailFolder,
  MemoryEntity,
  MemoryGraph,
  MemoryKind,
  MemoryNeighbourhood,
  MemoryRecord,
  MemoryStats,
  Message,
  Organization,
  OrgPerformanceEntry,
  OrgSnapshot,
  PermissionLevel,
  Project,
  ProjectMcpInfo,
  ProviderId,
  ProviderCatalogItem,
  ProviderProfile,
  ProviderQuota,
  ProviderStatus,
  PublicConfig,
  ScoredMemory,
  Session,
  SleepRun,
  SleepStatusView,
  SessionKind,
  StatsSnapshot,
  Task,
  TaskDetail,
  TaskPlanResult,
  TaskPriority,
  TaskStatus,
  Team,
  TtsCatalogue,
} from './types';

/**
 * Thin REST client.
 *
 * Every call goes through `request`, so an offline backend surfaces as one
 * recognisable error type instead of a dozen different failure shapes.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly offline: boolean;

  constructor(message: string, status: number, offline = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.offline = offline;
  }
}

export type VoiceKeyStatus = Record<'openai' | 'elevenlabs', {
  configured: boolean;
  source: 'saved' | 'environment' | 'none';
}>;

/** Set once at boot when the UI is served from somewhere other than the API. */
let baseUrl = '';

export function setApiBase(url: string): void {
  baseUrl = url.replace(/\/$/, '');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(baseUrl + path, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    // fetch only rejects for network-level failures, which for us means the
    // Rookery server is not running.
    throw new ApiError((error as Error).message || 'Backend unreachable', 0, true);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = body || response.statusText;
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      // plain-text error body is fine
    }
    throw new ApiError(message, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

/** `null` clears a nullable column server-side; `undefined` leaves it alone. */
export type Nullable<T> = T | null;

export interface AssistantProfile {
  files: { name: string; content: string }[];
  warnings: string[];
}

export type MigrationSource = 'hermes' | 'openclaw';
export interface MigrationSelection { files: string[]; jobs: string[] }
export interface MigrationPreview {
  source: MigrationSource;
  sourcePath: string;
  fingerprint: string;
  files: { sourcePath: string; targetPath: string; bytes: number; conflict: boolean }[];
  jobs?: {
    name: string; schedule: string; prompt: string; sourceId: string;
    kind?: 'assistant' | 'script';
    remainingRuns?: number;
    script?: { path: string; runtime: 'python' | 'node' | 'bash' | 'powershell'; noAgent?: boolean };
    assets?: { sourcePath: string; targetPath: string; bytes: number }[];
  }[];
  warnings: string[];
  canImport: boolean;
}
export interface MigrationResult {
  files: string[];
  jobs?: string[];
  backupPath?: string;
  warnings: string[];
}

export interface ReplaceAgentInput {
  name: string;
  slug?: string;
  title: string;
  instructions: string;
  handover?: string;
}

export interface AssignmentReviewInput {
  overall: number;
  quality?: number;
  completeness?: number;
  reliability?: number;
  communication?: number;
  efficiency?: number;
  comment?: string;
}

export interface ProjectInput {
  name: string;
  description?: string;
  path?: string;
}

export interface ProjectPatch {
  name?: string;
  description?: Nullable<string>;
  path?: Nullable<string>;
  archived?: boolean;
}

export interface TeamInput {
  name: string;
  purpose?: string;
  leadId?: string;
}

export interface TeamPatch {
  name?: string;
  purpose?: Nullable<string>;
  leadId?: Nullable<string>;
}

export interface AgentInput {
  name: string;
  title: string;
  instructions: string;
  slug?: string;
  teamId?: string;
  managerId?: string;
  provider?: ProviderId;
  model?: string;
  permission?: PermissionLevel;
}

export interface AgentPatch {
  name?: string;
  title?: string;
  instructions?: string;
  slug?: string;
  teamId?: Nullable<string>;
  managerId?: Nullable<string>;
  provider?: Nullable<ProviderId>;
  model?: Nullable<string>;
  permission?: Nullable<PermissionLevel>;
  archived?: boolean;
}

export interface TaskInput {
  title: string;
  description: string;
  projectId?: string;
  priority?: TaskPriority;
  assigneeId?: string;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  projectId?: Nullable<string>;
  assigneeId?: Nullable<string>;
  /** Only the states a human sets by hand; the runner owns the rest. */
  status?: 'open' | 'blocked' | 'done' | 'cancelled';
  result?: Nullable<string>;
  /** Board drag&drop position within a status column. */
  sortOrder?: number;
  /** Confirms `status: 'done'` even though the linked assignment failed. */
  force?: boolean;
}

export interface CronJobInput {
  name: string;
  schedule: string;
  prompt: string;
  kind?: CronJobKind;
  agentId?: string;
  projectId?: string;
  permission?: PermissionLevel;
  enabled?: boolean;
  once?: boolean;
  triggerMode?: CronTriggerMode;
  eventCooldownMs?: number;
}

export interface CronJobPatch {
  name?: string;
  schedule?: string;
  prompt?: string;
  kind?: CronJobKind;
  agentId?: Nullable<string>;
  projectId?: Nullable<string>;
  permission?: Nullable<PermissionLevel>;
  enabled?: boolean;
  once?: boolean;
  triggerMode?: CronTriggerMode;
  eventCooldownMs?: number;
}

export const api = {
  health: () =>
    request<{ ok: boolean; version: string; providers: ProviderStatus[] }>('/api/health'),

  getConfig: () => request<PublicConfig>('/api/config'),
  getProfile: () => request<AssistantProfile>('/api/profile'),
  saveProfileFile: (name: string, content: string) =>
    request<{ ok: true }>('/api/profile/' + encodeURIComponent(name), { method: 'PATCH', ...json({ content }) }),
  previewMigration: (source: MigrationSource, sourcePath?: string) =>
    request<MigrationPreview>('/api/migration/preview', { method: 'POST', ...json({ source, sourcePath }) }),
  importMigration: (preview: MigrationPreview, selection: MigrationSelection) =>
    request<MigrationResult>('/api/migration/import', { method: 'POST', ...json({ source: preview.source, sourcePath: preview.sourcePath, expectedFingerprint: preview.fingerprint, selection }) }),
  updateConfig: (patch: Partial<PublicConfig>) =>
    request<PublicConfig>('/api/config', { method: 'PATCH', ...json(patch) }),

  /* ------------------------------- statistics ------------------------------ */

  /**
   * The only aggregate call in the API: real `COUNT(*)` totals plus a daily
   * series, both counted in the database instead of estimated from a capped
   * list. `since` (epoch ms or ISO) wins over `days` when both are given;
   * without either the server draws the last 90 local calendar days.
   *
   * The series leaves empty days out - `fillDayGaps` from `lib/stats.ts` closes
   * them for the window a chart actually means to draw.
   */
  stats: (options: { days?: number; since?: number | string; owner?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.since !== undefined) params.set('since', String(options.since));
    else if (options.days !== undefined) params.set('days', String(options.days));
    if (options.owner) params.set('owner', options.owner);
    const query = params.toString();
    return request<StatsSnapshot>('/api/stats' + (query ? '?' + query : ''));
  },

  /* ---------------------------------- voice -------------------------------- */

  ttsVoices: () => request<TtsCatalogue>('/api/tts/voices'),
  voiceKeys: () => request<VoiceKeyStatus>('/api/tts/keys'),
  saveVoiceKeys: (patch: Partial<Record<'openai' | 'elevenlabs', string | null>>) =>
    request<VoiceKeyStatus>('/api/tts/keys', { method: 'PATCH', body: JSON.stringify(patch) }),

  /* ---------------------------------- tools -------------------------------- */

  tools: () => request<ToolServer[]>('/api/tools'),
  updateTool: (
    id: string,
    patch: {
      enabled?: boolean;
      audience?: ToolServerAudience;
      options?: Record<string, string>;
      env?: Record<string, string>;
      projectIds?: string[];
    },
  ) => request<ToolServer>('/api/tools/' + id, { method: 'PATCH', ...json(patch) }),
  addCustomTool: (input: CustomToolInput) =>
    request<ToolServer>('/api/tools/custom', { method: 'POST', ...json(input) }),
  deleteTool: (id: string) => request<{ ok: true }>('/api/tools/' + id, { method: 'DELETE' }),
  /** Runs the entry's one-off preparation, e.g. a browser download. Takes a while. */
  prepareTool: (id: string) =>
    request<{ ok: boolean; output: string }>('/api/tools/' + id + '/prepare', { method: 'POST' }),

  /* -------------------------------- gateways -------------------------------- */

  getGateways: () =>
    request<{ gateways: GatewayStatus[] }>('/api/gateways').then((body) => body.gateways),
  /**
   * Sends one push message through the channel to prove it actually works.
   * A channel that cannot send answers 400, which `request` already turns
   * into a rejected `ApiError` - so there is nothing to check on the result.
   */
  testGateway: (id: GatewayId) =>
    request<GatewayTestResult>('/api/gateways/' + id + '/test', { method: 'POST' }),

  /* -------------------------------- listeners ------------------------------- */

  /**
   * The listeners and what each connection is doing right now. The mailboxes
   * themselves are edited through `PATCH /api/config` like every other
   * section; this call is status only and never carries a password.
   */
  getListeners: () =>
    request<{ listeners: ListenerStatus[] }>('/api/listeners').then((body) => body.listeners),

  /* --------------------------------- skills -------------------------------- */

  skills: () => request<Skill[]>('/api/skills'),
  skill: (name: string) => request<Skill>('/api/skills/' + name),
  saveSkill: (name: string, input: SkillInput) =>
    request<Skill>('/api/skills/' + name, { method: 'PUT', ...json(input) }),
  deleteSkill: (name: string) => request<{ ok: true }>('/api/skills/' + name, { method: 'DELETE' }),
  skillCatalog: () => request<SkillSourceEntry[]>('/api/skills/catalog'),

  /* -------------------------------- external -------------------------------- */

  /** What the Claude Code on this machine has installed. */
  external: () => request<ExternalOverview>('/api/external'),
  /** Whether one of those shelves counts here. */
  setExternalSource: (id: string, enabled: boolean) =>
    request<ExternalSource>('/api/external/sources/' + encodeURIComponent(id), {
      method: 'PATCH',
      ...json({ enabled }),
    }),
  /** Whether one discovered subagent may be handed to a turn, and to whose. */
  setExternalAgent: (id: string, patch: { enabled?: boolean; audience?: ToolServerAudience }) =>
    request<unknown>('/api/external/agents/' + encodeURIComponent(id), {
      method: 'PATCH',
      ...json(patch),
    }),
  /** Same for a hook set - its command lines are shown, never written back. */
  setExternalHook: (id: string, patch: { enabled?: boolean; audience?: ToolServerAudience }) =>
    request<unknown>('/api/external/hooks/' + encodeURIComponent(id), {
      method: 'PATCH',
      ...json(patch),
    }),
  /** The per-source "load the whole plugin" switch. */
  setExternalPlugin: (id: string, patch: { loadWhole?: boolean; audience?: ToolServerAudience }) =>
    request<unknown>('/api/external/plugins/' + encodeURIComponent(id), {
      method: 'PATCH',
      ...json(patch),
    }),
  refreshExternal: () =>
    request<{ sources: ExternalSource[]; servers: number }>('/api/external/refresh', { method: 'POST' }),
  /** Fetches a skill folder from GitHub. Takes a few seconds. */
  importSkill: (source: string) =>
    request<SkillImportResult>('/api/skills/import', { method: 'POST', ...json({ source }) }),

  providers: (refresh = false) =>
    request<ProviderStatus[]>('/api/providers' + (refresh ? '?refresh=1' : '')),

  /** Subscription usage of one provider; the server caches it for a minute. */
  providerUsage: (id: ProviderId, refresh = false) =>
    request<ProviderQuota>('/api/providers/' + id + '/usage' + (refresh ? '?refresh=1' : '')),

  /** The providers that can be set up, each with what is already stored for it. */
  providerCatalog: () => request<ProviderCatalogItem[]>('/api/providers/catalog'),
  /** Alternative backends for the `claude` binary (GLM, ...). Never carries the API key back. */
  providerProfiles: () => request<ProviderProfile[]>('/api/providers/profiles'),
  /** Upserts by id. `authToken: null` clears a stored key, empty/absent leaves it alone. */
  saveProviderProfile: (
    id: string,
    patch: Partial<
      Pick<ProviderProfile, 'displayName' | 'baseUrl' | 'defaultModel' | 'via'>
    > & { authToken?: string | null },
  ) =>
    request<ProviderProfile>('/api/providers/profiles/' + encodeURIComponent(id), {
      method: 'PATCH',
      ...json(patch),
    }),
  deleteProviderProfile: (id: string) =>
    request<{ ok: true }>('/api/providers/profiles/' + encodeURIComponent(id), { method: 'DELETE' }),

  /* -------------------------------- sessions ------------------------------- */

  /**
   * `agent` narrows the list to one counterpart: an agent id for a direct
   * chat, the literal `assistant` for the assistant's own conversations,
   * nothing for every conversation there is.
   */
  sessions: (limit = 50, agent?: string, kind?: SessionKind, includeArchived = false) =>
    request<Session[]>(
      '/api/sessions?limit=' +
        limit +
        (agent ? '&agent=' + encodeURIComponent(agent) : '') +
        (kind ? '&kind=' + kind : '') +
        (includeArchived ? '&includeArchived=1' : ''),
    ),
  createSession: (
    input: {
      title?: string;
      kind?: SessionKind;
      provider?: ProviderId;
      model?: string;
      projectId?: string;
      agentId?: string;
    } = {},
  ) => request<Session>('/api/sessions', { method: 'POST', ...json(input) }),
  session: (id: string) =>
    request<{ session: Session; messages: Message[] }>('/api/sessions/' + id),
  /** `archived` files a conversation away; `?includeArchived=1` brings it back into a list. */
  patchSession: (
    id: string,
    patch: { title?: string; projectId?: Nullable<string>; archived?: boolean },
  ) => request<Session>('/api/sessions/' + id, { method: 'PATCH', ...json(patch) }),
  deleteSession: (id: string) =>
    request<{ ok: true }>('/api/sessions/' + id, { method: 'DELETE' }),
  resetSession: (id: string) =>
    request<{ ok: true }>('/api/sessions/' + id + '/reset', { method: 'POST' }),

  /* -------------------------------- memories ------------------------------- */

  memories: (
    options: {
      q?: string;
      kind?: MemoryKind;
      limit?: number;
      owner?: string;
      /** Include what was forgotten - the memory list's "Vergessene zeigen". */
      includeForgotten?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    if (options.kind) params.set('kind', options.kind);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.owner) params.set('owner', options.owner);
    if (options.includeForgotten) params.set('includeForgotten', '1');
    const query = params.toString();
    return request<ScoredMemory[] | MemoryRecord[]>('/api/memories' + (query ? '?' + query : ''));
  },
  addMemory: (input: {
    content: string;
    kind?: MemoryKind;
    tags?: string[];
    importance?: number;
  }) => request<MemoryRecord>('/api/memories', { method: 'POST', ...json(input) }),
  forgetMemory: (id: string, hard = false) =>
    request<{ ok: true }>('/api/memories/' + id + (hard ? '?hard=1' : ''), { method: 'DELETE' }),
  memoryStats: (owner?: string) =>
    request<MemoryStats>('/api/memories/stats' + (owner ? '?owner=' + encodeURIComponent(owner) : '')),

  /** Pin, re-word, re-weight, or wake a sleeping memory. */
  patchMemory: (
    id: string,
    patch: {
      content?: string;
      kind?: MemoryKind;
      tags?: string[];
      importance?: number;
      pinned?: boolean;
      dormant?: boolean;
      forgotten?: boolean;
    },
  ) => request<MemoryRecord>('/api/memories/' + id, { method: 'PATCH', ...json(patch) }),

  /* ---------------------------- the memory graph --------------------------- */

  memoryGraph: (
    options: {
      owner?: string;
      entity?: string;
      kind?: MemoryKind;
      since?: number;
      includeDormant?: boolean;
      limit?: number;
    } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.owner) query.set('owner', options.owner);
    if (options.entity) query.set('entity', options.entity);
    if (options.kind) query.set('kind', options.kind);
    if (options.since) query.set('since', String(options.since));
    if (options.includeDormant) query.set('includeDormant', '1');
    if (options.limit) query.set('limit', String(options.limit));
    const search = query.toString();
    return request<MemoryGraph>('/api/memories/graph' + (search ? '?' + search : ''));
  },
  entities: (options: { owner?: string; limit?: number; minMentions?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.owner) query.set('owner', options.owner);
    if (options.limit) query.set('limit', String(options.limit));
    if (options.minMentions !== undefined) query.set('minMentions', String(options.minMentions));
    const search = query.toString();
    return request<MemoryEntity[]>('/api/entities' + (search ? '?' + search : ''));
  },
  memoryEdges: (id: string) => request<MemoryNeighbourhood>('/api/memories/' + id + '/edges'),

  /* --------------------------------- sleep -------------------------------- */

  sleepStatus: (owner?: string) =>
    request<SleepStatusView>('/api/sleep/status' + (owner ? '?owner=' + encodeURIComponent(owner) : '')),
  sleepRuns: (owner?: string, limit = 30) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (owner) query.set('owner', owner);
    return request<SleepRun[]>('/api/sleep/runs?' + query.toString());
  },
  /** Start a night. Resolves once it is running; the socket reports the rest. */
  startSleep: (owner?: string) =>
    request<{ started: boolean; owner: string }>(
      '/api/sleep/run' + (owner ? '?owner=' + encodeURIComponent(owner) : ''),
      { method: 'POST' },
    ),
  cancelSleep: (owner?: string) =>
    request<{ cancelled: boolean }>(
      '/api/sleep/cancel' + (owner ? '?owner=' + encodeURIComponent(owner) : ''),
      { method: 'POST' },
    ),
  /** Reshape the nightly run's own schedule: a cron expression, on/off, or both. */
  updateSleepSchedule: (patch: { schedule?: string; enabled?: boolean }) =>
    request<{ schedule: SleepStatusView['schedule']; config: SleepStatusView['config'] }>('/api/sleep/schedule', {
      method: 'PATCH',
      ...json(patch),
    }),
  undoSleep: (id: string) =>
    request<{ woken: number; removed: number; edges: number; skills: number }>('/api/sleep/runs/' + id + '/undo', {
      method: 'POST',
    }),

  /* ------------------------------ organisation ----------------------------- */

  org: () => request<OrgSnapshot>('/api/org'),
  orgPerformance: () => request<OrgPerformanceEntry[]>('/api/org/performance'),

  updateOrganization: (id: string, patch: { name?: string; mission?: Nullable<string> }) =>
    request<Organization>('/api/org/organizations/' + id, { method: 'PATCH', ...json(patch) }),

  createProject: (input: ProjectInput) =>
    request<Project>('/api/org/projects', { method: 'POST', ...json(input) }),
  updateProject: (id: string, patch: ProjectPatch) =>
    request<Project>('/api/org/projects/' + id, { method: 'PATCH', ...json(patch) }),
  deleteProject: (id: string) =>
    request<{ ok: true }>('/api/org/projects/' + id, { method: 'DELETE' }),
  /** A project's own `.mcp.json`: whether it is trusted, and what it lists. */
  projectMcp: (id: string) => request<ProjectMcpInfo>('/api/org/projects/' + id + '/mcp'),
  trustProjectMcp: (id: string) =>
    request<Project>('/api/org/projects/' + id + '/mcp/trust', { method: 'POST' }),
  revokeProjectMcp: (id: string) =>
    request<Project>('/api/org/projects/' + id + '/mcp/trust', { method: 'DELETE' }),

  createTeam: (input: TeamInput) =>
    request<Team>('/api/org/teams', { method: 'POST', ...json(input) }),
  updateTeam: (id: string, patch: TeamPatch) =>
    request<Team>('/api/org/teams/' + id, { method: 'PATCH', ...json(patch) }),
  deleteTeam: (id: string) => request<{ ok: true }>('/api/org/teams/' + id, { method: 'DELETE' }),

  createAgent: (input: AgentInput) =>
    request<Agent>('/api/org/agents', { method: 'POST', ...json(input) }),
  agent: (id: string) => request<AgentDetail>('/api/org/agents/' + id),
  updateAgent: (id: string, patch: AgentPatch) =>
    request<Agent>('/api/org/agents/' + id, { method: 'PATCH', ...json(patch) }),
  deleteAgent: (id: string) =>
    request<{ ok: true }>('/api/org/agents/' + id, { method: 'DELETE' }),
  agentReviews: (id: string, options: { limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<AgentReview[]>('/api/org/agents/' + id + '/reviews' + (query ? '?' + query : ''));
  },
  /** Stage 4: the user approving a pending replacement proposal. */
  replaceAgent: (id: string, input: ReplaceAgentInput) =>
    request<{ predecessor: Agent; successor: Agent }>('/api/org/agents/' + id + '/replace', {
      method: 'POST',
      ...json(input),
    }),

  assignments: (
    options: { limit?: number; status?: AssignmentStatus[]; agentId?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.status?.length) params.set('status', options.status.join(','));
    if (options.agentId) params.set('agentId', options.agentId);
    const query = params.toString();
    return request<Assignment[]>('/api/org/assignments' + (query ? '?' + query : ''));
  },
  assignment: (id: string) => request<AssignmentDetail>('/api/org/assignments/' + id),
  /**
   * The live log of a running assignment, buffered on the server only while
   * the run lasts. Once it is over the endpoint rejects with `ApiError`
   * `status === 410` (the run finished; only its result remains) or `404`
   * (unknown id) - the terminal hook reads both as "finished".
   */
  assignmentLog: (id: string) =>
    request<AssignmentLogSnapshot>('/api/org/assignments/' + id + '/log'),
  cancelAssignment: (id: string) =>
    request<{ ok: true }>('/api/org/assignments/' + id + '/cancel', { method: 'POST' }),
  reviewAssignment: (id: string, input: AssignmentReviewInput) =>
    request<AgentReview>('/api/org/assignments/' + id + '/review', { method: 'POST', ...json(input) }),

  /* ---------------------------------- tasks -------------------------------- */

  /** Top-level tasks by default; `all` returns every task incl. subtasks. */
  tasks: (options: { status?: TaskStatus[]; all?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.all) params.set('all', '1');
    if (options.status?.length) params.set('status', options.status.join(','));
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<Task[]>('/api/org/tasks' + (query ? '?' + query : ''));
  },
  createTask: (input: TaskInput) =>
    request<Task>('/api/org/tasks', { method: 'POST', ...json(input) }),
  task: (id: string) => request<TaskDetail>('/api/org/tasks/' + id),
  updateTask: (id: string, patch: TaskPatch) =>
    request<Task>('/api/org/tasks/' + id, { method: 'PATCH', ...json(patch) }),
  /** Asks a model who should do this and whether to split it. Takes seconds. */
  planTask: (id: string, hint?: string) =>
    request<TaskPlanResult>('/api/org/tasks/' + id + '/plan', {
      method: 'POST',
      ...json(hint ? { hint } : {}),
    }),

  /* -------------------------------- schedules ------------------------------ */

  cron: () => request<CronOverview>('/api/cron'),
  cronJob: (id: string) => request<CronJobDetail>('/api/cron/' + id),
  /** Validates an expression and lists when it would fire next. */
  cronPreview: (schedule: string) =>
    request<CronPreview>('/api/cron/preview?schedule=' + encodeURIComponent(schedule)),
  createCronJob: (input: CronJobInput) => request<CronJob>('/api/cron', { method: 'POST', ...json(input) }),
  updateCronJob: (id: string, patch: CronJobPatch) =>
    request<CronJob>('/api/cron/' + id, { method: 'PATCH', ...json(patch) }),
  deleteCronJob: (id: string) => request<{ ok: true }>('/api/cron/' + id, { method: 'DELETE' }),
  /** Fires the job now; the run's progress arrives over the socket. */
  runCronJob: (id: string) => request<{ ok: true }>('/api/cron/' + id + '/run', { method: 'POST' }),
  /**
   * Mints the job's webhook secret, or replaces the one it has - there is no
   * separate rotate call, because minting a new secret is what rotating is.
   */
  enableCronWebhook: (id: string) =>
    request<{ job: CronJob }>('/api/cron/' + id + '/webhook', { method: 'POST' }).then((body) => body.job),
  disableCronWebhook: (id: string) =>
    request<{ ok: true }>('/api/cron/' + id + '/webhook', { method: 'DELETE' }),

  messages: (limit = 100) => request<AgentMessage[]>('/api/org/messages?limit=' + limit),
  postMessage: (input: { toAgentId?: string; content: string }) =>
    request<AgentMessage>('/api/org/messages', { method: 'POST', ...json(input) }),
  /** Marks a batch of inbox rows read; the inbox page calls this once per load. */
  markMessagesRead: (ids: string[]) =>
    request<{ ok: true }>('/api/org/messages/read', { method: 'POST', ...json({ ids }) }),

  /** `mailbox` is an agent id, `"user"` or `"assistant"`; `folder` slices the inbox. */
  mail: (mailbox: string, folder: MailFolder, limit = 100) =>
    request<Mail[]>('/api/org/mail?mailbox=' + encodeURIComponent(mailbox) + '&folder=' + folder + '&limit=' + limit),
  /** One whole conversation, oldest first - the board's deep link into mail. */
  mailThread: (threadId: string, mailbox = 'user') =>
    request<Mail[]>('/api/org/mail?mailbox=' + encodeURIComponent(mailbox) + '&thread=' + encodeURIComponent(threadId)),
  archiveMailThread: (threadId: string, archived = true) =>
    request<{ ok: true }>('/api/org/mail/archive', { method: 'POST', ...json({ threadId, archived }) }),
  sendMail: (input: { to: string[]; cc?: string[]; subject: string; body: string; inReplyTo?: string; mode?: 'mail' | 'task' }) =>
    request<Mail | { mail: Mail; task: Task }>('/api/org/mail', { method: 'POST', ...json(input) }),
  /**
   * Marks a batch of mailbox rows read; the mailbox page calls this once per
   * load. `read: false` is the reading pane's "Mark as unread".
   */
  markMailRead: (ids: string[], read = true) =>
    request<{ ok: true }>('/api/org/mail/read', { method: 'POST', ...json({ ids, read }) }),
};

/**
 * Synthesise one chunk of speech on the server. Returns the encoded audio,
 * MP3 for every engine, ready for `AudioContext.decodeAudioData`.
 */
export async function fetchSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(baseUrl + '/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError((error as Error).message || 'Backend unreachable', 0, true);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    let message = body || response.statusText;
    try {
      message = (JSON.parse(body) as { message?: string }).message ?? message;
    } catch {
      // plain-text error body is fine
    }
    throw new ApiError(message, response.status);
  }
  return response.arrayBuffer();
}

/** Absolute ws:// URL for the current origin, honouring an https page. */
export function socketUrl(): string {
  if (baseUrl) {
    return baseUrl.replace(/^http/, 'ws') + '/ws';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + window.location.host + '/ws';
}
