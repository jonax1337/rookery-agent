import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ServerContext } from './context.js';

/**
 * Serve the built web client from the same origin as the API, which is what
 * keeps the default setup free of CORS and of a second port.
 *
 * The build is optional: running the server without `packages/web/dist` is a
 * perfectly good API-only mode, so a missing build is a hint, not an error.
 */
export function webDistPath(): string {
  // dist/static.js -> packages/server/dist -> packages/web/dist
  return fileURLToPath(new URL('../../web/dist', import.meta.url));
}

function isApiPath(url: string | undefined): boolean {
  return Boolean(url && (url.startsWith('/api') || url.startsWith('/ws')));
}

export async function registerStatic(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  const root = webDistPath();
  const hasBuild = existsSync(root) && existsSync(`${root}/index.html`);

  if (hasBuild) {
    await app.register(fastifyStatic, {
      root,
      prefix: '/',
      // Let unmatched paths fall through to the SPA handler below instead of
      // being swallowed by a catch-all route.
      wildcard: false,
      index: ['index.html'],
    });
    context.log.info('Serving web client', { root });
  } else {
    context.log.info(
      'No web build found - running API only. Build it with: npm run build -w @rookery/web',
      { expected: root },
    );
  }

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url;

    if (isApiPath(url) || !hasBuild || request.method !== 'GET') {
      return reply
        .code(404)
        .send({ error: 'Not found', message: `${request.method} ${url}` });
    }

    // A missing asset must 404 rather than fall through to the SPA shell.
    // Serving index.html for /assets/app.js only surfaces later as an opaque
    // "expected a module, got text/html" error in the browser — which is
    // exactly what a stale build looks like after the client is rebuilt while
    // the server is still running.
    if (looksLikeAsset(url)) {
      return reply.code(404).send({
        error: 'Asset not found',
        message:
          `${url} is not in the web build. If the client was rebuilt while the ` +
          `server was running, restart the server so it picks up the new files.`,
      });
    }

    // Client-side routing: any other unknown GET is a deep link into the SPA.
    return reply.sendFile('index.html');
  });
}

/** True for a path that names a file rather than an app route. */
function looksLikeAsset(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split('?')[0] ?? '';
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}
