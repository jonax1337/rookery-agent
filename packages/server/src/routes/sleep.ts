import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CronSyntaxError, applyConfig, ASSISTANT_MEMORY_OWNER, parseCron } from '@rookery/core';
import type { RookeryConfig } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { BadRequestError } from '../schemas.js';

/**
 * The night shift, over HTTP.
 *
 * A run is deliberately not awaited by default: a real night is a minute or
 * two of model calls, and the page follows it live over the websocket rather
 * than holding a request open. `?wait=1` blocks until it is finished, which
 * is what a script or a test wants.
 */
export async function registerSleepRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  /** What the memory is doing right now, plus the schedule behind it. */
  app.get('/api/sleep/status', async (request: FastifyRequest<{ Querystring: { owner?: string } }>) => {
    const owner = request.query.owner || ASSISTANT_MEMORY_OWNER;
    let schedule = null;
    try {
      const organization = context.assistant.org.activeOrganization();
      // The sleep job is Rookery's internal clockwork: `cron.list` hides it
      // from every user-facing surface, and this is the one place that asks
      // for it by name.
      schedule =
        context.assistant.cron
          .list(organization.id, { includeSystem: true })
          .find((entry) => entry.kind === 'sleep') ?? null;
    } catch {
      // No company yet is not an error; it only means no schedule row exists.
    }
    return {
      owner,
      running: context.assistant.sleep.isRunning(owner),
      activeOwners: context.assistant.sleep.activeOwners,
      lastRun: context.assistant.store.listSleepRuns({ owner, limit: 1 })[0] ?? null,
      schedule,
      config: context.config.memory.sleep,
    };
  });

  /**
   * Manage the nightly run's own schedule from the memory page. The sleep
   * job is not reachable through /api/cron on purpose - it is not a user
   * schedule - so this is the only door to it. A change is written to the
   * cron row and mirrored into the config, because the config is what the
   * next boot checks; changing only the row would quietly drift back.
   */
  app.patch(
    '/api/sleep/schedule',
    async (
      request: FastifyRequest<{ Body?: { schedule?: string; enabled?: boolean } }>,
      reply: FastifyReply,
    ) => {
      const scheduleInput = typeof request.body?.schedule === 'string' ? request.body.schedule.trim() : '';
      const enabledInput = typeof request.body?.enabled === 'boolean' ? request.body.enabled : undefined;
      if (!scheduleInput && enabledInput === undefined) {
        reply.code(400);
        return { error: 'Nothing to change; pass a schedule or an enabled flag.' };
      }

      let expression: string | undefined;
      if (scheduleInput) {
        try {
          expression = parseCron(scheduleInput).expression;
        } catch (error) {
          if (error instanceof CronSyntaxError) {
            reply.code(400);
            return { error: (error as Error).message };
          }
          throw error;
        }
      }

      const organization = context.assistant.org.activeOrganization();
      const cron = context.assistant.cron;
      let job = cron.list(organization.id, { includeSystem: true }).find((entry) => entry.kind === 'sleep');
      if (!job) {
        job = cron.create({
          orgId: organization.id,
          name: 'Memory sleep',
          schedule: expression ?? context.config.memory.sleep.schedule,
          kind: 'sleep',
          prompt: context.config.memory.sleep.scope,
          enabled: enabledInput,
          createdBy: 'user',
        });
      } else {
        job = cron.update(job.id, {
          ...(expression ? { schedule: expression } : {}),
          ...(enabledInput === undefined ? {} : { enabled: enabledInput }),
        });
      }

      // Mirror what changed into the config: `ensureSleepSchedule` follows
      // the config on the next boot, so the row and the config have to say
      // the same thing or the change would not survive a restart.
      applyConfig(context.config, {
        memory: {
          sleep: {
            ...(expression ? { schedule: expression } : {}),
            ...(enabledInput === undefined ? {} : { enabled: enabledInput }),
          },
        },
        // A deep-partial sleep object is exactly what applyConfig merges; the
        // cast only bridges the full-object shape of RookeryConfig, the same
        // bridge routes/config.ts crosses for its PATCHes.
      } as unknown as Partial<RookeryConfig>);

      return { schedule: job, config: context.config.memory.sleep };
    },
  );

  app.get(
    '/api/sleep/runs',
    async (request: FastifyRequest<{ Querystring: { owner?: string; limit?: string } }>) => {
      const limit = Number(request.query.limit);
      return context.assistant.store.listSleepRuns({
        owner: request.query.owner || undefined,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 30,
      });
    },
  );

  /** Start a night by hand: the memory page's "Jetzt schlafen". */
  app.post(
    '/api/sleep/run',
    async (
      request: FastifyRequest<{ Querystring: { owner?: string; wait?: string }; Body?: { owner?: string } }>,
      reply: FastifyReply,
    ) => {
      const owner = request.body?.owner || request.query.owner || ASSISTANT_MEMORY_OWNER;
      if (context.assistant.sleep.isRunning(owner)) {
        reply.code(409);
        return { error: 'This memory bank is already sleeping.' };
      }
      const wait = request.query.wait === '1' || request.query.wait === 'true';
      if (wait) return context.assistant.sleepNow(owner);

      // Fire and forget: the client watches the `sleep` frames on the socket.
      void context.assistant.sleepNow(owner).catch((error: Error) => {
        context.log.warn('Sleep run failed', { owner, error: error.message });
      });
      reply.code(202);
      return { started: true, owner };
    },
  );

  /** Take one night back, in a single transaction. */
  app.post(
    '/api/sleep/runs/:id/undo',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const result = context.assistant.undoSleep(request.params.id);
      if (!result) {
        reply.code(404);
        return { error: 'This run does not exist or has already been undone.' };
      }
      return result;
    },
  );

  /** Abort a night in progress. What is already done stays done. */
  app.post('/api/sleep/cancel', async (request: FastifyRequest<{ Querystring: { owner?: string } }>) => {
    const owner = request.query.owner || ASSISTANT_MEMORY_OWNER;
    return { cancelled: context.assistant.sleep.cancel(owner) };
  });
}
