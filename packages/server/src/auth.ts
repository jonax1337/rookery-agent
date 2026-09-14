import { timingSafeEqual } from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from 'fastify';
import type { ServerContext } from './context.js';

/** Protect local profile data and host execution even when no bearer token is configured. */
export async function requireSameOrigin(request: FastifyRequest): Promise<void> {
  const origin = request.headers.origin;
  if (!origin && request.headers['sec-fetch-site'] !== 'cross-site') return;
  if (origin === `${request.protocol}://${request.headers.host}`) return;
  throw Object.assign(new Error('This operation requires the same origin as the Rookery server.'), { statusCode: 403 });
}

/**
 * `requireSameOrigin` as a global preHandler: every route that can change
 * state is default-deny for browser origins other than the server's own.
 * GET/HEAD/OPTIONS cannot change state, and requests without an Origin
 * header (CLI, gateways, curl, health probes) pass untouched anyway.
 *
 * The comparison uses the request's own protocol and host, which is honest
 * for loopback and plain-HTTP LAN exposure. A TLS-terminating proxy in front
 * of this plain-HTTP server sends an `https://` Origin that no longer
 * matches, so every browser write (and the WS upgrade) 403s — until a
 * forwarded-proto opt-in exists, expose over plain HTTP only.
 */
export function createSameOriginHook(): preHandlerAsyncHookHandler {
  return async function sameOriginHook(request: FastifyRequest): Promise<void> {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    await requireSameOrigin(request);
  };
}

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
