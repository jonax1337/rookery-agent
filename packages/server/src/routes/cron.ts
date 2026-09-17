import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CronSyntaxError, describeCron, parseCron, readCronScript, upcomingCronRuns } from '@rookery/core';
import type { CronJob } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { requireSameOrigin } from '../auth.js';
import { BadRequestError, cronJobSchema, parseOrThrow, patchCronJobSchema } from '../schemas.js';

type IdParams = { Params: { id: string } };

/** The one job that is Rookery's own clockwork rather than a user's schedule. */
function isInternal(job: CronJob): boolean {
  return job.kind === 'sleep';
}

/**
 * Schedules: the clock's REST surface. The web UI manages jobs here; the
 * assistant manages the same records through its tools. Runs started by hand
 * return at once - the outcome arrives as a `cron` broadcast on the socket,
 * the same way the timer's own runs do.
 */
export async function registerCronRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  // The global same-origin preHandler in server.ts covers every mutating
  // route; reads keep their own check because that hook exempts GET/HEAD and
  // reflected CORS would otherwise allow cross-origin reads.
  const options = { preHandler: requireSameOrigin };
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
      if (error instanceof Error && /needs an agent|No schedule|script|remaining runs|Remaining runs/.test(error.message)) throw new BadRequestError(error.message);
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

  app.get<IdParams>('/api/cron/:id', options, async (request, reply) => {
    const job = cron.get(request.params.id);
    // Same story as the list above: the nightly memory run is not a user
    // schedule, so from this surface it does not exist - not even to read.
    // The memory page asks for it through /api/sleep/status instead.
    if (!job || isInternal(job)) return notFound(reply, 'No schedule ' + request.params.id);
    let scriptSource: string | undefined;
    let scriptError: string | undefined;
    if (job.kind === 'script' && job.script) {
      try { scriptSource = readCronScript(context.assistant.config.home, job.script); }
      catch (error) { scriptError = (error as Error).message; }
    }
    return {
      job,
      scriptSource,
      scriptError,
      runs: cron.runs(job.id, 50),
      running: cron.isRunning(job.id),
      agent: job.agentId ? store.org.getAgent(job.agentId) : null,
      project: job.projectId ? store.org.getProject(job.projectId) : null,
      session: job.sessionId ? store.getSession(job.sessionId) : null,
      // A job off the clock has no upcoming times, and asking for them would
      // mean parsing an expression it does not have.
      next: job.enabled && job.schedule ? upcomingCronRuns(job.schedule, 5).map((date) => date.getTime()) : [],
      description: describeCron(job.schedule),
    };
  });

  app.patch<IdParams>('/api/cron/:id', async (request, reply) => {
    const job = cron.get(request.params.id);
    if (!job || isInternal(job)) return notFound(reply, 'No schedule ' + request.params.id);
    const patch = parseOrThrow(patchCronJobSchema, request.body ?? {});
    if (patch.agentId && !store.org.getAgent(patch.agentId)) return notFound(reply, 'No agent ' + patch.agentId);
    if (patch.projectId && !store.org.getProject(patch.projectId)) return notFound(reply, 'No project ' + patch.projectId);
    return guarded(() => cron.update(job.id, patch));
  });

  app.delete<IdParams>('/api/cron/:id', async (request, reply) => {
    const job = cron.get(request.params.id);
    // The nightly memory run is machinery, not a row somebody deletes: from
    // here it does not exist, and the memory page is where it is managed.
    if (!job || isInternal(job)) return notFound(reply, 'No schedule ' + request.params.id);
    if (!cron.remove(request.params.id)) return notFound(reply, 'No schedule ' + request.params.id);
    return { ok: true };
  });

  /** Fire now. Returns as soon as the run is booked; progress comes over the socket. */
  app.post<IdParams>('/api/cron/:id/run', async (request, reply) => {
    const job = cron.get(request.params.id);
    if (!job || isInternal(job)) return notFound(reply, 'No schedule ' + request.params.id);
    if (cron.isRunning(job.id)) {
      reply.code(409);
      return { error: 'Conflict', message: 'The schedule is running.' };
    }
    if (job.kind === 'script' && job.permission !== 'full') throw new BadRequestError('Review the imported script and grant Full access before running it.');
    if (job.remainingRuns === 0) throw new BadRequestError('This schedule has no remaining runs.');
    void cron.runNow(job.id).catch((error: Error) => context.log.warn('Manual schedule run failed', { error: error.message }));
    reply.code(202);
    return { ok: true };
  });

  /**
   * Give this schedule a webhook, or rotate the one it has.
   *
   * The secret comes back on the job because the page that asked is the only
   * place it is ever shown, and there is nowhere else to look it up later.
   * Calling this again mints a new one and the previous URL stops working: a
   * rotation and a first issue are the same act.
   */
  app.post<IdParams>('/api/cron/:id/webhook', options, async (request, reply) => {
    const job = cron.get(request.params.id);
    if (!job || isInternal(job)) return notFound(reply, 'No schedule ' + request.params.id);
    return { job: cron.enableWebhook(job.id) };
  });

  /** Take the webhook away. Whoever holds the URL holds nothing from here on. */
  app.delete<IdParams>('/api/cron/:id/webhook', options, async (request, reply) => {
    const job = cron.get(request.params.id);
    if (!job || isInternal(job)) return notFound(reply, 'No schedule ' + request.params.id);
    return { job: cron.disableWebhook(job.id) };
  });
}
