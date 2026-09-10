import type { FastifyInstance, FastifyRequest } from 'fastify';
import { saveConfig } from '@rookery/core';
import type { RookeryConfig } from '@rookery/core';
import { publicConfig, type ServerContext } from '../context.js';
import { parseOrThrow, patchConfigSchema } from '../schemas.js';

/**
 * Config as the browser sees it: never the token, and never the on-disk paths.
 * A PATCH is written through to ~/.rookery/config.json and applied to the live
 * runtime, so changing the assistant's name or the memory budget takes effect
 * on the next turn rather than the next restart.
 */
export async function registerConfigRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get('/api/config', async () => publicConfig(context.config));

  app.patch('/api/config', async (request: FastifyRequest) => {
    const patch = parseOrThrow(patchConfigSchema, request.body ?? {});
    // saveConfig deep-merges, so a partial `memory`/`voice` object is exactly
    // what it wants; the cast only bridges Zod's deep-partial shape.
    const updated = saveConfig(patch as Partial<RookeryConfig>, context.config.home);

    context.config = updated;
    // The Assistant holds its own reference; keep the two in step so a turn
    // started after this PATCH uses the new settings.
    Object.assign(context.assistant.config, updated);

    context.log.info('Config updated', { keys: Object.keys(patch) });
    return publicConfig(updated);
  });
}
