import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { chatInputSchema, formatIssues } from '../schemas.js';
import { openSse, pipeToSse } from '../services/stream.js';

/**
 * SSE fallback for clients that cannot hold a websocket (curl, a plain fetch,
 * a proxy that eats upgrades). One POST equals one turn; the turn is aborted
 * as soon as the client disconnects, so a closed tab never leaves a provider
 * CLI running.
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

    const controller = new AbortController();
    const sse = openSse(request, reply);

    // Watch the *response*, not the request: an IncomingMessage emits 'close'
    // as soon as its body has been consumed, which for a POST is immediately -
    // aborting on that would kill every turn before it started. The response
    // only closes when the client actually goes away (or when we end it, by
    // which point aborting is a no-op).
    const abort = (): void => controller.abort();
    reply.raw.on('close', abort);

    context.log.debug('SSE turn started', { sessionId: parsed.data.sessionId });

    try {
      await pipeToSse(
        context.assistant.chat({ ...parsed.data, signal: controller.signal }),
        sse,
      );
    } finally {
      reply.raw.off('close', abort);
    }

    // The response was hijacked; nothing for Fastify left to serialise.
    return reply;
  });
}
