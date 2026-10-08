import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CronSyntaxError, applyConfig, ASSISTANT_MEMORY_OWNER, parseCron } from '@rookery/core';
import type { CronJob, RookeryConfig } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { createNightRunHandler } from './night.js';
import { clampPositiveInt } from './query.js';

const DEFAULT_RUNS_LIMIT = 30;
const MAX_RUNS_LIMIT = 200;

/**
 * The night shift, over HTTP.
 *
 * A run is deliberately not awaited by default: a real night is a minute or
 * two of model calls, and the page follows it live over the websocket rather
 * than holding a request open. `?wait=1` blocks until it is finished, which
 * is what a script or a test wants.
 */
export async function registerSleepRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  /**
   * The nightly job's schedule row. It is Rookery's internal clockwork:
   * `cron.list` hides it from every user-facing surface, and this is the one
   * place that asks for it by name.
   */
  const findSleepJob = (orgId: string): CronJob | undefined =>
    context.assistant.cron.list(orgId, { includeSystem: true }).find((entry) => entry.kind === 'sleep');

  /** What the memory is doing right now, plus the schedule behind it. */
  app.get('/api/sleep/status', async (request: FastifyRequest<{ Querystring: { owner?: string } }>) => {
    const owner = request.query.owner || ASSISTANT_MEMORY_OWNER;
    let schedule = null;
    try {
      const organization = context.assistant.org.activeOrganization();
      schedule = findSleepJob(organization.id) ?? null;
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
          if (!(error instanceof CronSyntaxError)) throw error;
          reply.code(400);
          return { error: error.message };
        }
      }

      const organization = context.assistant.org.activeOrganization();
      const cron = context.assistant.cron;
      let job = findSleepJob(organization.id);
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
    async (request: FastifyRequest<{ Querystring: { owner?: string; limit?: string } }>) =>
      context.assistant.store.listSleepRuns({
        owner: request.query.owner || undefined,
        limit: clampPositiveInt(request.query.limit, DEFAULT_RUNS_LIMIT, MAX_RUNS_LIMIT),
      }),
  );

  /** Start a night by hand: the memory page's "Jetzt schlafen". */
  app.post('/api/sleep/run', createNightRunHandler(context, 'Sleep run failed'));

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
