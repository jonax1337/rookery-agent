import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { createSessionSchema, parseOrThrow, patchSessionSchema } from '../schemas.js';
import { clampPositiveInt, isTruthy } from './query.js';

type IdParams = { Params: { id: string } };

const DEFAULT_SESSION_LIMIT = 50;
const MAX_SESSION_LIMIT = 500;

/**
 * Session CRUD. A session owns the transcript and the provider-side thread id;
 * `reset` drops only the latter, so history stays readable while the next turn
 * starts the provider cold.
 */
export async function registerSessionRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  const notFound = (reply: FastifyReply, id: string): { error: string; message: string } => {
    reply.code(404);
    return { error: 'Not found', message: `No session ${id}` };
  };

  // Chat is the assistant's own hub now; `?includeArchived=1` adds the ones
  // filed away, for an archive view.
  app.get(
    '/api/sessions',
    async (
      request: FastifyRequest<{
        Querystring: { limit?: string; kind?: string; includeArchived?: string };
      }>,
    ) => {
      const limit = clampPositiveInt(request.query.limit, DEFAULT_SESSION_LIMIT, MAX_SESSION_LIMIT);
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
    if (!session) return notFound(reply, request.params.id);
    return { session, messages: context.assistant.store.getMessages(session.id) };
  });

  /**
   * The turn of this conversation a client should rejoin, from the journal.
   *
   * This is the reload's half of the handover: the events that already
   * happened, numbered; the websocket `attach` frame is the other half and
   * continues from the same numbers. `turn: null` when nothing is running
   * and nothing unfinished is worth showing.
   */
  app.get('/api/sessions/:id/running', async (request: FastifyRequest<IdParams>) => {
    const rejoin = context.assistant.store.turns.rejoinable(request.params.id);
    if (!rejoin) return { turn: null, events: [] };
    return { turn: rejoin.turn, events: rejoin.events };
  });

  app.patch('/api/sessions/:id', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const session = context.assistant.getSession(request.params.id);
    if (!session) return notFound(reply, request.params.id);
    const { projectId, ...patch } = parseOrThrow(patchSessionSchema, request.body ?? {});
    // `updateSession` leaves a field alone when it is undefined and has no way
    // to write NULL, so a cleared project (`null`) takes the direct statement.
    context.assistant.store.updateSession(session.id, {
      ...patch,
      ...(projectId ? { projectId } : {}),
    });
    if (projectId === null) {
      context.assistant.store.db.prepare('UPDATE sessions SET project_id = NULL WHERE id = ?').run(session.id);
    }
    // Announce it the way the org does: every tab refetches its lists on a
    // `changed`, and the one holding this conversation rechecks it.
    context.assistant.emit('changed', { kind: 'session', id: session.id });
    return context.assistant.getSession(session.id);
  });

  app.delete('/api/sessions/:id', async (request: FastifyRequest<IdParams>) => {
    context.assistant.deleteSession(request.params.id);
    // Same broadcast: the row leaves every other tab's list, and the tab with
    // this conversation open leaves it rather than answering into the void.
    context.assistant.emit('changed', { kind: 'session', id: request.params.id });
    return { ok: true };
  });

  app.post('/api/sessions/:id/reset', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const session = context.assistant.getSession(request.params.id);
    if (!session) return notFound(reply, request.params.id);
    context.assistant.resetSessionContext(session.id);
    return { ok: true };
  });
}
