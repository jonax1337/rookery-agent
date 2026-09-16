import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  PROVIDER_CATALOG,
  applyConfig,
  providerBlocked,
  providerCatalogEntry,
  providerQuota,
  publicProviderProfile,
  withProviderProfile,
  withoutProviderProfile,
} from '@rookery/core';
import type { ServerContext } from '../context.js';
import { parseOrThrow, providerProfilePatchSchema } from '../schemas.js';

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
        // Parked for quota says so here too, so a signed-in provider that is
        // still not being chosen can explain itself on the dashboard.
        const usageBlocked = providerBlocked(status.id);
        try {
          // Catalogue-backed providers answer without a login, so the composer
          // can show what they serve while their key is still missing; the
          // picker disables what is not usable yet. Asking a CLI that is not
          // logged in would only produce an error, so that case still waits.
          const known = Boolean(providerCatalogEntry(status.id));
          if (!known && (!status.available || !status.authenticated)) {
            return { ...status, usageBlocked, models: [], modelOptions: [] };
          }
          const modelOptions = await registry.models(status.id);
          return { ...status, usageBlocked, models: modelOptions.map((model) => model.id), modelOptions };
        } catch (error) {
          return { ...status, usageBlocked, models: [], modelOptions: [], modelsError: (error as Error).message };
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
      if (!context.assistant.providers.has(id)) {
        reply.code(404);
        return { error: 'Not found', message: 'No provider ' + id };
      }
      return providerQuota(id, isTruthy(request.query.refresh));
    },
  );

  const notFound = (reply: FastifyReply, message: string): { error: string; message: string } => {
    reply.code(404);
    return { error: 'Not Found', message };
  };

  /**
   * The providers that can be set up here, each with whatever the user has
   * already stored for it. One call, because the page shows exactly this:
   * a row per known provider, set up or not.
   */
  app.get('/api/providers/catalog', async () => {
    const stored = new Map(context.config.providerProfiles.map((profile) => [profile.id, profile]));
    return PROVIDER_CATALOG.map((entry) => {
      const profile = stored.get(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        needs: entry.needs,
        hint: entry.hint,
        configured: Boolean(profile),
        authTokenSet: Boolean(profile?.authToken),
      };
    });
  });

  /** Alternative backends for the `claude` binary; secrets never round-trip. */
  app.get('/api/providers/profiles', async () => context.config.providerProfiles.map(publicProviderProfile));

  app.patch(
    '/api/providers/profiles/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = request.params.id;
      if (!/^[a-z0-9-]+$/.test(id)) return notFound(reply, 'Profile ids are lowercase slugs.');
      if (id === 'claude' || id === 'codex') return notFound(reply, 'That id is a built-in provider.');
      const patch = parseOrThrow(providerProfilePatchSchema, request.body ?? {});
      // Same null/empty rule as the Telegram bot token: null clears a stored
      // key, empty or absent leaves whatever is already there alone.
      const authToken = patch.authToken === null ? '' : patch.authToken || undefined;
      applyConfig(context.config, withProviderProfile(context.config, id, { ...patch, authToken }));
      context.assistant.providers.sync(context.config);
      context.assistant.emit('changed', { kind: 'providers', id });
      const updated = context.config.providerProfiles.find((profile) => profile.id === id);
      return updated ? publicProviderProfile(updated) : notFound(reply, 'Gone');
    },
  );

  app.delete(
    '/api/providers/profiles/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>) => {
      const id = request.params.id;
      applyConfig(context.config, withoutProviderProfile(context.config, id));
      context.assistant.providers.sync(context.config);
      context.assistant.emit('changed', { kind: 'providers', id });
      return { ok: true };
    },
  );
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
