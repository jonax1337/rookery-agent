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
export async function registerConfigRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get('/api/config', async () => publicConfig(context.config));

  app.patch('/api/config', async (request: FastifyRequest) => {
    const patch = parseOrThrow(patchConfigSchema, request.body ?? {});
    // applyConfig deep-merges into the file, so a partial `memory`/`voice`
    // object is exactly what it wants; the cast only bridges Zod's
    // deep-partial shape. It updates the config in place, and the server and
    // the Assistant hold the same object, so a turn started after this PATCH
    // sees the new settings without anything being copied across.
    const updated = applyConfig(context.config, patch as Partial<RookeryConfig>);

    context.log.info('Config updated', { keys: Object.keys(patch) });
    return publicConfig(updated);
  });
}
