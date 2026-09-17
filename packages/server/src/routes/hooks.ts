import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';

type TokenParams = { Params: { token: string } };

/**
 * Constant-time compare, a local twin of the one in auth.ts because that one
 * is private to bearer auth. Be honest about what it buys: the job was already
 * found by an exact-match index lookup, so this second comparison is defence
 * in depth, not the thing that stops an attacker. What stops an attacker is
 * that the secret is a 122-bit random UUID nobody guesses.
 */
function secretsMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Webhooks: one URL per schedule, for anything outside Rookery that wants to
 * say "now".
 *
 * This lives outside `/api` on purpose. The global bearer-token preHandler in
 * server.ts only fires for URLs starting with `/api`, so a webhook under that
 * prefix would demand the server's shared token in addition to the per-job
 * secret - which defeats the point of a per-job secret. The whole idea is that
 * handing someone one job's URL hands them that one job and nothing else.
 *
 * The global same-origin hook still applies, and that is wanted: it stops a
 * malicious web page from firing jobs out of the user's browser, while curl
 * and other servers - which send no Origin header - pass untouched.
 */
export async function registerHookRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  const cron = context.assistant.cron;

  // POST only. The same-origin hook exempts GET/HEAD/OPTIONS, so a webhook on
  // GET could be fired by any page on the internet with an `<img src>`; and
  // unmatched GETs belong to the static SPA fallback anyway.
  app.post('/hooks/:token', async (request: FastifyRequest<TokenParams>, reply: FastifyReply) => {
    const token = request.params.token;
    const job = token ? cron.findByWebhookToken(token) : null;
    // One answer for every miss - a wrong secret, a job without a webhook, a
    // job that no longer exists. Nothing here says which.
    if (!job || !job.webhookToken || !secretsMatch(job.webhookToken, token)) {
      reply.code(404);
      return { error: 'Not found', message: 'No such hook.' };
    }

    const outcome = await cron.runEvent(job.id, 'webhook');
    if (outcome.status === 'ignored') {
      // A real answer, not a leak: the caller already proved it holds the
      // secret, so telling it the schedule is off costs nothing and saves it
      // from retrying forever.
      context.log.info('Webhook ignored', { job: job.name, reason: outcome.reason });
      reply.code(409);
      return { error: 'Conflict', message: outcome.reason };
    }

    // Started, queued behind the cooldown, or folded into the run already
    // under way - all three mean accepted, something will run.
    context.log.info('Webhook accepted', { job: job.name, outcome: outcome.status });
    reply.code(202);
    if (outcome.status === 'queued') return { ok: true, status: 'queued', waitMs: outcome.waitMs };
    return { ok: true, status: outcome.status };
  });
}
