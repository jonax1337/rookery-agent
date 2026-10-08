import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Agent, AssignmentStatus, NotificationKind, TaskStatus } from '@rookery/core';
import { fingerprintMcpFile, projectMcpStatus, readProjectMcpFile } from '@rookery/core';
import type { ServerContext } from '../context.js';
import {
  agentSchema,
  answerTaskSchema,
  archiveNotificationSchema,
  assignInputSchema,
  assignmentReviewSchema,
  markNotificationsReadSchema,
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
import { clampPositiveInt, isTruthy } from './query.js';

type IdParams = { Params: { id: string } };
type ErrorBody = { error: string; message: string };
type OrgStore = ServerContext['assistant']['store']['org'];

const NOTIFICATION_KINDS: readonly NotificationKind[] = ['schedule', 'watch', 'task', 'question', 'agent', 'sleep', 'system'];

/** What every section of the org routes needs, built once per server. */
interface OrgRouteKit {
  readonly context: ServerContext;
  readonly store: OrgStore;
  readonly activeOrgId: () => string;
  /** Tell every open tab that something in the company changed. */
  readonly changed: (kind: string, id: string) => void;
  readonly notFound: (reply: FastifyReply, what: string) => ErrorBody;
  readonly badRequest: (reply: FastifyReply, what: string) => ErrorBody;
}

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
  const kit: OrgRouteKit = {
    context,
    store: context.assistant.store.org,
    activeOrgId: () => context.assistant.org.activeOrganization().id,
    changed: (kind, id) => {
      context.assistant.emit('changed', { kind, id });
    },
    notFound: (reply, what) => {
      reply.code(404);
      return { error: 'Not found', message: what };
    },
    badRequest: (reply, what) => {
      reply.code(400);
      return { error: 'Bad request', message: what };
    },
  };

  registerCompanyRoutes(app, kit);
  registerProjectRoutes(app, kit);
  registerTeamRoutes(app, kit);
  registerAgentRoutes(app, kit);
  registerAssignmentRoutes(app, kit);
  registerTaskRoutes(app, kit);
  registerNotificationRoutes(app, kit);
}

/* ---------------------------------- company --------------------------------- */

function registerCompanyRoutes(app: FastifyInstance, { context, store, activeOrgId, changed, notFound }: OrgRouteKit): void {
  app.get('/api/org', async () => context.assistant.org.snapshot(activeOrgId()));

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
}

/* ---------------------------------- projects -------------------------------- */

