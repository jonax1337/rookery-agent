import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MEMORY_KINDS, recall } from '@rookery/core';
import type { MemoryKind } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { createMemorySchema, parseOrThrow } from '../schemas.js';

type MemoryQuery = {
  Querystring: { q?: string; kind?: string | string[]; limit?: string; includeForgotten?: string; owner?: string };
};

/**
 * The memory inspector's backend.
 *
 * Listing and searching are different operations on purpose: a plain list is
 * "what do you know", ordered by importance, while `?q=` runs the same blended
 * recall the assistant itself uses, so the UI can show why something surfaced.
 */
export async function registerMemoryRoutes(
  app: FastifyInstance,
  context: ServerContext,
): Promise<void> {
  // Registered before /api/memories/:id so the literal path wins the match.
  app.get(
    '/api/memories/stats',
    async (request: FastifyRequest<{ Querystring: { owner?: string } }>) =>
      context.assistant.store.memoryStats(request.query.owner || undefined),
  );

  app.get('/api/memories', async (request: FastifyRequest<MemoryQuery>) => {
    const { q, limit: rawLimit, includeForgotten, owner } = request.query;
    const kinds = parseKinds(request.query.kind);
    const limit = clampLimit(rawLimit, 100, 500);

    const query = q?.trim();
    if (query) {
      // Read-only inspection must not inflate the recall statistics.
      return recall(context.assistant.store, {
        text: query,
        limit,
        kinds: kinds.length ? kinds : undefined,
        owner: owner || undefined,
        touch: false,
      });
    }

    return context.assistant.store.listMemories({
      kinds: kinds.length ? kinds : undefined,
      limit,
      includeForgotten: isTruthy(includeForgotten),
      owner: owner || undefined,
    });
  });

  app.post('/api/memories', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(createMemorySchema, request.body ?? {});
    const record = context.assistant.store.upsertMemory({
      kind: input.kind ?? 'fact',
      content: input.content,
      tags: input.tags,
      importance: input.importance,
    });
    reply.code(201);
    return record;
  });

  app.delete(
    '/api/memories/:id',
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { hard?: string } }>) => {
      const { id } = request.params;
      if (isTruthy(request.query.hard)) {
        context.assistant.store.deleteMemory(id);
      } else {
        context.assistant.store.forgetMemory(id);
      }
      return { ok: true };
    },
  );
}

/** Accept `?kind=fact&kind=event` and `?kind=fact,event`, ignore nonsense. */
function parseKinds(raw: string | string[] | undefined): MemoryKind[] {
  if (!raw) return [];
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(','));
  const known = new Set<string>(MEMORY_KINDS);
  return parts
    .map((part) => part.trim())
    .filter((part) => known.has(part)) as MemoryKind[];
}

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}
