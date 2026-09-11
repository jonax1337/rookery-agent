import type {
  CustomToolInput,
  Skill,
  SkillImportResult,
  SkillInput,
  SkillSourceEntry,
  ToolServer,
  ToolServerAudience,
  Agent,
  AgentDetail,
  AgentMessage,
  Assignment,
  AssignmentDetail,
  AssignmentStatus,
  CronJob,
  CronJobDetail,
  CronJobKind,
  CronOverview,
  CronPreview,
  MemoryEdge,
  MemoryEntity,
  MemoryGraph,
  MemoryKind,
  MemoryNeighbourhood,
  MemoryRecord,
  MemoryStats,
  Message,
  Organization,
  OrgSnapshot,
  PermissionLevel,
  Project,
  ProviderId,
  ProviderQuota,
  ProviderStatus,
  PublicConfig,
  ScoredMemory,
  Session,
  SleepRun,
  SleepStatusView,
  SessionKind,
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
  status?: 'open' | 'done' | 'cancelled';
  result?: Nullable<string>;
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
}

export const api = {
  health: () =>
    request<{ ok: boolean; version: string; providers: ProviderStatus[] }>('/api/health'),

  getConfig: () => request<PublicConfig>('/api/config'),
  updateConfig: (patch: Partial<PublicConfig>) =>
    request<PublicConfig>('/api/config', { method: 'PATCH', ...json(patch) }),

  /* ---------------------------------- voice -------------------------------- */

  ttsVoices: () => request<TtsCatalogue>('/api/tts/voices'),

  /* ---------------------------------- tools -------------------------------- */

  tools: () => request<ToolServer[]>('/api/tools'),
  updateTool: (
    id: string,
    patch: { enabled?: boolean; audience?: ToolServerAudience; options?: Record<string, string>; env?: Record<string, string> },
  ) => request<ToolServer>('/api/tools/' + id, { method: 'PATCH', ...json(patch) }),
  addCustomTool: (input: CustomToolInput) =>
    request<ToolServer>('/api/tools/custom', { method: 'POST', ...json(input) }),
  deleteTool: (id: string) => request<{ ok: true }>('/api/tools/' + id, { method: 'DELETE' }),
  /** Runs the entry's one-off preparation, e.g. a browser download. Takes a while. */
  prepareTool: (id: string) =>
    request<{ ok: boolean; output: string }>('/api/tools/' + id + '/prepare', { method: 'POST' }),

  /* --------------------------------- skills -------------------------------- */

  skills: () => request<Skill[]>('/api/skills'),
  skill: (name: string) => request<Skill>('/api/skills/' + name),
  saveSkill: (name: string, input: SkillInput) =>
    request<Skill>('/api/skills/' + name, { method: 'PUT', ...json(input) }),
  deleteSkill: (name: string) => request<{ ok: true }>('/api/skills/' + name, { method: 'DELETE' }),
  skillCatalog: () => request<SkillSourceEntry[]>('/api/skills/catalog'),
  /** Fetches a skill folder from GitHub. Takes a few seconds. */
  importSkill: (source: string) =>
    request<SkillImportResult>('/api/skills/import', { method: 'POST', ...json({ source }) }),

  providers: (refresh = false) =>
    request<ProviderStatus[]>('/api/providers' + (refresh ? '?refresh=1' : '')),

  /** Subscription usage of one provider; the server caches it for a minute. */
  providerUsage: (id: ProviderId, refresh = false) =>
    request<ProviderQuota>('/api/providers/' + id + '/usage' + (refresh ? '?refresh=1' : '')),

  /* -------------------------------- sessions ------------------------------- */

  /**
   * `agent` narrows the list to one counterpart: an agent id for a direct
   * chat, the literal `assistant` for the assistant's own conversations,
   * nothing for every conversation there is.
   */
  sessions: (limit = 50, agent?: string, kind?: SessionKind) =>
    request<Session[]>(
      '/api/sessions?limit=' +
        limit +
        (agent ? '&agent=' + encodeURIComponent(agent) : '') +
        (kind ? '&kind=' + kind : ''),
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
  patchSession: (id: string, patch: { title?: string; projectId?: Nullable<string> }) =>
    request<Session>('/api/sessions/' + id, { method: 'PATCH', ...json(patch) }),
  deleteSession: (id: string) =>
    request<{ ok: true }>('/api/sessions/' + id, { method: 'DELETE' }),
  resetSession: (id: string) =>
    request<{ ok: true }>('/api/sessions/' + id + '/reset', { method: 'POST' }),

  /* -------------------------------- memories ------------------------------- */

  memories: (options: { q?: string; kind?: MemoryKind; limit?: number; owner?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    if (options.kind) params.set('kind', options.kind);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.owner) params.set('owner', options.owner);
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
  undoSleep: (id: string) =>
    request<{ woken: number; removed: number; edges: number }>('/api/sleep/runs/' + id + '/undo', {
      method: 'POST',
    }),

  /* ------------------------------ organisation ----------------------------- */

  org: () => request<OrgSnapshot>('/api/org'),

  updateOrganization: (id: string, patch: { name?: string; mission?: Nullable<string> }) =>
    request<Organization>('/api/org/organizations/' + id, { method: 'PATCH', ...json(patch) }),

  createProject: (input: ProjectInput) =>
    request<Project>('/api/org/projects', { method: 'POST', ...json(input) }),
  updateProject: (id: string, patch: ProjectPatch) =>
    request<Project>('/api/org/projects/' + id, { method: 'PATCH', ...json(patch) }),
  deleteProject: (id: string) =>
    request<{ ok: true }>('/api/org/projects/' + id, { method: 'DELETE' }),

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
  cancelAssignment: (id: string) =>
    request<{ ok: true }>('/api/org/assignments/' + id + '/cancel', { method: 'POST' }),

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

  messages: (limit = 100) => request<AgentMessage[]>('/api/org/messages?limit=' + limit),
  postMessage: (input: { toAgentId?: string; content: string }) =>
    request<AgentMessage>('/api/org/messages', { method: 'POST', ...json(input) }),
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
