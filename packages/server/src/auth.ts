import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
  onRequestAsyncHookHandler,
  preHandlerAsyncHookHandler,
  preHandlerHookHandler,
} from 'fastify';
import type { ServerContext } from './context.js';

/**
 * Protect local profile data and host execution even when no bearer token is configured.
 *
 * An Origin counts as the server's own when it names the same host and port
 * as the request - the scheme is ignored on purpose. Behind a TLS-terminating
 * proxy the browser sends `https://` while this plain-HTTP server sees
 * `http://`, and the scheme is not what separates an attacker's page from the
 * UI: the attacker's page is on another host.
 */
export async function requireSameOrigin(request: FastifyRequest): Promise<void> {
  const origin = request.headers.origin;
  if (!origin && request.headers['sec-fetch-site'] !== 'cross-site') return;
  if (origin && sameHost(origin, request.headers.host)) return;
  throw Object.assign(new Error('This operation requires the same origin as the Rookery server.'), { statusCode: 403 });
}

/**
 * Whether `origin` names the host in the `Host` header. Both go through the
 * same URL parse, so a default port written out on one side and left off on
 * the other (`localhost:80` against `http://localhost`) still agrees.
 */
function sameHost(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const given = new URL(origin);
    return given.host === new URL(given.protocol + '//' + hostHeader).host;
  } catch {
    return false;
  }
}

/**
 * `requireSameOrigin` as a global preHandler: every route that can change
 * state is default-deny for browser origins other than the server's own.
 * GET/HEAD/OPTIONS cannot change state, and requests without an Origin
 * header (CLI, gateways, curl, health probes) pass untouched anyway. Reading
 * across origins is closed by not sending any CORS headers at all.
 */
export function createSameOriginHook(): preHandlerAsyncHookHandler {
  return async function sameOriginHook(request: FastifyRequest): Promise<void> {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    await requireSameOrigin(request);
  };
}

/** The hostname out of a `Host` header: port stripped, IPv6 brackets removed. */
function hostnameOf(hostHeader: string): string {
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  return value.split(':')[0] ?? value;
}

/**
 * Which names this server answers to without a token. An IP literal is safe -
 * a page cannot be served from one by a domain it controls - and so is
 * `localhost`. Anything else is a domain somebody else may have pointed at
 * this machine, which is DNS rebinding: the browser then treats the attacker's
 * page and this API as the same origin, and every Origin check passes.
 */
function isKnownHostname(name: string, context: ServerContext): boolean {
  if (isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost')) return true;
  const { host, allowedHosts } = context.config;
  return name === host.toLowerCase() || allowedHosts.some((allowed) => allowed.toLowerCase() === name);
}

/**
 * Reject requests addressed to a name that is not this machine's own, for
 * every route and the websocket upgrade alike. Off as soon as a token is set:
 * a rebinding page does not have it, and a token is what makes reaching the
 * server by an arbitrary name (a tunnel, a LAN hostname) safe.
 */
export function createHostGuard(context: ServerContext): onRequestAsyncHookHandler {
  return async function hostGuard(request: FastifyRequest): Promise<void> {
    if (context.config.token) return;
    const host = request.headers.host;
    if (!host || isKnownHostname(hostnameOf(host), context)) return;
    throw Object.assign(
      new Error(
        'This host name is not allowed. Add it to "allowedHosts" in config.json (or ROOKERY_ALLOWED_HOSTS).',
      ),
      { statusCode: 403 },
    );
  };
}

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

/**
 * Auth is one shared bearer token, not user accounts.
 *
 * Rookery binds to loopback by default, where a token buys nothing, so an
 * empty `config.token` means "allow everything". The moment a token is set -
 * which is what you do before exposing the port to the LAN or a tunnel - it is
 * required on every /api call and on the websocket upgrade.
 */
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
