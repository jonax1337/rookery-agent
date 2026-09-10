import { timingSafeEqual } from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
  preHandlerHookHandler,
} from 'fastify';
import type { ServerContext } from './context.js';

/**
 * Auth is one shared bearer token, not user accounts.
 *
 * Rookery binds to loopback by default, where a token buys nothing, so an
 * empty `config.token` means "allow everything". The moment a token is set -
 * which is what you do before exposing the port to the LAN or a tunnel - it is
 * required on every /api call and on the websocket upgrade.
 */

/** Constant-time compare that also tolerates different lengths. */
function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull `Bearer <token>` out of the Authorization header. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** `?token=` on the query string, the only way to authenticate a WS upgrade. */
export function queryToken(request: FastifyRequest): string | null {
  const query = request.query as Record<string, unknown> | undefined;
  const value = query?.token;
  return typeof value === 'string' && value.length ? value : null;
}

export function isAuthorized(context: ServerContext, request: FastifyRequest): boolean {
  const expected = context.config.token;
  if (!expected) return true;
  const given = bearerToken(request) ?? queryToken(request);
  return given !== null && tokensMatch(expected, given);
}

/** preHandler for /api/*: 401 unless the bearer token matches. */
export function createAuthHook(context: ServerContext): preHandlerHookHandler {
  return function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction,
  ): void {
    if (isAuthorized(context, request)) {
      done();
      return;
    }
    reply
      .code(401)
      .header('WWW-Authenticate', 'Bearer realm="rookery"')
      .send({ error: 'Unauthorized', message: 'A valid bearer token is required.' });
  };
}
