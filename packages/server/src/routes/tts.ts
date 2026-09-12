import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';
import { parseOrThrow, ttsInputSchema } from '../schemas.js';
import { synthesize, ttsCatalogue } from '../services/tts.js';
import { voiceKeys, voiceKeyStatus, saveVoiceKeys, voiceKeysSchema } from '../services/voice-keys.js';

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
  app.get('/api/tts/keys', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return voiceKeyStatus(context.config.home);
  });
  app.patch('/api/tts/keys', async (request, reply) => {
    const patch = parseOrThrow(voiceKeysSchema, request.body);
    reply.header('Cache-Control', 'no-store');
    return saveVoiceKeys(context.config.home, patch);
  });
  app.get('/api/tts/voices', async () => ttsCatalogue(voiceKeys(context.config.home)));

  app.post('/api/tts', async (request: FastifyRequest, reply: FastifyReply) => {
    const { text } = parseOrThrow(ttsInputSchema, request.body ?? {});
    const started = Date.now();
    const { audio, mime } = await synthesize(context.config.voice, text, voiceKeys(context.config.home));
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
