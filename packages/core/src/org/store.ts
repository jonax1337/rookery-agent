import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentMessage,
  Assignment,
  AssignmentStatus,
  Organization,
  PermissionLevel,
  Project,
  ProviderId,
  RequesterKind,
  Task,
  TaskPriority,
  TaskStatus,
  Team,
} from '../types.js';
import type { Db } from '../memory/db.js';

type Row = Record<string, unknown>;

/**
 * Persistence for the organisation: companies, projects, teams, agents,
 * assignments and inter-agent messages. Pure CRUD; the rules about who may
 * delegate to whom live in org/controller.ts.
 */
export class OrgStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /* ------------------------------ organizations ------------------------------ */

  createOrganization(input: { name: string; mission?: string }): Organization {
    const now = Date.now();
    const org: Organization = {
      id: randomUUID(),
      name: input.name.trim() || 'Unbenannte Firma',
      mission: blank(input.mission),
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare('INSERT INTO organizations (id, name, mission, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(org.id, org.name, org.mission ?? null, now, now);
    return org;
  }

  getOrganization(id: string): Organization | null {
    const row = this.#db.prepare('SELECT * FROM organizations WHERE id = ?').get(id) as Row | undefined;
    return row ? mapOrganization(row) : null;
  }

  listOrganizations(): Organization[] {
    const rows = this.#db.prepare('SELECT * FROM organizations ORDER BY created_at DESC').all() as Row[];
    return rows.map(mapOrganization);
  }

  updateOrganization(id: string, patch: { name?: string; mission?: string | null }): void {
    this.#update('organizations', id, { name: patch.name?.trim(), mission: patch.mission });
  }

  deleteOrganization(id: string): void {
    this.#db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
  }

  /* --------------------------------- projects -------------------------------- */

  createProject(input: { orgId: string; name: string; description?: string; path?: string }): Project {
    const now = Date.now();
    const project: Project = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name.trim() || 'Unbenanntes Projekt',
      description: blank(input.description),
      path: blank(input.path),
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    this.#db
      .prepare(
        `INSERT INTO projects (id, org_id, name, description, path, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(project.id, project.orgId, project.name, project.description ?? null, project.path ?? null, now, now);
    return project;
  }

  getProject(id: string): Project | null {
    const row = this.#db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  /** Find a project by id, or by name (case-insensitive) within one company. */
  findProject(orgId: string, ref: string): Project | null {
    const byId = this.getProject(ref);
    if (byId && byId.orgId === orgId) return byId;
    const row = this.#db
      .prepare('SELECT * FROM projects WHERE org_id = ? AND archived = 0 AND lower(name) = lower(?)')
      .get(orgId, ref.trim()) as Row | undefined;
    return row ? mapProject(row) : null;
  }

  listProjects(orgId: string, includeArchived = false): Project[] {
    const rows = this.#db
      .prepare('SELECT * FROM projects WHERE org_id = ? AND (? = 1 OR archived = 0) ORDER BY name')
      .all(orgId, includeArchived ? 1 : 0) as Row[];
    return rows.map(mapProject);
  }

  updateProject(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      path?: string | null;
      archived?: boolean;
      /** null revokes trust; undefined leaves it untouched. */
      mcpTrust?: { fingerprint: string; approvedAt: number } | null;
    },
  ): void {
    this.#update('projects', id, {
      name: patch.name?.trim(),
      description: patch.description,
      path: patch.path,
      archived: patch.archived === undefined ? undefined : patch.archived ? 1 : 0,
      mcp_trust: patch.mcpTrust === undefined ? undefined : patch.mcpTrust === null ? null : JSON.stringify(patch.mcpTrust),
    });
  }

  deleteProject(id: string): void {
    this.#db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /* ---------------------------------- teams ---------------------------------- */

  createTeam(input: { orgId: string; name: string; purpose?: string; leadId?: string }): Team {
    const now = Date.now();
    const team: Team = {
      id: randomUUID(),
      orgId: input.orgId,
      name: input.name.trim() || 'Unbenanntes Team',
      purpose: blank(input.purpose),
      leadId: blank(input.leadId),
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        'INSERT INTO teams (id, org_id, name, purpose, lead_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(team.id, team.orgId, team.name, team.purpose ?? null, team.leadId ?? null, now, now);
    return team;
  }

  getTeam(id: string): Team | null {
    const row = this.#db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTeam(row) : null;
  }

  findTeam(orgId: string, ref: string): Team | null {
    const byId = this.getTeam(ref);
    if (byId && byId.orgId === orgId) return byId;
    const row = this.#db
      .prepare('SELECT * FROM teams WHERE org_id = ? AND lower(name) = lower(?)')
      .get(orgId, ref.trim()) as Row | undefined;
    return row ? mapTeam(row) : null;
  }

  listTeams(orgId: string): Team[] {
    const rows = this.#db.prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY name').all(orgId) as Row[];
    return rows.map(mapTeam);
  }

  updateTeam(id: string, patch: { name?: string; purpose?: string | null; leadId?: string | null }): void {
    this.#update('teams', id, { name: patch.name?.trim(), purpose: patch.purpose, lead_id: patch.leadId });
  }

  deleteTeam(id: string): void {
    this.#db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  /* ---------------------------------- agents --------------------------------- */

  createAgent(input: {
    orgId: string;
    slug?: string;
    name: string;
    title: string;
    instructions: string;
    teamId?: string;
    managerId?: string;
    provider?: ProviderId;
    model?: string;
    permission?: PermissionLevel;
  }): Agent {
    const now = Date.now();
    const agent: Agent = {
      id: randomUUID(),
      orgId: input.orgId,
      slug: this.#uniqueSlug(input.orgId, input.slug?.trim() || input.name),
      name: input.name.trim() || 'Unbenannt',
      title: input.title.trim() || 'Mitarbeiter',
      instructions: input.instructions.trim(),
      teamId: blank(input.teamId),
      managerId: blank(input.managerId),
      provider: input.provider,
      model: blank(input.model),
      permission: input.permission,
      createdAt: now,
      updatedAt: now,
      archived: false,
    };
    this.#db
      .prepare(
        `INSERT INTO agents
           (id, org_id, slug, name, title, instructions, team_id, manager_id, provider, model, permission,
            created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        agent.id,
        agent.orgId,
        agent.slug,
        agent.name,
        agent.title,
        agent.instructions,
        agent.teamId ?? null,
        agent.managerId ?? null,
        agent.provider ?? null,
        agent.model ?? null,
        agent.permission ?? null,
        now,
        now,
      );
    return agent;
  }

  getAgent(id: string): Agent | null {
    const row = this.#db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row ? mapAgent(row) : null;
  }

  /** Find an agent by id, slug or name within one company. Archived agents do not match. */
  findAgent(orgId: string, ref: string): Agent | null {
    const wanted = ref.trim();
    const byId = this.getAgent(wanted);
    if (byId && byId.orgId === orgId && !byId.archived) return byId;
    const row = this.#db
      .prepare(
        `SELECT * FROM agents
          WHERE org_id = ? AND archived = 0 AND (slug = ? OR lower(slug) = lower(?) OR lower(name) = lower(?))
          ORDER BY CASE WHEN slug = ? THEN 0 ELSE 1 END LIMIT 1`,
      )
      .get(orgId, wanted, wanted, wanted, wanted) as Row | undefined;
    return row ? mapAgent(row) : null;
  }

  listAgents(
    orgId: string,
    options: { teamId?: string; managerId?: string | null; includeArchived?: boolean } = {},
  ): Agent[] {
    const clauses = ['org_id = ?'];
    const values: unknown[] = [orgId];
    if (!options.includeArchived) clauses.push('archived = 0');
    if (options.teamId) {
      clauses.push('team_id = ?');
      values.push(options.teamId);
    }
    if (options.managerId === null) clauses.push('manager_id IS NULL');
    else if (options.managerId) {
      clauses.push('manager_id = ?');
      values.push(options.managerId);
    }
    const rows = this.#db
      .prepare('SELECT * FROM agents WHERE ' + clauses.join(' AND ') + ' ORDER BY name')
      .all(...(values as never[])) as Row[];
    return rows.map(mapAgent);
  }

  updateAgent(
    id: string,
    patch: {
      slug?: string;
      name?: string;
      title?: string;
      instructions?: string;
      teamId?: string | null;
      managerId?: string | null;
      provider?: ProviderId | null;
      model?: string | null;
      permission?: PermissionLevel | null;
      archived?: boolean;
    },
  ): void {
    const current = this.getAgent(id);
    if (!current) return;
    this.#update('agents', id, {
      slug: patch.slug === undefined ? undefined : this.#uniqueSlug(current.orgId, patch.slug, id),
      name: patch.name?.trim(),
      title: patch.title?.trim(),
      instructions: patch.instructions?.trim(),
      team_id: patch.teamId,
      manager_id: patch.managerId,
      provider: patch.provider,
      model: patch.model,
      permission: patch.permission,
      archived: patch.archived === undefined ? undefined : patch.archived ? 1 : 0,
    });
  }

  deleteAgent(id: string): void {
    this.#db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  #uniqueSlug(orgId: string, base: string, selfId?: string): string {
    const root = slugify(base) || 'agent';
    let candidate = root;
    let suffix = 2;
    for (;;) {
      const row = this.#db
        .prepare('SELECT id FROM agents WHERE org_id = ? AND slug = ?')
        .get(orgId, candidate) as { id: string } | undefined;
      if (!row || row.id === selfId) return candidate;
      candidate = root + '-' + suffix;
      suffix += 1;
    }
  }

  /* ------------------------------- assignments ------------------------------- */

  createAssignment(input: {
    orgId: string;
    agentId: string;
    task: string;
    projectId?: string;
    sessionId?: string;
    parentId?: string;
    requesterKind: RequesterKind;
    requesterAgentId?: string;
    depth?: number;
  }): Assignment {
    const now = Date.now();
    const assignment: Assignment = {
      id: randomUUID(),
      orgId: input.orgId,
      agentId: input.agentId,
      projectId: blank(input.projectId),
      sessionId: blank(input.sessionId),
      parentId: blank(input.parentId),
      requesterKind: input.requesterKind,
      requesterAgentId: blank(input.requesterAgentId),
      task: input.task.trim(),
      status: 'pending',
      chars: 0,
      depth: input.depth ?? 0,
      createdAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO assignments
           (id, org_id, agent_id, project_id, session_id, parent_id, requester_kind, requester_agent_id,
            task, status, chars, depth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(
        assignment.id,
        assignment.orgId,
        assignment.agentId,
        assignment.projectId ?? null,
        assignment.sessionId ?? null,
        assignment.parentId ?? null,
        assignment.requesterKind,
        assignment.requesterAgentId ?? null,
        assignment.task,
        assignment.depth,
        now,
      );
    return assignment;
  }

  getAssignment(id: string): Assignment | null {
    const row = this.#db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as Row | undefined;
    return row ? mapAssignment(row) : null;
  }

  listAssignments(
    orgId: string,
    options: { agentId?: string; sessionId?: string; status?: AssignmentStatus[]; limit?: number } = {},
  ): Assignment[] {
    const clauses = ['org_id = ?'];
    const values: unknown[] = [orgId];
    if (options.agentId) {
      clauses.push('agent_id = ?');
      values.push(options.agentId);
    }
    if (options.sessionId) {
      clauses.push('session_id = ?');
      values.push(options.sessionId);
    }
    if (options.status?.length) {
      clauses.push('status IN (' + options.status.map(() => '?').join(', ') + ')');
      values.push(...options.status);
    }
    values.push(options.limit ?? 50);
    const rows = this.#db
      .prepare('SELECT * FROM assignments WHERE ' + clauses.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?')
      .all(...(values as never[])) as Row[];
    return rows.map(mapAssignment);
  }

  updateAssignment(
    id: string,
    patch: {
      status?: AssignmentStatus;
      result?: string;
      error?: string;
      provider?: ProviderId;
      model?: string;
      chars?: number;
      startedAt?: number;
      finishedAt?: number;
      durationMs?: number;
    },
  ): void {
    this.#update(
      'assignments',
      id,
      {
        status: patch.status,
        result: patch.result,
        error: patch.error,
        provider: patch.provider,
        model: patch.model,
        chars: patch.chars,
        started_at: patch.startedAt,
        finished_at: patch.finishedAt,
        duration_ms: patch.durationMs,
      },
      false,
    );
  }

  /* --------------------------------- messages -------------------------------- */

  postMessage(input: {
    orgId: string;
    fromAgentId?: string;
    toAgentId?: string;
    assignmentId?: string;
    content: string;
  }): AgentMessage {
    const message: AgentMessage = {
      id: randomUUID(),
      orgId: input.orgId,
      fromAgentId: blank(input.fromAgentId),
      toAgentId: blank(input.toAgentId),
      assignmentId: blank(input.assignmentId),
      content: input.content.trim(),
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        `INSERT INTO agent_messages (id, org_id, from_agent_id, to_agent_id, assignment_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.orgId,
        message.fromAgentId ?? null,
        message.toAgentId ?? null,
        message.assignmentId ?? null,
        message.content,
        message.createdAt,
      );
    return message;
  }

  /** Messages addressed to one agent, or to the assistant when `toAgentId` is null. */
  inbox(
    orgId: string,
    toAgentId: string | null,
    options: { unreadOnly?: boolean; limit?: number } = {},
  ): AgentMessage[] {
    const rows = (
      toAgentId
        ? this.#db
            .prepare(
              `SELECT * FROM agent_messages
                WHERE org_id = ? AND to_agent_id = ? AND (? = 0 OR read_at IS NULL)
                ORDER BY created_at DESC LIMIT ?`,
            )
            .all(orgId, toAgentId, options.unreadOnly ? 1 : 0, options.limit ?? 50)
        : this.#db
            .prepare(
              `SELECT * FROM agent_messages
                WHERE org_id = ? AND to_agent_id IS NULL AND (? = 0 OR read_at IS NULL)
                ORDER BY created_at DESC LIMIT ?`,
            )
            .all(orgId, options.unreadOnly ? 1 : 0, options.limit ?? 50)
    ) as Row[];
    return rows.map(mapMessage);
  }

  listMessages(orgId: string, limit = 100): AgentMessage[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_messages WHERE org_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(orgId, limit) as Row[];
    return rows.map(mapMessage);
  }

  markRead(ids: string[]): void {
    if (!ids.length) return;
    const statement = this.#db.prepare('UPDATE agent_messages SET read_at = ? WHERE id = ? AND read_at IS NULL');
    const now = Date.now();
    for (const id of ids) statement.run(now, id);
  }

  /* ----------------------------------- tasks ---------------------------------- */

  createTask(input: {
    orgId: string;
    title: string;
    description?: string;
    projectId?: string;
    parentId?: string;
    priority?: TaskPriority;
    assigneeId?: string;
    createdBy: RequesterKind;
    createdByAgentId?: string;
    dependsOn?: string[];
    planNote?: string;
    status?: TaskStatus;
  }): Task {
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      orgId: input.orgId,
      projectId: blank(input.projectId),
      parentId: blank(input.parentId),
      title: input.title.trim() || 'Unbenannte Aufgabe',
      description: (input.description ?? '').trim(),
      status: input.status ?? 'open',
      priority: input.priority ?? 'normal',
      assigneeId: blank(input.assigneeId),
      createdBy: input.createdBy,
      createdByAgentId: blank(input.createdByAgentId),
      dependsOn: [...new Set(input.dependsOn ?? [])],
      planNote: blank(input.planNote),
      createdAt: now,
      updatedAt: now,
    };
    this.#db
      .prepare(
        `INSERT INTO tasks
           (id, org_id, project_id, parent_id, title, description, status, priority, assignee_id,
            created_by, created_by_agent_id, depends_on, plan_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.orgId,
        task.projectId ?? null,
        task.parentId ?? null,
        task.title,
        task.description,
        task.status,
        task.priority,
        task.assigneeId ?? null,
        task.createdBy,
        task.createdByAgentId ?? null,
        JSON.stringify(task.dependsOn),
        task.planNote ?? null,
        now,
        now,
      );
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTask(row) : null;
  }

  /** Board view: top-level tasks by default, or the subtasks of one parent. */
  listTasks(
    orgId: string,
    options: { parentId?: string | null; status?: TaskStatus[]; assigneeId?: string; limit?: number } = {},
  ): Task[] {
    const clauses = ['org_id = ?'];
    const values: unknown[] = [orgId];
    if (options.parentId === null || options.parentId === undefined) clauses.push('parent_id IS NULL');
    else {
      clauses.push('parent_id = ?');
      values.push(options.parentId);
    }
    if (options.status?.length) {
      clauses.push('status IN (' + options.status.map(() => '?').join(', ') + ')');
      values.push(...options.status);
    }
    if (options.assigneeId) {
      clauses.push('assignee_id = ?');
      values.push(options.assigneeId);
    }
    values.push(options.limit ?? 100);
    const rows = this.#db
      .prepare(
        'SELECT * FROM tasks WHERE ' + clauses.join(' AND ') +
          " ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC LIMIT ?",
      )
      .all(...(values as never[])) as Row[];
    return rows.map(mapTask);
  }

  /** Every task in the company regardless of nesting, newest first. */
  listAllTasks(orgId: string, limit = 200): Task[] {
    const rows = this.#db
      .prepare('SELECT * FROM tasks WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?')
      .all(orgId, limit) as Row[];
    return rows.map(mapTask);
  }

  updateTask(
    id: string,
    patch: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      projectId?: string | null;
      assigneeId?: string | null;
      assignmentId?: string | null;
      dependsOn?: string[];
      planNote?: string | null;
      result?: string | null;
      error?: string | null;
      startedAt?: number | null;
      finishedAt?: number | null;
    },
  ): void {
    this.#update('tasks', id, {
      title: patch.title?.trim(),
      description: patch.description?.trim(),
      status: patch.status,
      priority: patch.priority,
      project_id: patch.projectId,
      assignee_id: patch.assigneeId,
      assignment_id: patch.assignmentId,
      depends_on: patch.dependsOn ? JSON.stringify([...new Set(patch.dependsOn)]) : undefined,
      plan_note: patch.planNote,
      result: patch.result,
      error: patch.error,
      started_at: patch.startedAt,
      finished_at: patch.finishedAt,
    });
  }

  /* --------------------------------- internals -------------------------------- */

  /** Generic partial update. `undefined` skips a column, `null` clears it. */
  #update(table: string, id: string, patch: Record<string, unknown>, touch = true): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      sets.push(column + ' = ?');
      values.push(value);
    }
    if (!sets.length) return;
    if (touch) {
      sets.push('updated_at = ?');
      values.push(Date.now());
    }
    values.push(id);
    this.#db.prepare('UPDATE ' + table + ' SET ' + sets.join(', ') + ' WHERE id = ?').run(...(values as never[]));
  }
}

