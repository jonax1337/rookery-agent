import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

/**
 * Listeners, over HTTP. Like the gateways, the settings themselves live on
 * `PATCH /api/config`; this is only what each held-open connection is doing
 * right now. No mailbox password ever appears in the answer - the status says
 * whether one is set and nothing more.
 */
export async function registerListenerRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  app.get('/api/listeners', async () => {
    return { listeners: context.listeners.statuses() };
  });
}
