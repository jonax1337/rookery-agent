import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentAction,
  AgentActionKind,
  AgentMessage,
  AgentPerformance,
  AgentReview,
  Assignment,
  AssignmentStatus,
  Mail,
  MailFolder,
  MailRecipient,
  MailThread,
  MailThreadKind,
  MailWho,
  Organization,
  PermissionLevel,
  Project,
  ProviderId,
  RequesterKind,
  ReviewSource,
  Task,
  TaskPriority,
  TaskStatus,
  Team,
} from '../types.js';
import type { Db } from '../memory/db.js';
import { reviewLabel } from '../memory/dream/label.js';
import { titleFromBrief } from '../util/queue.js';

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
      name: input.name.trim() || 'Untitled company',
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
      name: input.name.trim() || 'Untitled project',
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
      name: input.name.trim() || 'Untitled team',
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
    voice?: string;
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
      name: input.name.trim() || 'Unnamed',
      title: input.title.trim() || 'Staff member',
      instructions: input.instructions.trim(),
      voice: blank(input.voice),
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
           (id, org_id, slug, name, title, instructions, voice, team_id, manager_id, provider, model, permission,
            created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        agent.id,
        agent.orgId,
        agent.slug,
        agent.name,
        agent.title,
        agent.instructions,
        agent.voice ?? null,
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
      voice?: string | null;
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
      voice: patch.voice === undefined ? undefined : patch.voice === null ? null : patch.voice.trim() || null,
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
    /** What the run is called. Falls back to the brief's first line. */
    title?: string;
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
      title: input.title?.trim() || titleFromBrief(input.task),
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
            title, task, status, chars, depth, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
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
        assignment.title,
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

  /**
   * Assignments still marked pending/running from a previous process are
   * failed on startup, mirroring `CronStore.failStaleRuns` (cron/store.ts).
   * Returns the rows it changed so the caller can announce them.
   */
  failStaleAssignments(reason: string): Assignment[] {
    const now = Date.now();
    const rows = this.#db
      .prepare("SELECT * FROM assignments WHERE status IN ('pending', 'running')")
      .all() as Row[];
    if (!rows.length) return [];
    this.#db
      .prepare(
        "UPDATE assignments SET status = 'failed', error = ?, finished_at = ? WHERE status IN ('pending', 'running')",
      )
      .run(reason, now);
    return rows.map((row) => mapAssignment({ ...row, status: 'failed', error: reason, finished_at: now }));
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

  /* ----------------------------------- mail ------------------------------------ */

  /**
   * Send mail: one `mail` row plus one `mail_recipients` row per to/cc
   * target. Delivery only - the auto-trigger rule (a To agent gets a real
   * run) lives in org/controller.ts, which is the one place that knows
   * about running assignments.
   */
  sendMail(input: {
    orgId: string;
    from: MailWho;
    subject: string;
    body: string;
    to: MailWho[];
    cc?: MailWho[];
    /** Continues an existing thread; defaults to this mail's own id. */
    threadId?: string;
    inReplyTo?: string;
    depth?: number;
    assignmentId?: string;
    /** The kind of thread this mail opens; a reply inherits its thread's row. */
    kind?: MailThreadKind;
  }): Mail {
    const now = Date.now();
    const id = randomUUID();
    const subject = input.subject.trim() || '(no subject)';
    const threadId = input.threadId ?? id;
    this.#db
      .prepare(
        `INSERT INTO mail (id, org_id, from_kind, from_agent_id, subject, body, thread_id, in_reply_to, depth, assignment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.orgId,
        input.from.kind,
        input.from.kind === 'agent' ? (input.from.id ?? null) : null,
        subject,
        input.body,
        threadId,
        input.inReplyTo ?? null,
        input.depth ?? 0,
        input.assignmentId ?? null,
        now,
      );

    // One protocol row per thread, and `OR IGNORE` is the whole inheritance
    // rule: only the thread's first mail writes the row, every reply falls
    // through to it. A mail an agent sends opens a report - it exists because
    // a run or a scheduling produced it - unless a caller knows better.
    const kind = input.kind ?? (input.from.kind === 'agent' ? 'report' : 'chat');
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO mail_threads (thread_id, org_id, kind, task_id, archived_at, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?)`,
      )
      .run(threadId, input.orgId, kind, now);

    const insertRecipient = this.#db.prepare(
      `INSERT INTO mail_recipients (id, mail_id, recipient_kind, recipient_id, box, read_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    );
    const targets: { who: MailWho; box: 'to' | 'cc' }[] = [
      ...input.to.map((who) => ({ who, box: 'to' as const })),
      ...(input.cc ?? []).map((who) => ({ who, box: 'cc' as const })),
    ];
    const recipients: MailRecipient[] = targets.map(({ who, box }) => {
      const recipientId = who.kind === 'agent' ? who.id : undefined;
      const recipient: MailRecipient = { id: randomUUID(), mailId: id, recipientKind: who.kind, recipientId, box };
      insertRecipient.run(recipient.id, id, recipient.recipientKind, recipient.recipientId ?? null, recipient.box);
      return recipient;
    });

    // The thread's own row, not the computed default: a reply landed in a
    // thread whose kind was decided by its first mail, and that is the truth
    // the caller should see.
    const threadRow = this.#db
      .prepare('SELECT kind, task_id, archived_at, created_at FROM mail_threads WHERE thread_id = ?')
      .get(threadId) as Row | undefined;

    return {
      id,
      orgId: input.orgId,
      fromKind: input.from.kind,
      fromAgentId: input.from.kind === 'agent' ? input.from.id : undefined,
      subject,
      body: input.body,
      threadId,
      inReplyTo: input.inReplyTo,
      depth: input.depth ?? 0,
      assignmentId: input.assignmentId,
      createdAt: now,
      recipients,
      threadKind: (threadRow?.kind as MailThreadKind | undefined) ?? 'chat',
      threadArchivedAt: optionalScore(threadRow?.archived_at),
    };
  }

  /** One mail with its recipients and its thread's protocol row, or null. */
  getMail(id: string): Mail | null {
    const row = this.#db
      .prepare(
        `SELECT m.*, mt.kind AS thread_kind, mt.archived_at AS thread_archived_at, mt.task_id AS thread_task_id, t.title AS thread_task_title
         FROM mail m
         LEFT JOIN mail_threads mt ON mt.thread_id = m.thread_id
         LEFT JOIN tasks t ON t.id = mt.task_id
         WHERE m.id = ?`,
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    const recipients = this.#db.prepare('SELECT * FROM mail_recipients WHERE mail_id = ?').all(id) as Row[];
    return mapMail(row, recipients.map(mapMailRecipient));
  }

  /** The protocol row behind a thread, or null. */
  getMailThread(orgId: string, threadId: string): MailThread | null {
    const row = this.#db
      .prepare('SELECT * FROM mail_threads WHERE org_id = ? AND thread_id = ?')
      .get(orgId, threadId) as Row | undefined;
    return row ? mapMailThread(row) : null;
  }

  /** The mail thread an assignment thread opened for `taskId`, or null. */
  getMailThreadForTask(orgId: string, taskId: string): MailThread | null {
    const row = this.#db
      .prepare('SELECT * FROM mail_threads WHERE org_id = ? AND task_id = ? ORDER BY created_at DESC')
      .get(orgId, taskId) as Row | undefined;
    return row ? mapMailThread(row) : null;
  }

  /** Names the task an assignment thread created - the traceable side of the coupling. */
  linkMailThreadTask(orgId: string, threadId: string, taskId: string): void {
    this.#db
      .prepare('UPDATE mail_threads SET task_id = ? WHERE org_id = ? AND thread_id = ?')
      .run(taskId, orgId, threadId);
  }

  /** Archives (or restores) a whole thread; archived mail leaves the live folders. */
  archiveMailThread(orgId: string, threadId: string, archived: boolean): void {
    this.#db
      .prepare('UPDATE mail_threads SET archived_at = ? WHERE org_id = ? AND thread_id = ?')
      .run(archived ? Date.now() : null, orgId, threadId);
  }

  /**
   * A mailbox as one of the company sees it: `inbox` is everything addressed
   * to `who` via To or Cc, sliced by `folder` - the fixed structure, where
   * `archiv` is the only folder a person puts things into by hand; `outbox`
   * is everything `who` sent, unsliced. Newest first.
   */
  mailbox(
    orgId: string,
    who: MailWho,
    box: 'inbox' | 'outbox',
    opts: { unreadOnly?: boolean; limit?: number; folder?: MailFolder } = {},
  ): Mail[] {
    const limit = opts.limit ?? 50;
    const agentId = who.id ?? null;
    let ids: string[];
    if (box === 'outbox') {
      ids = (
        who.kind === 'agent'
          ? this.#db
              .prepare('SELECT id FROM mail WHERE org_id = ? AND from_kind = ? AND from_agent_id = ? ORDER BY created_at DESC LIMIT ?')
              .all(orgId, who.kind, agentId, limit)
          : this.#db
              .prepare('SELECT id FROM mail WHERE org_id = ? AND from_kind = ? ORDER BY created_at DESC LIMIT ?')
              .all(orgId, who.kind, limit)
      ).map((row) => (row as { id: string }).id);
    } else {
      // Which slice of the inbox: kind is what the thread *is*, decided once
      // when it opened and inherited by every reply.
      const folder = opts.folder ?? 'inbox';
      const clause =
        folder === 'tasks'
          ? "mt.kind = 'assignment' AND mt.archived_at IS NULL"
          : folder === 'reports'
            ? "mt.kind = 'report' AND mt.archived_at IS NULL"
            : folder === 'archiv'
              ? 'mt.archived_at IS NOT NULL'
              : 'mt.archived_at IS NULL';
      ids = (
        who.kind === 'agent'
          ? this.#db
              .prepare(
                `SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
                  JOIN mail_threads mt ON mt.thread_id = m.thread_id
                  WHERE m.org_id = ? AND r.recipient_kind = ? AND r.recipient_id = ? AND (? = 0 OR r.read_at IS NULL)
                  AND ${clause}
                  ORDER BY m.created_at DESC LIMIT ?`,
              )
              .all(orgId, who.kind, agentId, opts.unreadOnly ? 1 : 0, limit)
          : this.#db
              .prepare(
                `SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
                  JOIN mail_threads mt ON mt.thread_id = m.thread_id
                  WHERE m.org_id = ? AND r.recipient_kind = ? AND (? = 0 OR r.read_at IS NULL)
                  AND ${clause}
                  ORDER BY m.created_at DESC LIMIT ?`,
              )
              .all(orgId, who.kind, opts.unreadOnly ? 1 : 0, limit)
      ).map((row) => (row as { id: string }).id);
    }
    return ids.map((id) => this.getMail(id)).filter((mail): mail is Mail => mail !== null);
  }

  /**
   * One conversation, oldest first. A mail-triggered run only ever gets the
   * mail that woke it; without the thread behind it an agent answers a reply
   * having never seen what it replies to.
   */
  thread(orgId: string, threadId: string, opts: { who?: MailWho; limit?: number } = {}): Mail[] {
    const rows = this.#db
      .prepare('SELECT id FROM mail WHERE org_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(orgId, threadId, opts.limit ?? 20) as Row[];
    const mail = rows
      .map((row) => this.getMail(row.id as string))
      .filter((entry): entry is Mail => entry !== null)
      .reverse();
    const who = opts.who;
    if (!who) return mail;
    // Their own view of the conversation: what they wrote, and what they were
    // on. A thread can carry mail they were never a party to.
    const isWho = (kind: RequesterKind, id?: string): boolean =>
      kind === who.kind && (who.kind !== 'agent' || id === who.id);
    return mail.filter(
      (entry) =>
        isWho(entry.fromKind, entry.fromAgentId) ||
        entry.recipients.some((recipient) => isWho(recipient.recipientKind, recipient.recipientId)),
    );
  }

  /** Unread mail addressed to `who` via To or Cc - the "waiting for you" prompt block. */
  unreadMailFor(orgId: string, who: MailWho): Mail[] {
    return this.mailbox(orgId, who, 'inbox', { unreadOnly: true });
  }

  markMailRead(recipientRowIds: string[]): void {
    if (!recipientRowIds.length) return;
    const statement = this.#db.prepare('UPDATE mail_recipients SET read_at = ? WHERE id = ? AND read_at IS NULL');
    const now = Date.now();
    for (const id of recipientRowIds) statement.run(now, id);
  }

  /**
   * The other direction, for the reading pane's "Mark as unread".
   *
   * Opening a mail marks it read on its own, so putting one back is the only
   * way to keep it on the unread list after having looked at it.
   */
  markMailUnread(recipientRowIds: string[]): void {
    if (!recipientRowIds.length) return;
    const statement = this.#db.prepare('UPDATE mail_recipients SET read_at = NULL WHERE id = ?');
    for (const id of recipientRowIds) statement.run(id);
  }

  /** Convenience over markMailRead: marks every recipient row in `mail` that belongs to `who`. */
  markMailReadFor(mail: Mail[], who: MailWho): void {
    const ids = mail.flatMap((entry) =>
      entry.recipients
        .filter((recipient) => recipient.recipientKind === who.kind && (who.kind !== 'agent' || recipient.recipientId === who.id))
        .map((recipient) => recipient.id),
    );
    this.markMailRead(ids);
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
    /** The schedule whose firing made this card, when one did. */
    scheduleId?: string;
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
      title: input.title.trim() || 'Untitled task',
      description: (input.description ?? '').trim(),
      status: input.status ?? 'open',
      priority: input.priority ?? 'normal',
      assigneeId: blank(input.assigneeId),
      createdBy: input.createdBy,
      createdByAgentId: blank(input.createdByAgentId),
      scheduleId: blank(input.scheduleId),
      dependsOn: [...new Set(input.dependsOn ?? [])],
      planNote: blank(input.planNote),
      createdAt: now,
      updatedAt: now,
      // New cards start at the back of their column; drag&drop assigns a real
      // position once someone reorders it.
      sortOrder: now,
    };
    this.#db
      .prepare(
        `INSERT INTO tasks
           (id, org_id, project_id, parent_id, title, description, status, priority, assignee_id,
            created_by, created_by_agent_id, schedule_id, depends_on, plan_note, created_at,
            updated_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.scheduleId ?? null,
        JSON.stringify(task.dependsOn),
        task.planNote ?? null,
        now,
        now,
        task.sortOrder,
      );
    return task;
  }

  /**
   * Take a task for a run, atomically. True when this caller got it.
   *
   * The in-memory `#activeTasks` claim stops two invocations inside one
   * process; it cannot see a second process, and it cannot see a status
   * write that lands between the read and the write - so two processes
   * sharing this database could both decide a task was free and both start
   * a run of it. The condition is the guard, and it is exactly one rule:
   * a task that is already running cannot be taken again.
   *
   * Deliberately not stricter. A finished task is claimable, because a
   * reply in its thread is allowed to set it going again with that reply as
   * its brief (`#continueTask`) - excluding `done` here quietly broke that,
   * and the card simply never moved.
   */
  claimTaskForRun(id: string, startedAt: number): boolean {
    const result = this.#db
      .prepare(
        `UPDATE tasks SET status = 'running', started_at = ?, error = NULL, updated_at = ?
          WHERE id = ? AND status != 'running'`,
      )
      .run(startedAt, Date.now(), id);
    return Number(result.changes) > 0;
  }

  getTask(id: string): Task | null {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? mapTask(row) : null;
  }

  /**
   * Board view: top-level tasks by default, or the subtasks of one parent.
   * `anyLevel` drops the nesting question altogether - a search for every
   * blocked task has to find the ones that hang under a parent too.
   */
  listTasks(
    orgId: string,
    options: {
      parentId?: string | null;
      anyLevel?: boolean;
      status?: TaskStatus[];
      assigneeId?: string;
      limit?: number;
    } = {},
  ): Task[] {
    const clauses = ['org_id = ?'];
    const values: unknown[] = [orgId];
    if (options.parentId !== null && options.parentId !== undefined) {
      clauses.push('parent_id = ?');
      values.push(options.parentId);
    } else if (!options.anyLevel) {
      clauses.push('parent_id IS NULL');
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
      sortOrder?: number;
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
      sort_order: patch.sortOrder,
    });
  }

  /**
   * Tasks still marked running from a previous process are failed on
   * startup, mirroring `failStaleAssignments` above. Returns the rows it
   * changed so the caller can announce them.
   *
   * `planned` is deliberately left alone. A planned task has a plan and no
   * run: nothing about it died with the process, and failing it asserted
   * something untrue - "the server restarted while this was running" - about
   * work the user had knowingly not started yet. Worse, `failed` is what
   * wakes the board watcher, so every boot used to hand it a pile of
   * fabricated failures to act on.
   */
  failStaleTasks(reason: string): Task[] {
    const now = Date.now();
    const rows = this.#db
      .prepare("SELECT * FROM tasks WHERE status = 'running'")
      .all() as Row[];
    if (!rows.length) return [];
    this.#db
      .prepare(
        "UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE status = 'running'",
      )
      .run(reason, now);
    return rows.map((row) =>
      mapTask({ ...row, status: 'failed', error: reason, finished_at: now, updated_at: now }),
    );
  }

  /**
   * Record that this assignment ran this task, keeping every run instead of
   * just the latest: a rerun used to overwrite `tasks.assignment_id` with no
   * trace of the previous (often failed) run, which broke the reverse lookup
   * from an old assignment back to its task. `tasks.assignment_id` still
   * tracks "the current run" for cheap reads; this table is the durable side.
   */
  linkTaskAssignment(taskId: string, assignmentId: string): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO task_assignments (task_id, assignment_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(taskId, assignmentId, Date.now());
    this.updateTask(taskId, { assignmentId });
  }

  /**
   * Which run of its task this one is, counting from one, or null when it
   * belongs to no task. A run inherits its task's name (decision E17), so
   * the chain is the only thing that tells two of them apart in a list -
   * "Run 2" rather than a second, invented title for the same piece of work.
   */
  taskRunNumber(assignmentId: string): number | null {
    const row = this.#db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM task_assignments earlier
                  WHERE earlier.task_id = link.task_id
                    AND (earlier.created_at < link.created_at
                         OR (earlier.created_at = link.created_at AND earlier.assignment_id <= link.assignment_id))
                ) AS position
           FROM task_assignments link
          WHERE link.assignment_id = ?`,
      )
      .get(assignmentId) as { position: number } | undefined;
    return row ? Number(row.position) : null;
  }

  /**
   * How many runs a task has had. Derived from `task_assignments`, which
   * already keeps every run rather than only the latest, so this needs no
   * column of its own and survives a restart the way the rows do.
   *
   * It exists so nothing re-runs a task forever without anyone noticing: a
   * deterministic failure - a project directory that is gone, an assignee
   * that was archived - fails identically every time, and the cost of
   * finding that out again is a whole model run. Callers that restart work
   * on their own initiative check this first; a person asking for another
   * run is not subject to it.
   */
  taskRunCount(taskId: string): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS runs FROM task_assignments WHERE task_id = ?')
      .get(taskId) as { runs: number } | undefined;
    return row ? Number(row.runs) : 0;
  }

  /** The task an assignment belongs to, even one a later rerun's assignment_id overwrote. */
  getTaskIdForAssignment(assignmentId: string): string | null {
    const row = this.#db
      .prepare('SELECT task_id FROM task_assignments WHERE assignment_id = ?')
      .get(assignmentId) as { task_id: string } | undefined;
    return row?.task_id ?? null;
  }

  /* ------------------------------ agent reviews ------------------------------- */

  /**
   * A judgment of one assignment, or a periodic one when `assignmentId` is
   * unset. Always inserts a new row - callers that mean "replace the review
   * for this assignment and source" want {@link upsertReview} instead, which
   * is every caller today (there is no periodic review yet).
   */
  createReview(input: {
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
    tags?: string[];
    failedRun?: boolean;
  }): AgentReview {
    const review: AgentReview = {
      id: randomUUID(),
      orgId: input.orgId,
      agentId: input.agentId,
      assignmentId: blank(input.assignmentId),
      taskId: blank(input.taskId),
      source: input.source,
      overall: clampReviewScore(input.overall),
      quality: clampReviewScoreOptional(input.quality),
      completeness: clampReviewScoreOptional(input.completeness),
      reliability: clampReviewScoreOptional(input.reliability),
      communication: clampReviewScoreOptional(input.communication),
      efficiency: clampReviewScoreOptional(input.efficiency),
      comment: blank(input.comment),
      tags: [...new Set(input.tags ?? [])],
      failedRun: input.failedRun ?? false,
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        `INSERT INTO agent_reviews
           (id, org_id, agent_id, assignment_id, task_id, source, overall, quality, completeness,
            reliability, communication, efficiency, comment, tags, failed_run, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        review.orgId,
        review.agentId,
        review.assignmentId ?? null,
        review.taskId ?? null,
        review.source,
        review.overall,
        review.quality ?? null,
        review.completeness ?? null,
        review.reliability ?? null,
        review.communication ?? null,
        review.efficiency ?? null,
        review.comment ?? null,
        JSON.stringify(review.tags),
        review.failedRun ? 1 : 0,
        review.createdAt,
      );
    return review;
  }

  /**
   * One effective review per (assignment, source) - a second call for the
   * same pair replaces it instead of stacking beside it, matching
   * `idx_agent_reviews_once`. A periodic review (`assignmentId` unset) never
   * collides with another: each is its own row.
   */
  upsertReview(input: {
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
    tags?: string[];
    failedRun?: boolean;
  }): AgentReview {
    if (input.assignmentId) {
      const existing = this.#db
        .prepare('SELECT id FROM agent_reviews WHERE assignment_id = ? AND source = ?')
        .get(input.assignmentId, input.source) as { id: string } | undefined;
      if (existing) {
        const overall = clampReviewScore(input.overall);
        const quality = clampReviewScoreOptional(input.quality);
        const completeness = clampReviewScoreOptional(input.completeness);
        const reliability = clampReviewScoreOptional(input.reliability);
        const communication = clampReviewScoreOptional(input.communication);
        const efficiency = clampReviewScoreOptional(input.efficiency);
        const comment = blank(input.comment);
        const tags = [...new Set(input.tags ?? [])];
        const failedRun = input.failedRun ?? false;
        this.#db
          .prepare(
            `UPDATE agent_reviews
                SET task_id = ?, overall = ?, quality = ?, completeness = ?, reliability = ?,
                    communication = ?, efficiency = ?, comment = ?, tags = ?, failed_run = ?, created_at = ?
              WHERE id = ?`,
          )
          .run(
            blank(input.taskId) ?? null,
            overall,
            quality ?? null,
            completeness ?? null,
            reliability ?? null,
            communication ?? null,
            efficiency ?? null,
            comment ?? null,
            JSON.stringify(tags),
            failedRun ? 1 : 0,
            Date.now(),
            existing.id,
          );
        const updated = this.getReview(existing.id) as AgentReview;
        this.#writeReviewLabel(updated);
        return updated;
      }
    }
    const created = this.createReview(input);
    this.#writeReviewLabel(created);
    return created;
  }

  /**
   * The `review` label (concept 4.2d, S8), written where every review source
   * already meets: `upsertReview` is the one funnel of all four of them -
   * Jarvis's judgement, the system's technical failure, the manager's note
   * and the HTTP route - so one writer here catches them all without four
   * call sites having to remember.
   *
   * Two warnings this source carries, and they are the reason the sentence
   * above is not the whole story. `upsertReview` REPLACES the row for the
   * same `(assignment_id, source)` and resets `created_at`, so a reward once
   * appended can later be revoked silently - and the label follows it,
   * because `(turn_id, target, source)` is the label's key too. Two
   * different review SOURCES scoring one assignment collapse onto that same
   * key for the same reason: the label says `source: 'review'`, not which
   * review. And an agent never receives a correction through `#replay`, so
   * this one blurry source is nearly its whole label supply.
   *
   * It is `gainFrom` that keeps the row out of DCG, never the caller (S8):
   * scoring an assignment from 1 to 5 says nothing about which memory
   * belonged in which prompt, which is why the target is the sentinel `'*'`.
   */
  #writeReviewLabel(review: AgentReview): void {
    const assignment = review.assignmentId ? this.getAssignment(review.assignmentId) : null;
    const label = reviewLabel({
      // The agent's own bank - the population this review is evidence about.
      owner: review.agentId,
      // A periodic review names no assignment; it is keyed on itself, and
      // its scope is session-wide either way.
      assignmentId: review.assignmentId ?? review.id,
      ...(assignment?.sessionId ? { sessionId: assignment.sessionId } : {}),
      overall: review.overall,
      evidence: 'review:' + review.id + ':' + review.source,
      now: review.createdAt,
    });
    // The same statement `Store.putLabels` writes, spelled out here because
    // `OrgStore` holds the raw `Db` and nothing else: reaching the memory
    // store from inside the organisation store would be the wrong direction
    // of dependency for one INSERT.
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO dream_labels
           (turn_id, target, source, relevance, scope, evidence, dead_at, created_at, owner, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        label.turnId,
        label.target,
        label.source,
        label.relevance,
        label.scope,
        label.evidence ?? null,
        label.deadAt ?? null,
        label.createdAt,
        label.owner,
        label.sessionId ?? null,
      );
  }

  getReview(id: string): AgentReview | null {
    const row = this.#db.prepare('SELECT * FROM agent_reviews WHERE id = ?').get(id) as Row | undefined;
    return row ? mapReview(row) : null;
  }

  /** An agent's review history, newest first. */
  listReviews(agentId: string, options: { limit?: number } = {}): AgentReview[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_reviews WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, options.limit ?? 20) as Row[];
    return rows.map(mapReview);
  }

  /** Every review of one assignment - at most one per source. */
  reviewsForAssignment(assignmentId: string): AgentReview[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_reviews WHERE assignment_id = ? ORDER BY created_at DESC')
      .all(assignmentId) as Row[];
    return rows.map(mapReview);
  }

  /* ------------------------------ agent actions ------------------------------- */

  /** Append one entry to an agent's personnel record. */
  createAction(input: {
    orgId: string;
    agentId: string;
    kind: AgentActionKind;
    stage: number;
    reason: string;
    beforeText?: string;
    afterText?: string;
    agentNote?: string;
    handoverText?: string;
    reviewIds?: string[];
    decidedBy: 'user' | 'assistant';
    successorAgentId?: string;
  }): AgentAction {
    const action: AgentAction = {
      id: randomUUID(),
      orgId: input.orgId,
      agentId: input.agentId,
      kind: input.kind,
      stage: input.stage,
      reason: input.reason.trim(),
      beforeText: blank(input.beforeText),
      afterText: blank(input.afterText),
      agentNote: blank(input.agentNote),
      handoverText: blank(input.handoverText),
      reviewIds: [...new Set(input.reviewIds ?? [])],
      decidedBy: input.decidedBy,
      successorAgentId: blank(input.successorAgentId),
      createdAt: Date.now(),
    };
    this.#db
      .prepare(
        `INSERT INTO agent_actions
           (id, org_id, agent_id, kind, stage, reason, before_text, after_text, agent_note,
            handover_text, review_ids, decided_by, successor_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.orgId,
        action.agentId,
        action.kind,
        action.stage,
        action.reason,
        action.beforeText ?? null,
        action.afterText ?? null,
        action.agentNote ?? null,
        action.handoverText ?? null,
        JSON.stringify(action.reviewIds),
        action.decidedBy,
        action.successorAgentId ?? null,
        action.createdAt,
      );
    return action;
  }

  /** One personnel-record entry by id, for the paths that act on a specific one. */
  getAction(id: string): AgentAction | null {
    const row = this.#db.prepare('SELECT * FROM agent_actions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapAction(row) : null;
  }

  /** An agent's personnel record, newest first. */
  listActions(agentId: string, options: { limit?: number } = {}): AgentAction[] {
    const rows = this.#db
      .prepare('SELECT * FROM agent_actions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, options.limit ?? 50) as Row[];
    return rows.map(mapAction);
  }

  /**
   * The judgment that actually counts for one assignment: at most one review
   * per assignment survives, and where several sources judged the same run,
   * `user` beats `assistant` beats `system` (section 2, "Wer bewertet
   * wann"). A periodic review (no `assignmentId`) never competes with
   * anything and always survives on its own. Newest first.
   */
  effectiveReviews(agentId: string, limit = 30): AgentReview[] {
    const rank: Record<string, number> = { user: 0, assistant: 1, system: 2 };
    const rows = this.#db
      .prepare('SELECT * FROM agent_reviews WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(agentId, Math.max(limit * 6, 200)) as Row[];
    const byAssignment = new Map<string, Row>();
    const periodic: Row[] = [];
    for (const row of rows) {
      const assignmentId = row.assignment_id as string | null;
      if (!assignmentId) {
        periodic.push(row);
        continue;
      }
      const existing = byAssignment.get(assignmentId);
      const rowRank = rank[row.source as string] ?? 9;
      const existingRank = existing ? rank[existing.source as string] ?? 9 : 9;
      if (!existing || rowRank < existingRank) {
        byAssignment.set(assignmentId, row);
      }
    }
    return [...byAssignment.values(), ...periodic]
      .map(mapReview)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * The computed, never-materialised view of one agent's standing
   * (docs/concepts/agent-performance-management.md, section 3: "on the fly,
   * not materialised" - O1). A technically failed run counts only toward
   * `failureRate`, never toward the quality average or the escalation
   * triggers below it - punishing an agent for a missing provider or a
   * timeout would blame it for infrastructure.
   */
  performance(agentId: string): AgentPerformance {
    const effective = this.effectiveReviews(agentId, 30);
    const quality = effective.filter((review) => !review.failedRun);
    const last20 = effective.slice(0, 20);
    const failedInLast20 = last20.filter((review) => review.failedRun).length;

    const average10 = quality.slice(0, 10);
    const average = average10.length >= 3 ? mean(average10.map((review) => review.overall)) : null;

    let trend: number | null = null;
    if (quality.length >= 10) {
      const recent5 = mean(quality.slice(0, 5).map((review) => review.overall));
      const prior5 = mean(quality.slice(5, 10).map((review) => review.overall));
      if (recent5 !== null && prior5 !== null) trend = recent5 - prior5;
    }

    return {
      average,
      count: average10.length,
      trend,
      stage: stageFromReviews(quality, this.listActions(agentId, { limit: 50 })),
      failureRate: last20.length ? failedInLast20 / last20.length : 0,
      lastReviewAt: effective[0]?.createdAt,
    };
  }

  /**
   * `agent_note` texts written for this agent since its last `reconfig` -
   * the only part of the personnel record an agent's own prompt is allowed
   * to carry (decision E2). Newest first, capped by the caller.
   */
  agentNotesSince(agentId: string, since?: number): { note: string; createdAt: number }[] {
    const actions = this.listActions(agentId, { limit: 50 });
    const cutoff = since ?? actions.find((action) => action.kind === 'reconfig')?.createdAt ?? 0;
    return actions
      .filter((action) => action.agentNote && action.createdAt >= cutoff)
      .map((action) => ({ note: action.agentNote as string, createdAt: action.createdAt }));
  }

  /**
   * The identity chain (agent-performance-management, phase 4, decision E4):
   * the `replace` action that retired this agent, if any - carries the
   * successor's id and the handover text. Newest first, though there is at
   * most one per agent.
   */
  replacementFor(agentId: string): AgentAction | null {
    const row = this.#db
      .prepare("SELECT * FROM agent_actions WHERE agent_id = ? AND kind = 'replace' ORDER BY created_at DESC LIMIT 1")
      .get(agentId) as Row | undefined;
    return row ? mapAction(row) : null;
  }

  /** The predecessor this agent replaced, if it was hired as one's successor. */
  predecessorFor(agentId: string): Agent | null {
    const row = this.#db
      .prepare("SELECT agent_id FROM agent_actions WHERE kind = 'replace' AND successor_agent_id = ? LIMIT 1")
      .get(agentId) as { agent_id: string } | undefined;
    return row ? this.getAgent(row.agent_id) : null;
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

/** 1..5, rounded to the nearest whole star. */
function clampReviewScore(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}

function clampReviewScoreOptional(value: number | undefined): number | undefined {
  return value === undefined ? undefined : clampReviewScore(value);
}

function parseStringArray(raw: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function optionalScore(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * A pure function of the review history and the last action taken - nothing
 * beyond that is stored, by design (section 4 of the concept doc). `quality`
 * is newest-first, failed runs already excluded.
 *
 * Deliberately simplified against the concept doc's exact wording in two
 * places:
 *
 * - The "one user rating of 1" trigger is read over the last five reviews
 *   rather than unboundedly, and re-triggering a note after one already
 *   exists uses "three fresh reviews since it" rather than a hand-tracked
 *   per-decline counter - the doc stores no extra state, and this is the
 *   simplest function of the data that will not renote the same decline on
 *   every single review while still reacting to a fresh one.
 * - The doc allows up to two reconfigs before a replacement is proposed;
 *   this collapses that to one. `#develop`'s idempotency (only act when the
 *   computed stage exceeds the last action's) cannot represent "stay at
 *   stage 2, but take a second reconfig action" without a second piece of
 *   stored state, which is exactly what O1 rules out - so a single
 *   probation window after the one reconfig decides it: recovered (stage 0)
 *   or a replacement is proposed (stage 3), never a second autonomous
 *   reconfig.
 */
function stageFromReviews(quality: AgentReview[], actions: AgentAction[]): 0 | 1 | 2 | 3 {
  const minData = quality.length;
  if (minData < 3) return 0;

  // A good user rating right after a weak stretch resets everything - the
  // user always wins.
  const newest = quality[0];
  if (newest && newest.source === 'user' && newest.overall >= 4) return 0;

  const recent3 = quality.slice(0, 3);
  const recent5 = quality.slice(0, 5);
  const weakLast3 = recent3.filter((review) => review.overall <= 2).length >= 2;
  const oneStarUser = recent5.some((review) => review.source === 'user' && review.overall === 1);
  const avgLast5 = mean(recent5.map((review) => review.overall));
  const weak = weakLast3 || oneStarUser || (avgLast5 !== null && avgLast5 < 3.0);

  // Only an applied `reconfig` opens the probation window; a pending
  // `reconfig-proposal` deliberately does not. Nothing about the agent has
  // changed yet, so there is nothing to give it probation for - it stays at
  // stage 2 until somebody accepts or rejects the draft, and an unapproved
  // proposal can never escalate on its own to a replacement.
  const lastReconfig = actions.find((action) => action.kind === 'reconfig');
  const lastNote = actions.find((action) => action.kind === 'note');

  if (lastReconfig) {
    if (minData < 10) return weak ? 2 : 0; // not enough fresh data yet to judge the probation window
    const probationWindow = quality.filter((review) => review.createdAt > lastReconfig.createdAt).slice(0, 5);
    if (probationWindow.length < 5) return weak ? 2 : 0; // window still filling
    const probationAverage = mean(probationWindow.map((review) => review.overall));
    return probationAverage !== null && probationAverage < 3.0 ? 3 : 0;
  }

  if (!weak) return 0;

  // Re-trigger a note only once three reviews have landed since the last
  // one, so the same decline is not renoted on every single new review.
  if (lastNote) {
    const since = quality.filter((review) => review.createdAt > lastNote.createdAt);
    return since.length >= 3 ? 2 : 1;
  }
  return 1;
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
    voice: optional(row.voice),
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
    // Rows from before the column existed are named when they are read and
    // never written back: the derivation is cheap, and a backfill would put
    // a guess in the place a real name belongs (decision E15).
    title: optional(row.title) ?? titleFromBrief(row.task as string),
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
    scheduleId: optional(row.schedule_id),
    dependsOn,
    planNote: optional(row.plan_note),
    result: optional(row.result),
    error: optional(row.error),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    startedAt: row.started_at ? Number(row.started_at) : undefined,
    finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
    sortOrder: Number(row.sort_order ?? 0),
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

function mapMail(row: Row, recipients: MailRecipient[]): Mail {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    fromKind: row.from_kind as RequesterKind,
    fromAgentId: optional(row.from_agent_id),
    subject: row.subject as string,
    body: row.body as string,
    threadId: row.thread_id as string,
    inReplyTo: optional(row.in_reply_to),
    depth: Number(row.depth ?? 0),
    assignmentId: optional(row.assignment_id),
    createdAt: Number(row.created_at),
    recipients,
    threadKind: (optional(row.thread_kind) as MailThreadKind | undefined) ?? 'chat',
    threadArchivedAt: optionalScore(row.thread_archived_at),
    taskId: optional(row.thread_task_id),
    taskTitle: optional(row.thread_task_title),
  };
}

function mapMailThread(row: Row): MailThread {
  return {
    threadId: row.thread_id as string,
    orgId: row.org_id as string,
    kind: (row.kind as MailThreadKind | undefined) ?? 'chat',
    taskId: optional(row.task_id),
    archivedAt: optionalScore(row.archived_at),
    createdAt: Number(row.created_at),
  };
}

function mapReview(row: Row): AgentReview {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    agentId: row.agent_id as string,
    assignmentId: optional(row.assignment_id),
    taskId: optional(row.task_id),
    source: row.source as ReviewSource,
    overall: Number(row.overall),
    quality: optionalScore(row.quality),
    completeness: optionalScore(row.completeness),
    reliability: optionalScore(row.reliability),
    communication: optionalScore(row.communication),
    efficiency: optionalScore(row.efficiency),
    comment: optional(row.comment),
    tags: parseStringArray(row.tags),
    failedRun: Number(row.failed_run) === 1,
    createdAt: Number(row.created_at),
  };
}

function mapAction(row: Row): AgentAction {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    agentId: row.agent_id as string,
    kind: row.kind as AgentActionKind,
    stage: Number(row.stage),
    reason: row.reason as string,
    beforeText: optional(row.before_text),
    afterText: optional(row.after_text),
    agentNote: optional(row.agent_note),
    handoverText: optional(row.handover_text),
    reviewIds: parseStringArray(row.review_ids),
    decidedBy: row.decided_by as 'user' | 'assistant',
    successorAgentId: optional(row.successor_agent_id),
    createdAt: Number(row.created_at),
  };
}

function mapMailRecipient(row: Row): MailRecipient {
  return {
    id: row.id as string,
    mailId: row.mail_id as string,
    recipientKind: row.recipient_kind as RequesterKind,
    recipientId: optional(row.recipient_id),
    box: row.box as 'to' | 'cc',
    readAt: row.read_at ? Number(row.read_at) : undefined,
  };
}
