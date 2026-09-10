import type { FastifyInstance } from 'fastify';
import { VERSION, type ServerContext } from '../context.js';

/**
 * Liveness plus the one thing that actually decides whether Rookery can think:
 * whether a provider CLI is installed and logged in.
 */
export async function registerHealthRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get('/api/health', async () => {
    const providers = await context.assistant.providers.statuses();
    return { ok: true, version: VERSION, providers };
  });
}
