import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CronSyntaxError, describeCron, parseCron, upcomingCronRuns } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { BadRequestError, cronJobSchema, parseOrThrow, patchCronJobSchema } from '../schemas.js';

type IdParams = { Params: { id: string } };

/**
 * Schedules: the clock's REST surface. The web UI manages jobs here; the
 * assistant manages the same records through its tools. Runs started by hand
 * return at once - the outcome arrives as a `cron` broadcast on the socket,
 * the same way the timer's own runs do.
 */
export async function registerCronRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const cron = context.assistant.cron;
  const store = context.assistant.store;
  const orgId = (): string => context.assistant.org.activeOrganization().id;
  const notFound = (reply: FastifyReply, what: string): { error: string; message: string } => {
    reply.code(404);
    return { error: 'Not found', message: what };
  };
  /** A bad expression is the client's mistake, not a server failure. */
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof CronSyntaxError) throw new BadRequestError(error.message);
      if (error instanceof Error && /needs an agent|No schedule/.test(error.message)) throw new BadRequestError(error.message);
      throw error;
    }
  };

  app.get('/api/cron', async () => {
    const id = orgId();
    const jobs = cron.list(id);
    return {
      jobs,
      runs: cron.recentRuns(id, 50),
      running: jobs.filter((job) => cron.isRunning(job.id)).map((job) => job.id),
    };
  });

  /** Validate an expression and show when it would fire, for the form. */
  app.get('/api/cron/preview', async (request: FastifyRequest<{ Querystring: { schedule?: string } }>) => {
    const raw = request.query.schedule ?? '';
    try {
      const schedule = parseCron(raw);
      return {
        ok: true,
        schedule: schedule.expression,
        description: describeCron(schedule),
        next: upcomingCronRuns(schedule, 5).map((date) => date.getTime()),
      };
    } catch (error) {
      return { ok: false, schedule: raw, description: '', next: [], error: (error as Error).message };
    }
  });

  app.post('/api/cron', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(cronJobSchema, request.body ?? {});
    if (input.agentId && !store.org.getAgent(input.agentId)) return notFound(reply, 'No agent ' + input.agentId);
    if (input.projectId && !store.org.getProject(input.projectId)) return notFound(reply, 'No project ' + input.projectId);
    const job = guarded(() => cron.create({ orgId: orgId(), ...input, createdBy: 'user' }));
    reply.code(201);
    return job;
  });

  app.get('/api/cron/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const job = cron.get(request.params.id);
    if (!job) return notFound(reply, 'No schedule ' + request.params.id);
    return {
      job,
      runs: cron.runs(job.id, 50),
      running: cron.isRunning(job.id),
      agent: job.agentId ? store.org.getAgent(job.agentId) : null,
      project: job.projectId ? store.org.getProject(job.projectId) : null,
      session: job.sessionId ? store.getSession(job.sessionId) : null,
      next: job.enabled ? upcomingCronRuns(job.schedule, 5).map((date) => date.getTime()) : [],
      description: describeCron(job.schedule),
    };
  });

  app.patch('/api/cron/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const job = cron.get(request.params.id);
    if (!job) return notFound(reply, 'No schedule ' + request.params.id);
    const patch = parseOrThrow(patchCronJobSchema, request.body ?? {});
    if (patch.agentId && !store.org.getAgent(patch.agentId)) return notFound(reply, 'No agent ' + patch.agentId);
    if (patch.projectId && !store.org.getProject(patch.projectId)) return notFound(reply, 'No project ' + patch.projectId);
    return guarded(() => cron.update(job.id, patch));
  });

  app.delete('/api/cron/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    if (!cron.remove(request.params.id)) return notFound(reply, 'No schedule ' + request.params.id);
    return { ok: true };
  });

  /** Fire now. Returns as soon as the run is booked; progress comes over the socket. */
  app.post('/api/cron/:id/run', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const job = cron.get(request.params.id);
    if (!job) return notFound(reply, 'No schedule ' + request.params.id);
    if (cron.isRunning(job.id)) {
      reply.code(409);
      return { error: 'Conflict', message: 'Der Zeitplan läuft gerade.' };
    }
    void cron.runNow(job.id).catch((error: Error) => context.log.warn('Manual schedule run failed', { error: error.message }));
    reply.code(202);
    return { ok: true };
  });
}
