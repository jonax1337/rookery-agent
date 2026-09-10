import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { parseOrThrow, ttsInputSchema } from '../schemas.js';
import { synthesize, ttsCatalogue } from '../services/tts.js';

/**
 * Speech synthesis for the web UI.
 *
 * The client sends one sentence at a time while the answer is still
 * streaming, so the first words play long before the model has finished.
 * Which engine and voice answer is the server's `voice` config; the browser
 * never sees a key.
 */
export async function registerTtsRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  app.get('/api/tts/voices', async () => ttsCatalogue());

  app.post('/api/tts', async (request: FastifyRequest, reply: FastifyReply) => {
    const { text } = parseOrThrow(ttsInputSchema, request.body ?? {});
    const started = Date.now();
    const { audio, mime } = await synthesize(context.config.voice, text);
    context.log.debug('TTS', {
      engine: context.config.voice.engine,
      chars: text.length,
      bytes: audio.length,
      ms: Date.now() - started,
    });
    reply.header('Cache-Control', 'no-store');
    reply.type(mime);
    return reply.send(audio);
  });
}
