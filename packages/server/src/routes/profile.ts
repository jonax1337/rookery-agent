import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importMigration, previewMigration, readProfile, writeProfileFile } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { BadRequestError, parseOrThrow } from '../schemas.js';
import { requireSameOrigin } from '../auth.js';

const fileName = z.enum(['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md']);
const migrationInput = z.object({
  source: z.enum(['hermes', 'openclaw']),
  sourcePath: z.string().trim().min(1).max(4096).refine((value) => !value.includes('\0')).optional(),
}).strict();
const importInput = migrationInput.extend({
  expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  selection: z.object({
    files: z.array(z.string().min(1).max(4096)).max(1000),
    jobs: z.array(z.string().min(1).max(4096)).max(1000),
  }).strict().optional(),
});

function profileOperation<T>(operation: () => T): T {
  try { return operation(); }
  catch (error) {
    if (error instanceof Error && 'statusCode' in error) throw error;
    throw new BadRequestError(error instanceof Error ? error.message : 'Profile operation failed.');
  }
}

export async function registerProfileRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  // The global same-origin preHandler in server.ts covers every mutating
  // route; reads keep their own check because that hook exempts GET/HEAD and
  // reflected CORS would otherwise allow cross-origin reads.
  const options = { preHandler: requireSameOrigin };
  app.get('/api/profile', options, async () => profileOperation(() => readProfile(context.config)));
  app.patch('/api/profile/:name', async (request) => {
    const { name } = parseOrThrow(z.object({ name: fileName }), request.params);
    const { content } = parseOrThrow(z.object({ content: z.string().max(1024 * 1024) }).strict(), request.body);
    profileOperation(() => writeProfileFile(context.config, name, content));
    return { ok: true };
  });
  app.post('/api/migration/preview', async (request) => {
    const { source, sourcePath } = parseOrThrow(migrationInput, request.body);
    return profileOperation(() => previewMigration(context.config, source, sourcePath));
  });
  app.post('/api/migration/import', async (request) => {
    const { source, sourcePath, expectedFingerprint, selection } = parseOrThrow(importInput, request.body);
    const result = profileOperation(() => importMigration(context.config, source, sourcePath, expectedFingerprint, selection));
    for (const id of result.jobs) {
      const job = context.assistant.cron.get(id);
      if (job) context.assistant.emit('cron', { type: 'cron', job });
    }
    return result;
  });
}
