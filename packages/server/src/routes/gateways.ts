import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pushRecipients } from '@rookery/core';
import type { ServerContext } from '../context.js';

type IdParams = { Params: { id: string } };

/**
 * Chat gateways, over HTTP. The settings themselves stay on `PATCH
 * /api/config` like every other section - this is only status and a way to
 * prove a channel actually reaches a phone, without a token ever appearing
 * in the answer.
 */
export async function registerGatewayRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  app.get('/api/gateways', async () => {
    return { gateways: context.gateways.map((gateway) => gateway.status()) };
  });

  /** Send a German test line to the first configured recipient. */
  app.post('/api/gateways/:id/test', async (request: FastifyRequest<IdParams>, reply: FastifyReply) => {
    const gateway = context.gateways.find((entry) => entry.id === request.params.id);
    if (!gateway) {
      reply.code(400);
      return { error: 'Bad Request', message: 'Diesen Kanal gibt es nicht: ' + request.params.id };
    }
    if (!gateway.status().running) {
      reply.code(400);
      return { error: 'Bad Request', message: 'Der Kanal läuft gerade nicht.' };
    }
    const [recipient] = pushRecipients(context.config.gateways.telegram);
    if (recipient === undefined) {
      reply.code(400);
      return { error: 'Bad Request', message: 'Niemand ist als Empfänger eingetragen.' };
    }
    await gateway.send(recipient, 'Testnachricht von Rookery - wenn du das liest, funktioniert der Kanal.');
    return { ok: true, recipient };
  });
}
