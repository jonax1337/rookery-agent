import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { chatInputSchema, formatIssues } from '../schemas.js';
import { openSse, pipeToSse } from '../services/stream.js';

/**
 * SSE fallback for clients that cannot hold a websocket (curl, a plain fetch,
 * a proxy that eats upgrades). One POST equals one turn. The turn is no
 * longer aborted when the client disconnects (Workstream E.1: a closed tab
 * must not kill in-flight work) - the underlying provider CLI keeps running
 * to completion, its result lands in the session/DB as usual, and its
 * completion still reaches every other open connection through the normal
 * org-wide broadcast. There is no separate explicit-cancel affordance for
 * this endpoint today, so nothing here is meant to still be cancellable.
 */
export async function registerChatRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.post('/api/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = chatInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Bad Request', message: formatIssues(parsed.error) };
    }

    const sse = openSse(request, reply);

    context.log.debug('SSE turn started', { sessionId: parsed.data.sessionId });

    await pipeToSse(context.assistant.chat(parsed.data), sse);

    // The response was hijacked; nothing for Fastify left to serialise.
    return reply;
  });
}
