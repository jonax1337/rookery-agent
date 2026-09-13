import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { createSessionSchema, parseOrThrow, patchSessionSchema } from '../schemas.js';

type IdParams = { Params: { id: string } };

/**
 * Session CRUD. A session owns the transcript and the provider-side thread id;
 * `reset` drops only the latter, so history stays readable while the next turn
 * starts the provider cold.
 */
export async function registerSessionRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  // Chat is the assistant's own hub now; `?includeArchived=1` adds the ones
  // filed away, for an archive view.
  app.get(
    '/api/sessions',
    async (
      request: FastifyRequest<{
        Querystring: { limit?: string; kind?: string; includeArchived?: string };
      }>,
    ) => {
      const limit = clampLimit(request.query.limit, 50, 500);
      // No `kind` means "the open list", which leaves mail transcripts out.
      // `kind=mail` is the way to see them anyway.
      const kind = (['chat', 'voice', 'mail'] as const).find((value) => value === request.query.kind);
      return context.assistant.listSessions(limit, undefined, kind, isTruthy(request.query.includeArchived));
    },
  );

  app.post('/api/sessions', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(createSessionSchema, request.body ?? {});
    const session = context.assistant.createSession(input);
    reply.code(201);
    return session;
  });

  app.get('/api/sessions/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const session = context.assistant.getSession(request.params.id);
    if (!session) {
      reply.code(404);
      return { error: 'Not found', message: `No session ${request.params.id}` };
    }
    return { session, messages: context.assistant.store.getMessages(session.id) };
  });

  app.patch('/api/sessions/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const session = context.assistant.getSession(request.params.id);
    if (!session) {
      reply.code(404);
      return { error: 'Not found', message: `No session ${request.params.id}` };
    }
    const patch = parseOrThrow(patchSessionSchema, request.body ?? {});
    context.assistant.store.updateSession(session.id, {
      title: patch.title,
      // null clears the project; undefined leaves it alone.
      projectId: patch.projectId === null ? (undefined as unknown as string) : patch.projectId,
      archived: patch.archived,
    });
    if (patch.projectId === null) {
      context.assistant.store.db.prepare('UPDATE sessions SET project_id = NULL WHERE id = ?').run(session.id);
    }
    return context.assistant.getSession(session.id);
  });

  app.delete('/api/sessions/:id', async (request: FastifyRequest<IdParams>) => {
    context.assistant.deleteSession(request.params.id);
    return { ok: true };
  });

  app.post(
    '/api/sessions/:id/reset',
    async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
      const session = context.assistant.getSession(request.params.id);
      if (!session) {
        reply.code(404);
        return { error: 'Not found', message: `No session ${request.params.id}` };
      }
      context.assistant.resetSessionContext(session.id);
      return { ok: true };
    },
  );
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