/* ------------------------------------ helpers ----------------------------------- */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function blank(value: string | undefined | null): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function mapOrganization(row: Row): Organization {
  return {
    id: row.id as string,
    name: row.name as string,
    mission: optional(row.mission),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapProject(row: Row): Project {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    description: optional(row.description),
    path: optional(row.path),
    mcpTrust: parseMcpTrust(row.mcp_trust),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archived: Number(row.archived) === 1,
  };
}

/** A malformed or stale value is treated as "not decided" rather than thrown. */
function parseMcpTrust(raw: unknown): Project['mcpTrust'] {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { fingerprint?: unknown; approvedAt?: unknown };
    if (typeof parsed.fingerprint === 'string' && typeof parsed.approvedAt === 'number') {
      return { fingerprint: parsed.fingerprint, approvedAt: parsed.approvedAt };
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function mapTeam(row: Row): Team {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    name: row.name as string,
    purpose: optional(row.purpose),
    leadId: optional(row.lead_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAgent(row: Row): Agent {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    slug: row.slug as string,
    name: row.name as string,
    title: row.title as string,
    instructions: row.instructions as string,
    teamId: optional(row.team_id),
    managerId: optional(row.manager_id),
    provider: optional(row.provider) as ProviderId | undefined,
    model: optional(row.model),
    permission: optional(row.permission) as PermissionLevel | undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archived: Number(row.archived) === 1,
  };
}

function mapAssignment(row: Row): Assignment {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    agentId: row.agent_id as string,
    projectId: optional(row.project_id),
    sessionId: optional(row.session_id),
    parentId: optional(row.parent_id),
    requesterKind: row.requester_kind as RequesterKind,
    requesterAgentId: optional(row.requester_agent_id),
    task: row.task as string,
    status: row.status as AssignmentStatus,
    result: optional(row.result),
    error: optional(row.error),
    provider: optional(row.provider) as ProviderId | undefined,
    model: optional(row.model),
    chars: Number(row.chars ?? 0),
    depth: Number(row.depth ?? 0),
    createdAt: Number(row.created_at),
    startedAt: row.started_at ? Number(row.started_at) : undefined,
    finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
  };
}

function mapTask(row: Row): Task {
  let dependsOn: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.depends_on ?? '[]'));
    if (Array.isArray(parsed)) dependsOn = parsed.map(String);
  } catch {
    dependsOn = [];
  }
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    projectId: optional(row.project_id),
    parentId: optional(row.parent_id),
    title: row.title as string,
    description: (row.description as string) ?? '',
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeId: optional(row.assignee_id),
    assignmentId: optional(row.assignment_id),
    createdBy: row.created_by as RequesterKind,
    createdByAgentId: optional(row.created_by_agent_id),
    dependsOn,
    planNote: optional(row.plan_note),
    result: optional(row.result),
    error: optional(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at ? Number(row.started_at) : undefined,
    finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
  };
}

function mapMessage(row: Row): AgentMessage {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    fromAgentId: optional(row.from_agent_id),
    toAgentId: optional(row.to_agent_id),
    assignmentId: optional(row.assignment_id),
    content: row.content as string,
    createdAt: Number(row.created_at),
    readAt: row.read_at ? Number(row.read_at) : undefined,
  };
}