function registerProjectRoutes(app: FastifyInstance, kit: OrgRouteKit): void {
  const { store, activeOrgId, changed, notFound, badRequest } = kit;

  app.post('/api/org/projects', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(projectSchema, request.body ?? {});
    const created = store.createProject({ orgId: activeOrgId(), ...input });
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
}

/* ----------------------------------- teams ---------------------------------- */

function registerTeamRoutes(app: FastifyInstance, { store, activeOrgId, changed, notFound }: OrgRouteKit): void {
  app.post('/api/org/teams', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(teamSchema, request.body ?? {});
    const created = store.createTeam({ orgId: activeOrgId(), ...input });
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
}

/* ----------------------------------- agents --------------------------------- */

function registerAgentRoutes(app: FastifyInstance, kit: OrgRouteKit): void {
  const { context, store, activeOrgId, changed, notFound, badRequest } = kit;

  app.post('/api/org/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(agentSchema, request.body ?? {});
    const created = store.createAgent({ orgId: activeOrgId(), ...input });
    changed('agent', created.id);
    reply.code(201);
    return created;
  });

  app.get('/api/org/agents/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) return notFound(reply, 'No agent ' + request.params.id);
    return describeAgent(kit, agent);
  });

  /** An agent's review history, newest first (docs/concepts/agent-performance-management.md). */
  app.get(
    '/api/org/agents/:id/reviews',
    async (request: FastifyRequest<IdParams & { Querystring: { limit?: string } }>, reply: FastifyReply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return notFound(reply, 'No agent ' + request.params.id);
      return store.listReviews(agent.id, { limit: clampPositiveInt(request.query.limit, 20, 100) });
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

  /**
   * Stage 2 (section 4): the user accepts an instruction rewrite that the
   * escalation drafted but did not apply. Addressed by the proposal's own
   * id, not the agent's, so a stale page cannot accept a draft that a newer
   * one has already replaced. Rejecting needs no call: an unapproved
   * proposal simply never takes effect.
   */
  app.post(
    '/api/org/agents/:id/reconfig/:actionId',
    async (request: FastifyRequest<{ Params: { id: string; actionId: string } }>, reply: FastifyReply) => {
      const agent = store.getAgent(request.params.id);
      if (!agent) return notFound(reply, 'No agent ' + request.params.id);
      const action = store.getAction(request.params.actionId);
      if (!action || action.agentId !== agent.id) return notFound(reply, 'No proposal ' + request.params.actionId);
      if (action.kind !== 'reconfig-proposal') {
        return badRequest(reply, 'That personnel entry is not a pending instruction proposal.');
      }
      const updated = context.assistant.org.applyReconfig(action.id);
      if (!updated) return badRequest(reply, 'The proposal could no longer be applied.');
      return updated;
    },
  );

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
   * The company-wide performance view - the Performance page's one call. Archived
   * agents are excluded: there is nothing left to develop once an agent has
   * been replaced, and its personnel record stays reachable from its own
   * (archived) page instead.
   */
  app.get('/api/org/performance', async () =>
    store.listAgents(activeOrgId()).map((agent) => {
      const performance = store.performance(agent.id);
      const latest = store.listActions(agent.id, { limit: 1 })[0];
      return {
        agent: { id: agent.id, name: agent.name, slug: agent.slug, title: agent.title },
        performance,
        pendingProposal: performance.stage === 3 && latest?.kind === 'probation' ? latest : null,
      };
    }),
  );
}

/** The agent's own page: the record plus everything hanging off it. */
function describeAgent({ context, store }: OrgRouteKit, agent: Agent) {
  // The identity chain (agent-performance-management, phase 4, decision
  // E4): at most one of predecessor/successor is ever set on a given
  // agent, since a replaced agent stays archived rather than replaced
  // again under the same identity.
  const predecessor = store.predecessorFor(agent.id);
  const replacement = store.replacementFor(agent.id);
  const successorId = replacement?.successorAgentId;
  const latestAction = store.listActions(agent.id, { limit: 1 })[0];
  return {
    agent,
    assignments: store.listAssignments(agent.orgId, { agentId: agent.id, limit: 30 }),
    // An archived predecessor's memories stay visible on its own page,
    // audit-only - `listMemories` already includes them by default.
    memories: context.assistant.store.listMemories({ owner: agent.id, limit: 100 }),
    reports: store.listAgents(agent.orgId, { managerId: agent.id }),
    performance: store.performance(agent.id),
    actions: store.listActions(agent.id, { limit: 30 }),
    // A drafted instruction rewrite waiting for the user. It is pending
    // exactly while it is the newest entry: applying it writes a
    // `reconfig` on top, and any later action means the record moved on
    // without it.
    pendingReconfig: latestAction?.kind === 'reconfig-proposal' ? latestAction : null,
    predecessor: agentReference(predecessor),
    successor: successorId ? agentReference(store.getAgent(successorId)) : null,
    handover: predecessor ? undefined : replacement?.handoverText,
  };
}

function agentReference(agent: Pick<Agent, 'id' | 'name' | 'slug'> | null | undefined) {
  return agent ? { id: agent.id, name: agent.name, slug: agent.slug } : null;
}

/* -------------------------------- assignments ------------------------------- */

function registerAssignmentRoutes(app: FastifyInstance, kit: OrgRouteKit): void {
  const { context, store, activeOrgId, changed, notFound } = kit;

  app.get(
    '/api/org/assignments',
    async (request: FastifyRequest<{ Querystring: { limit?: string; status?: string; agentId?: string } }>) => {
      const status = parseList<AssignmentStatus>(request.query.status);
      return store.listAssignments(activeOrgId(), {
        limit: clampPositiveInt(request.query.limit, 50, 500),
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
    // A journalled run answers forever: `active` false only means nothing
    // more is coming, and the client shows the transcript as finished.
    if (snapshot) return { events: snapshot.events, overflowed: snapshot.overflowed, active: snapshot.active };
    const assignment = store.getAssignment(request.params.id);
    if (!assignment) return notFound(reply, 'No assignment ' + request.params.id);
    reply.code(410);
    return { error: 'Gone', message: 'The run predates the journal; only its result remains.', status: assignment.status };
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
    const input = parseOrThrow(assignInputSchema, request.body ?? {});
    const sse = openSse(request, reply);
    await pipeToSse(context.assistant.assign(input), sse);
    return reply;
  });
}

/* ----------------------------------- tasks ---------------------------------- */

function registerTaskRoutes(app: FastifyInstance, kit: OrgRouteKit): void {
  const { context, store, activeOrgId, notFound, badRequest } = kit;

  app.get(
    '/api/org/tasks',
    async (request: FastifyRequest<{ Querystring: { status?: string; all?: string; limit?: string } }>) => {
      const orgId = activeOrgId();
      if (request.query.all === '1') return store.listAllTasks(orgId, clampPositiveInt(request.query.limit, 200, 1000));
      const status = parseList<TaskStatus>(request.query.status);
      return store.listTasks(orgId, {
        status: status.length ? status : undefined,
        limit: clampPositiveInt(request.query.limit, 100, 500),
      });
    },
  );

  app.post('/api/org/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(taskSchema, request.body ?? {});
    if (input.assigneeId && !store.getAgent(input.assigneeId)) return notFound(reply, 'No agent ' + input.assigneeId);
    const task = store.createTask({ orgId: activeOrgId(), ...input, createdBy: 'user' });
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
      // The card's own protocol, oldest first: the brief, every run, every
      // question and answer, every status change.
      events: store.listTaskEvents(task.id),
    };
  });

  /**
   * The user answers the question a card is waiting on. Same road as the
   * `answer_task` tool, as the user and uncapped: the answer goes on the
   * card and the task runs again. Only a waiting card can be answered - a
   * second answer to a question somebody already answered would start the
   * task over.
   */
  app.post('/api/org/tasks/:id/answer', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const task = store.getTask(request.params.id);
    if (!task) return notFound(reply, 'No task ' + request.params.id);
    const input = parseOrThrow(answerTaskSchema, request.body ?? {});
    if (task.status !== 'blocked') {
      return badRequest(reply, 'The task is not waiting for an answer (it is ' + task.status + ').');
    }
    const answered = await context.assistant.org.answerTask({ taskId: task.id, answer: input.answer, orgId: task.orgId });
    if (!answered.ok) return badRequest(reply, answered.reason);
    return { ok: true, task: answered.task };
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
    const { force: _force, status, ...rest } = patch;
    // The status goes through the one writer, which clears what a previous
    // life left on the card, announces it, and writes it into the card's activity.
    // This route used to do all three by hand and was the only writer that
    // did - the tool and the CLI moved the same card in silence.
    //
    // It goes first, so a refused status cannot leave the other edits
    // standing behind a 409 the caller reads as "nothing happened".
    if (status) {
      const moved = await context.assistant.org.setTaskStatus({ task, to: status, by: 'user' });
      if (!moved.ok) {
        reply.code(409);
        return { error: 'Conflict', message: moved.reason };
      }
    }
    if (Object.keys(rest).length) store.updateTask(task.id, rest);
    const edited = store.getTask(task.id);
    if (edited) context.assistant.emit('task', { type: 'task', task: edited });
    return edited;
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
}

/* -------------------------------- notifications ------------------------------ */

function registerNotificationRoutes(app: FastifyInstance, kit: OrgRouteKit): void {
  const { context, store, activeOrgId, notFound, badRequest } = kit;

  /** The inbox's list: newest first, the live shelf unless `archived=1`. */
  app.get(
    '/api/notifications',
    async (
      request: FastifyRequest<{ Querystring: { unread?: string; kind?: string; archived?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const kinds = parseList<NotificationKind>(request.query.kind);
      const unknown = kinds.find((entry) => !NOTIFICATION_KINDS.includes(entry));
      if (unknown) return badRequest(reply, 'No notification kind ' + unknown);
      return store.listNotifications({
        orgId: activeOrgId(),
        unread: isTruthy(request.query.unread),
        archived: isTruthy(request.query.archived),
        ...(kinds.length ? { kind: kinds } : {}),
        limit: clampPositiveInt(request.query.limit, 100, 1000),
      });
    },
  );

  /** The badge: unread and not archived. */
  app.get('/api/notifications/unread-count', async () => ({
    count: store.unreadNotificationCount(activeOrgId()),
  }));

  /**
   * Marks notifications read - by id, or all of them. `read: false` is the
   * reading pane's "Mark as unread". Every open tab refreshes on `changed`;
   * never on `notification`, which the phone would push a second time.
   */
  app.post('/api/notifications/read', async (request: FastifyRequest) => {
    const input = parseOrThrow(markNotificationsReadSchema, request.body ?? {});
    const read = input.read !== false;
    if (input.all) store.markNotificationsRead('all', { read, orgId: activeOrgId() });
    else store.markNotificationsRead(input.ids ?? [], { read });
    context.assistant.emit('changed', { kind: 'notifications', id: 'all' });
    return { ok: true };
  });

  /** Moves one notification into the archive; `archived: false` takes it back out. */
  app.post('/api/notifications/archive', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(archiveNotificationSchema, request.body ?? {});
    if (!store.getNotification(input.id)) return notFound(reply, 'No notification ' + input.id);
    store.archiveNotification(input.id, input.archived !== false);
    context.assistant.emit('changed', { kind: 'notifications', id: 'all' });
    return { ok: true };
  });
}

/** `?status=a,b` as a list; the values are the store's to interpret, not checked here. */
function parseList<T extends string>(raw: string | undefined): T[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0) as T[];
}
