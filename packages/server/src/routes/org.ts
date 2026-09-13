import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AssignmentStatus, TaskStatus } from '@rookery/core';
import { fingerprintMcpFile, projectMcpStatus, readProjectMcpFile } from '@rookery/core';
import type { ServerContext } from '../context.js';
import {
  agentSchema,
  assignInputSchema,
  formatIssues,
  markMessagesReadSchema,
  messageSchema,
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

  app.delete('/api/org/projects/:id', async (request: FastifyRequest<IdParams>) => {
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

  app.delete('/api/org/teams/:id', async (request: FastifyRequest<IdParams>) => {
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
    return {
      agent,
      assignments: store.listAssignments(agent.orgId, { agentId: agent.id, limit: 30 }),
      memories: context.assistant.store.listMemories({ owner: agent.id, limit: 100 }),
      reports: store.listAgents(agent.orgId, { managerId: agent.id }),
    };
  });

  app.patch('/api/org/agents/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!store.getAgent(request.params.id)) return notFound(reply, 'No agent ' + request.params.id);
    store.updateAgent(request.params.id, parseOrThrow(patchAgentSchema, request.body ?? {}));
    changed('agent', request.params.id);
    return store.getAgent(request.params.id);
  });

  app.delete('/api/org/agents/:id', async (request: FastifyRequest<IdParams>) => {
    store.deleteAgent(request.params.id);
    changed('agent', request.params.id);
    return { ok: true };
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
    };
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

  /* ---------------------------------- messages -------------------------------- */

  app.get('/api/org/messages', async (request: FastifyRequest<{ Querystring: { limit?: string } }>) => {
    const orgId = context.assistant.org.activeOrganization().id;
    return store.listMessages(orgId, clampLimit(request.query.limit, 100, 500));
  });

  app.post('/api/org/messages', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(messageSchema, request.body ?? {});
    const orgId = context.assistant.org.activeOrganization().id;
    if (input.toAgentId && !store.getAgent(input.toAgentId)) return notFound(reply, 'No agent ' + input.toAgentId);
    // A message from the UI is the user speaking through the assistant's desk:
    // it has no sending agent, and it lands in the recipient's inbox.
    const message = store.postMessage({ orgId, toAgentId: input.toAgentId, content: input.content });
    context.assistant.emit('message', { type: 'message', message });
    reply.code(201);
    return message;
  });

  /** Marks a batch of inbox rows read - the CEO's inbox page calls this on load. */
  app.post('/api/org/messages/read', async (request: FastifyRequest) => {
    const input = parseOrThrow(markMessagesReadSchema, request.body ?? {});
    store.markRead(input.ids);
    return { ok: true };
  });
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}
