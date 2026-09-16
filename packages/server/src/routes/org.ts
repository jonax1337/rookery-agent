import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AssignmentStatus, MailWho, TaskStatus } from '@rookery/core';
import { fingerprintMcpFile, projectMcpStatus, readProjectMcpFile } from '@rookery/core';
import type { ServerContext } from '../context.js';
import {
  agentSchema,
  assignInputSchema,
  assignmentReviewSchema,
  formatIssues,
  markMailReadSchema,
  sendMailSchema,
  organizationSchema,
  parseOrThrow,
  patchTaskSchema,
  planTaskSchema,
  taskSchema,
  patchAgentSchema,
  patchOrganizationSchema,
  patchProjectSchema,
  patchTeamSchema,
  projectSchema,
  replaceAgentSchema,
  teamSchema,
} from '../schemas.js';
import { openSse, pipeToSse } from '../services/stream.js';

type IdParams = { Params: { id: string } };

/**
 * The organisation's backend: structure (company, projects, teams, agents),
 * activity (assignments, messages) and a way to hand an agent a task without
 * going through the assistant.
 *
 * Everything is scoped to the active company. `GET /api/org` returns the
 * whole picture in one call because the org page needs all of it at once,
 * and the pieces are small.
 */
export async function registerOrgRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const org = (): ReturnType<typeof context.assistant.org.snapshot> =>
    context.assistant.org.snapshot(context.assistant.org.activeOrganization().id);
  const store = context.assistant.store.org;
  const changed = (kind: string, id: string): void => {
    context.assistant.emit('changed', { kind, id });
  };
  const notFound = (reply: FastifyReply, what: string): { error: string; message: string } => {
    reply.code(404);
    return { error: 'Not found', message: what };
  };
  const badRequest = (reply: FastifyReply, what: string): { error: string; message: string } => {
    reply.code(400);
    return { error: 'Bad request', message: what };
  };

  /* ---------------------------------- company --------------------------------- */

  app.get('/api/org', async () => org());

  app.get('/api/org/organizations', async () => store.listOrganizations());

  app.post('/api/org/organizations', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(organizationSchema, request.body ?? {});
    const created = store.createOrganization(input);
    changed('organization', created.id);
    reply.code(201);
    return created;
  });

  app.patch('/api/org/organizations/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getOrganization(request.params.id)) return notFound(reply, 'No organization ' + request.params.id);
    store.updateOrganization(request.params.id, parseOrThrow(patchOrganizationSchema, request.body ?? {}));
    changed('organization', request.params.id);
    return store.getOrganization(request.params.id);
  });

  /* ---------------------------------- projects -------------------------------- */

  app.post('/api/org/projects', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(projectSchema, request.body ?? {});
    const created = store.createProject({ orgId: context.assistant.org.activeOrganization().id, ...input });
    changed('project', created.id);
    reply.code(201);
    return created;
  });

  app.patch('/api/org/projects/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getProject(request.params.id)) return notFound(reply, 'No project ' + request.params.id);
    store.updateProject(request.params.id, parseOrThrow(patchProjectSchema, request.body ?? {}));
    changed('project', request.params.id);
    return store.getProject(request.params.id);
  });

  app.delete('/api/org/projects/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getProject(request.params.id)) return notFound(reply, 'No project ' + request.params.id);
    store.deleteProject(request.params.id);
    changed('project', request.params.id);
    return { ok: true };
  });

  /**
   * A project's own `.mcp.json` - the same file a person's own Claude Code
   * session in that folder would read - and whether it is trusted to start
   * processes for an assignment. Read-only status here; trust/revoke below
   * are the only writes, and they never touch the file itself.
   */
  app.get('/api/org/projects/:id/mcp', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'No project ' + request.params.id);
    const file = project.path ? readProjectMcpFile(project.path) : null;
    return {
      status: projectMcpStatus(file, project.mcpTrust),
      servers: (file?.servers ?? []).map((server) => ({
        name: server.name,
        command: server.command,
        args: server.args,
      })),
    };
  });

  app.post('/api/org/projects/:id/mcp/trust', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'No project ' + request.params.id);
    if (!project.path) return badRequest(reply, 'Project "' + project.name + '" has no directory.');
    const file = readProjectMcpFile(project.path);
    if (!file || !file.servers.length) return badRequest(reply, "No MCP servers in this project's .mcp.json.");
    store.updateProject(project.id, { mcpTrust: { fingerprint: fingerprintMcpFile(file.raw), approvedAt: Date.now() } });
    changed('project', project.id);
    return store.getProject(project.id);
  });

  app.delete('/api/org/projects/:id/mcp/trust', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const project = store.getProject(request.params.id);
    if (!project) return notFound(reply, 'No project ' + request.params.id);
    store.updateProject(project.id, { mcpTrust: null });
    changed('project', project.id);
    return store.getProject(project.id);
  });

  /* ----------------------------------- teams ---------------------------------- */

  app.post('/api/org/teams', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(teamSchema, request.body ?? {});
    const created = store.createTeam({ orgId: context.assistant.org.activeOrganization().id, ...input });
    changed('team', created.id);
    reply.code(201);
    return created;
  });

  app.patch('/api/org/teams/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getTeam(request.params.id)) return notFound(reply, 'No team ' + request.params.id);
    store.updateTeam(request.params.id, parseOrThrow(patchTeamSchema, request.body ?? {}));
    changed('team', request.params.id);
    return store.getTeam(request.params.id);
  });

  app.delete('/api/org/teams/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getTeam(request.params.id)) return notFound(reply, 'No team ' + request.params.id);
    store.deleteTeam(request.params.id);
    changed('team', request.params.id);
    return { ok: true };
  });

  /* ----------------------------------- agents --------------------------------- */

  app.post('/api/org/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(agentSchema, request.body ?? {});
    const created = store.createAgent({ orgId: context.assistant.org.activeOrganization().id, ...input });
    changed('agent', created.id);
    reply.code(201);
    return created;
  });

  app.get('/api/org/agents/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return notFound(reply, 'No agent ' + request.params.id);
    // The identity chain (agent-performance-management, phase 4, decision
    // E4): at most one of predecessor/successor is ever set on a given
    // agent, since a replaced agent stays archived rather than replaced
    // again under the same identity.
    const predecessor = store.predecessorFor(agent.id);
    const replacement = store.replacementFor(agent.id);
    const successorId = replacement?.successorAgentId;
    return {
      agent,
      assignments: store.listAssignments(agent.orgId, { agentId: agent.id, limit: 30 }),
      memories: context.assistant.store.listMemories({
        owner: agent.id,
        limit: 100,
        // An archived predecessor's memories stay visible on its own page,
        // audit-only - `listMemories` already includes them by default.
      }),
      reports: store.listAgents(agent.orgId, { managerId: agent.id }),
      performance: store.performance(agent.id),
      actions: store.listActions(agent.id, { limit: 30 }),
      predecessor: predecessor ? { id: predecessor.id, name: predecessor.name, slug: predecessor.slug } : null,
      successor: successorId ? (() => {
        const successor = store.getAgent(successorId);
        return successor ? { id: successor.id, name: successor.name, slug: successor.slug } : null;
      })() : null,
      handover: predecessor ? undefined : replacement?.handoverText,
    };
  });

  /** An agent's review history, newest first (docs/concepts/agent-performance-management.md). */
  app.get(
    '/api/org/agents/:id/reviews',
    async (request: FastifyRequest<IdParams & { Querystring: { limit?: string } }>, reply: FastifyReply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return notFound(reply, 'No agent ' + request.params.id);
      return store.listReviews(agent.id, { limit: clampLimit(request.query.limit, 20, 100) });
    },
  );

  /**
   * Stage 4 (section 4): the user approves a pending replacement proposal.
   * Archives the outgoing agent and its memory, hires the successor with
   * the given identity, and carries over team/manager/reports - all inside
   * `OrgController.replaceAgent`, never as separate calls a half-finished
   * request could leave inconsistent.
   */
  app.post('/api/org/agents/:id/replace', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return notFound(reply, 'No agent ' + request.params.id);
    const input = parseOrThrow(replaceAgentSchema, request.body ?? {});
    if (input.name.trim().toLowerCase() === agent.name.trim().toLowerCase()) {
      return badRequest(reply, 'The successor needs a different name from ' + agent.name + '.');
    }
    const successor = await context.assistant.org.replaceAgent(agent.orgId, agent.id, input);
    return { predecessor: store.getAgent(agent.id), successor };
  });

  app.patch('/api/org/agents/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getAgent(request.params.id)) return notFound(reply, 'No agent ' + request.params.id);
    store.updateAgent(request.params.id, parseOrThrow(patchAgentSchema, request.body ?? {}));
    changed('agent', request.params.id);
    return store.getAgent(request.params.id);
  });

  /**
   * No hard delete: `deleteAgent` would cascade the agent's assignment
   * history away, and the documented decision is that parting ways means
   * archiving instead - the history must stay
   * (docs/concepts/agent-performance-management.md, stage 4). The route keeps
   * the DELETE verb so a caller asking for removal degrades gracefully to an
   * archive, same end state as PATCH with `{ archived: true }`.
   */
  app.delete('/api/org/agents/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return notFound(reply, 'No agent ' + request.params.id);
    store.updateAgent(agent.id, { archived: true });
    changed('agent', agent.id);
    return { ok: true };
  });

  /**
   * The company-wide performance view - the "HR" page's one call. Archived
   * agents are excluded: there is nothing left to develop once an agent has
   * been replaced, and its personnel record stays reachable from its own
   * (archived) page instead.
   */
  app.get('/api/org/performance', async () => {
    const orgId = context.assistant.org.activeOrganization().id;
    return store.listAgents(orgId).map((agent) => {
      const performance = store.performance(agent.id);
      const latest = store.listActions(agent.id, { limit: 1 })[0];
      return {
        agent: { id: agent.id, name: agent.name, slug: agent.slug, title: agent.title },
        performance,
        pendingProposal: performance.stage === 3 && latest?.kind === 'probation' ? latest : null,
      };
    });
  });

  /* -------------------------------- assignments ------------------------------- */

  app.get(
    '/api/org/assignments',
    async (request: FastifyRequest<{ Querystring: { limit?: string; status?: string; agentId?: string } }>) => {
      const orgId = context.assistant.org.activeOrganization().id;
      const status = (request.query.status ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean) as AssignmentStatus[];
      return store.listAssignments(orgId, {
        limit: clampLimit(request.query.limit, 50, 500),
        status: status.length ? status : undefined,
        agentId: request.query.agentId,
      });
    },
  );

  app.get('/api/org/assignments/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const assignment = store.getAssignment(request.params.id);
    if (!assignment) return notFound(reply, 'No assignment ' + request.params.id);
    return {
      assignment,
      agent: store.getAgent(assignment.agentId),
      children: store.listAssignments(assignment.orgId, { limit: 100 }).filter((a) => a.parentId === assignment.id),
      // Durable, survives a rerun overwriting the task's own `assignmentId`
      // pointer with a newer run - see `task_assignments` in memory/db.ts.
      taskId: store.getTaskIdForAssignment(assignment.id),
      // At most one per source (idx_agent_reviews_once): the run's own
      // `system` verdict if it failed technically, plus Jarvis's and the
      // user's once those exist.
      reviews: store.reviewsForAssignment(assignment.id),
    };
  });

  /**
   * The live log of a running assignment: the buffered entries plus the
   * overflow flag, for a client that sent `watch` first and now merges the
   * frames that follow onto this snapshot by seq. The buffer is deliberately
   * discarded when the run ends - live-only, no DB growth - so an id without
   * one answers from the durable row: 410 with the assignment's final status
   * when it exists, 404 when it never did. Reading the snapshot before the
   * row covers the race where the run finishes in between: the buffer is
   * gone, and the store - not a half-read snapshot - gets the last word.
   */
  app.get('/api/org/assignments/:id/log', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const snapshot = context.assistant.snapshotAssignmentLog(request.params.id);
    if (snapshot.active) return { events: snapshot.events, overflowed: snapshot.overflowed };
    const assignment = store.getAssignment(request.params.id);
    if (!assignment) return notFound(reply, 'No assignment ' + request.params.id);
    reply.code(410);
    return { error: 'Gone', message: 'The run is over; only its result remains.', status: assignment.status };
  });

  /**
   * A user rating for one assignment - a star plus an optional comment,
   * upserted (docs/concepts/agent-performance-management.md, phase 1). Saves
   * on a single click; there is no confirmation step to abandon.
   */
  app.post('/api/org/assignments/:id/review', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const assignment = store.getAssignment(request.params.id);
    if (!assignment) return notFound(reply, 'No assignment ' + request.params.id);
    const input = parseOrThrow(assignmentReviewSchema, request.body ?? {});
    const review = store.upsertReview({
      orgId: assignment.orgId,
      agentId: assignment.agentId,
      assignmentId: assignment.id,
      taskId: store.getTaskIdForAssignment(assignment.id) ?? undefined,
      source: 'user',
      ...input,
    });
    changed('agent', assignment.agentId);
    return review;
  });

  /** Pull the plug on a queued or running assignment; it ends as cancelled. */
  app.post('/api/org/assignments/:id/cancel', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const assignment = store.getAssignment(request.params.id);
    if (!assignment) return notFound(reply, 'No assignment ' + request.params.id);
    if (!context.assistant.org.cancel(assignment.id, 'the user')) {
      reply.code(409);
      return { error: 'Conflict', message: 'The assignment is not running; it is ' + assignment.status + '.' };
    }
    return { ok: true };
  });

  /**
   * Hand an agent a task directly, as SSE. Same shape as POST /api/chat: a
   * closed connection no longer aborts the assignment (Workstream E.1) - it
   * keeps running to completion and broadcasts as usual. Deliberate
   * cancellation still works exactly as before, via
   * POST /api/org/assignments/:id/cancel, which stops the run by assignment
   * id independently of this route's own signal.
   */
  app.post('/api/org/assignments', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = assignInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Bad Request', message: formatIssues(parsed.error) };
    }

    const sse = openSse(request, reply);
    await pipeToSse(context.assistant.assign(parsed.data), sse);
    return reply;
  });

  /* ----------------------------------- tasks ---------------------------------- */

  app.get(
    '/api/org/tasks',
    async (request: FastifyRequest<{ Querystring: { status?: string; all?: string; limit?: string } }>) => {
      const orgId = context.assistant.org.activeOrganization().id;
      if (request.query.all === '1') return store.listAllTasks(orgId, clampLimit(request.query.limit, 200, 1000));
      const status = (request.query.status ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean) as TaskStatus[];
      return store.listTasks(orgId, { status: status.length ? status : undefined, limit: clampLimit(request.query.limit, 100, 500) });
    },
  );

  app.post('/api/org/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(taskSchema, request.body ?? {});
    const orgId = context.assistant.org.activeOrganization().id;
    if (input.assigneeId && !store.getAgent(input.assigneeId)) return notFound(reply, 'No agent ' + input.assigneeId);
    const task = store.createTask({ orgId, ...input, createdBy: 'user' });
    context.assistant.emit('task', { type: 'task', task });
    reply.code(201);
    return task;
  });

  app.get('/api/org/tasks/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, 'No task ' + request.params.id);
    return {
      task,
      children: store.listTasks(task.orgId, { parentId: task.id }),
      assignee: task.assigneeId ? store.getAgent(task.assigneeId) : null,
      assignment: task.assignmentId ? store.getAssignment(task.assignmentId) : null,
    };
  });

  app.patch('/api/org/tasks/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, 'No task ' + request.params.id);
    const patch = parseOrThrow(patchTaskSchema, request.body ?? {});
    if (task.status === 'running') {
      // Cancelling is the one edit allowed mid-run; the run loop records the
      // final status once its assignments have stopped.
      if (patch.status === 'cancelled' && context.assistant.org.cancelTask(task.id)) return task;
      reply.code(409);
      return { error: 'Conflict', message: 'The task is running.' };
    }
    // A manual "done" used to silently disagree with the run it claims to
    // conclude: the linked assignment could say `failed` forever while the
    // board showed a green check. `force` is the explicit override.
    if (patch.status === 'done' && !patch.force) {
      const assignment = task.assignmentId ? store.getAssignment(task.assignmentId) : null;
      if (assignment?.status === 'failed') {
        reply.code(409);
        return {
          error: 'Conflict',
          message: 'The linked assignment failed. Pass force to mark the task done anyway.',
        };
      }
    }
    const { force: _force, ...rest } = patch;
    store.updateTask(task.id, {
      ...rest,
      finishedAt: patch.status && patch.status !== 'open' ? Date.now() : undefined,
    });
    const updated = store.getTask(task.id);
    if (updated) context.assistant.emit('task', { type: 'task', task: updated });
    return updated;
  });

  /** Plan a task from the board: returns the plan; the subtasks land on the board. */
  app.post('/api/org/tasks/:id/plan', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, 'No task ' + request.params.id);
    const input = parseOrThrow(planTaskSchema, request.body ?? {});
    const plan = await context.assistant.planTask(task.id, input.hint);
    return { plan, task: store.getTask(task.id), children: store.listTasks(task.orgId, { parentId: task.id }) };
  });

  /**
   * Run a task from the board, as SSE. Same abort contract as POST
   * /api/chat: a closed connection no longer aborts the run (Workstream
   * E.1). Deliberate cancellation still works via
   * PATCH /api/org/tasks/:id { status: 'cancelled' }, which stops the run by
   * task id independently of this route's own signal.
   */
  app.post('/api/org/tasks/:id/run', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, 'No task ' + request.params.id);
    const sse = openSse(request, reply);
    await pipeToSse(context.assistant.runTask({ taskId: task.id }), sse);
    return reply;
  });

  /* ------------------------------------ mail ----------------------------------- */

  const resolveMailbox = (token: string): MailWho | null => {
    if (token === 'user') return { kind: 'user' };
    if (token === 'assistant') return { kind: 'assistant' };
    return store.getAgent(token) ? { kind: 'agent', id: token } : null;
  };

  app.get(
    '/api/org/mail',
    async (request: FastifyRequest<{ Querystring: { mailbox?: string; box?: string; limit?: string } }>, reply: FastifyReply) => {
      const token = request.query.mailbox ?? 'user';
      const who = resolveMailbox(token);
      if (!who) return notFound(reply, 'No agent ' + token);
      const box = request.query.box === 'outbox' ? 'outbox' : 'inbox';
      const orgId = context.assistant.org.activeOrganization().id;
      return store.mailbox(orgId, who, box, { limit: clampLimit(request.query.limit, 100, 500) });
    },
  );

  app.post('/api/org/mail', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(sendMailSchema, request.body ?? {});
    const orgId = context.assistant.org.activeOrganization().id;
    try {
      // The controller's own broadcast (forwarded through the assistant's
      // `mail` event) reaches every socket; nothing to emit here.
      const mail = await context.assistant.org.sendUserMail({ orgId, ...input });
      reply.code(201);
      return mail;
    } catch (error) {
      return badRequest(reply, (error as Error).message);
    }
  });

  /**
   * Marks a batch of mailbox rows read - the mailbox page calls this on load.
   * `read: false` is the reading pane's "Mark as unread", the one way back.
   */
  app.post('/api/org/mail/read', async (request: FastifyRequest) => {
    const input = parseOrThrow(markMailReadSchema, request.body ?? {});
    if (input.read === false) store.markMailUnread(input.ids);
    else store.markMailRead(input.ids);
    return { ok: true };
  });
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
