import type { FastifyReply, FastifyRequest } from 'fastify';
import { ASSISTANT_MEMORY_OWNER } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { isTruthy } from './query.js';

type NightRunRequest = FastifyRequest<{
  Querystring: { owner?: string; wait?: string };
  Body?: { owner?: string };
}>;

/**
 * Start a night by hand. The memory page and the dream section trigger the
 * same run - the dream stage is a section of the night, not a run of its own -
 * so both routes share this handler and differ only in what a failure is
 * logged as.
 *
 * Without `?wait=1` the run is fire and forget: the client watches the `sleep`
 * frames on the socket. A bank that is already sleeping answers 409.
 */
export function createNightRunHandler(context: ServerContext, failureMessage: string) {
  return async (request: NightRunRequest, reply: FastifyReply) => {
    const owner = request.body?.owner || request.query.owner || ASSISTANT_MEMORY_OWNER;
    if (context.assistant.sleep.isRunning(owner)) {
      reply.code(409);
      return { error: 'This memory bank is already sleeping.' };
    }
    if (isTruthy(request.query.wait)) return context.assistant.sleepNow(owner);

    void context.assistant.sleepNow(owner).catch((error: Error) => {
      context.log.warn(failureMessage, { owner, error: error.message });
    });
    reply.code(202);
    return { started: true, owner };
  };
}
