import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../context.js';
import { parseOrThrow } from '../schemas.js';

const installSchema = z.object({ force: z.boolean().optional() }).strict();

/**
 * New releases from npm. GET answers from what the last check found; the
 * periodic check runs in the background, and POST /check is the button.
 * POST /install answers first and shuts the server down right after - the
 * page then waits for the new version to come back on its own.
 */
export async function registerUpdateRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  app.get('/api/updates', async () => context.updates.status());

  app.post('/api/updates/check', async () => {
    await context.updates.check();
    return context.updates.status();
  });

  app.post('/api/updates/install', async (request: FastifyRequest, reply) => {
    const { force } = parseOrThrow(installSchema, request.body ?? {});
    const result = context.updates.install({ force: force ?? false });
    return reply.code(202).send(result);
  });
}
