import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ASSISTANT_MEMORY_OWNER } from '@rookery/core';
import type { ServerContext } from '../context.js';

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
      schedule = context.assistant.cron.list(organization.id).find((entry) => entry.kind === 'sleep') ?? null;
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
