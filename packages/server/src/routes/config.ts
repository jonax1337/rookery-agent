import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyConfig } from '@rookery/core';
import type { RookeryConfig } from '@rookery/core';
import { publicConfig, type ServerContext } from '../context.js';
import { parseOrThrow, patchConfigSchema } from '../schemas.js';

/**
 * Config as the browser sees it: never the token, and never the on-disk paths.
 * A PATCH is written through to ~/.rookery/config.json and applied to the live
 * runtime, so changing the assistant's name or the memory budget takes effect
 * on the next turn rather than the next restart.
 */
/**
 * Turn the two ways a client can talk about a write-only secret into the two
 * things the merge understands.
 *
 * A form that renders an empty password field sends an empty string back on
 * every save, because that is what it was handed - GET never returns the real
 * one. Merging that would wipe the token whenever somebody changed the quiet
 * hours. So: empty means "leave it alone" and is dropped from the patch,
 * `null` means "clear it" and becomes the empty string the config stores.
 */
function normaliseSecrets(patch: Record<string, unknown>): void {
  const telegram = (patch.gateways as { telegram?: { token?: string | null } } | undefined)?.telegram;
  if (!telegram || !('token' in telegram)) return;
  if (telegram.token === null) telegram.token = '';
  else if (!telegram.token) delete telegram.token;
}

export async function registerConfigRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get('/api/config', async () => publicConfig(context.config));

  app.patch('/api/config', async (request: FastifyRequest) => {
    const patch = parseOrThrow(patchConfigSchema, request.body ?? {});
    normaliseSecrets(patch);
    // applyConfig deep-merges into the file, so a partial `memory`/`voice`
    // object is exactly what it wants; the cast only bridges Zod's
    // deep-partial shape. It updates the config in place, and the server and
    // the Assistant hold the same object, so a turn started after this PATCH
    // sees the new settings without anything being copied across.
    const updated = applyConfig(context.config, patch as Partial<RookeryConfig>);

    // The registry keeps its own copy of the fallback settings for provider
    // resolution, refreshed by `sync` like after a profile change; without
    // this, a threshold change would only take effect after a restart.
    if (patch.providerFallback) {
      context.assistant.providers.sync(updated);
    }

    // A gateway reads its settings live but only notices a change when it is
    // told: without this, switching Telegram on in the UI would do nothing
    // until the next restart, while the page already refetches the status and
    // expects it to have flipped. A channel that refuses to start says so in
    // its own log and its `lastError`, so a failure here must not fail the
    // PATCH the user just made.
    if (patch.gateways) {
      await Promise.all(
        context.gateways.map((gateway) =>
          gateway.refresh().catch((error: unknown) => {
            context.log.warn('Gateway did not follow the config change', {
              gateway: gateway.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }),
        ),
      );
    }

    context.log.info('Config updated', { keys: Object.keys(patch) });
    return publicConfig(updated);
  });
}
