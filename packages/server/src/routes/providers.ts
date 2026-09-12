import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { providerQuota } from '@rookery/core';
import type { ServerContext } from '../context.js';

/**
 * Provider health, plus the models each one accepts so a UI can offer a
 * picker. Probing Claude costs a real (tiny) turn, so the registry caches it;
 * `?refresh=1` is the explicit "I just logged in, look again".
 */
export async function registerProviderRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get(
    '/api/providers',
    async (request: FastifyRequest<{ Querystring: { refresh?: string } }>, reply) => {
      reply.header('Cache-Control', 'no-store');
      const refresh = isTruthy(request.query.refresh);
      const registry = context.assistant.providers;
      if (refresh) registry.invalidate();
      const statuses = await registry.statuses(refresh);
      return Promise.all(statuses.map(async (status) => {
        if (!status.available || !status.authenticated) return { ...status, models: [], modelOptions: [] };
        try {
          const modelOptions = (await registry.get(status.id).models()).map((model) =>
            typeof model === 'string' ? { id: model, name: model } : model);
          return { ...status, models: modelOptions.map((model) => model.id), modelOptions };
        } catch (error) {
          return { ...status, models: [], modelOptions: [], modelsError: (error as Error).message };
        }
      }));
    },
  );

  // Subscription usage of one provider, read with the CLI's own login. Cached
  // in core, so a UI may ask as often as it likes; `?refresh=1` forces a read.
  app.get(
    '/api/providers/:id/usage',
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { refresh?: string } }>,
      reply: FastifyReply,
    ) => {
      const id = request.params.id;
      if (id !== 'claude' && id !== 'codex') {
        reply.code(404);
        return { error: 'Not found', message: 'No provider ' + id };
      }
      return providerQuota(id, isTruthy(request.query.refresh));
    },
  );
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
