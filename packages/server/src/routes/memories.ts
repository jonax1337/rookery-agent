import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MEMORY_KINDS, recall } from '@rookery/core';
import type { MemoryKind } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { createMemorySchema, patchMemorySchema, parseOrThrow } from '../schemas.js';

/**
 * Body of `POST /api/memories/:id/feedback` - the chat highlight's click
 * target, agreed with the web package as part of this wave's cross-package
 * contract: `{ turnId, verdict }`, `'point'` maps to `relevance = 1`,
 * `'ballast'` to `relevance = 0`. Not in `schemas.ts` - that file belongs to
 * a different package this wave - the same way `routes/profile.ts` and
 * `routes/tools.ts` already build their own request schemas inline.
 */
const memoryFeedbackSchema = z.object({
  turnId: z.string().min(1, 'turnId must not be empty'),
  verdict: z.enum(['point', 'ballast']),
});

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
        hopEntity: context.config.memory.graph.hopEntity,
        hopEdge: context.config.memory.graph.hopEdge,
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

  /**
   * The graph behind the list: entities, the memories hanging off them and
   * the edges between those memories. Everything the brain view draws comes
   * out of this one request.
   */
  app.get(
    '/api/memories/graph',
    async (
      request: FastifyRequest<{
        Querystring: {
          owner?: string;
          entity?: string;
          kind?: string | string[];
          since?: string;
          includeDormant?: string;
          limit?: string;
        };
      }>,
    ) => {
      const kinds = parseKinds(request.query.kind);
      const since = Number(request.query.since);
      return context.assistant.store.memoryGraph({
        owner: request.query.owner || undefined,
        entityId: request.query.entity || undefined,
        kinds: kinds.length ? kinds : undefined,
        since: Number.isFinite(since) && since > 0 ? since : undefined,
        includeDormant: isTruthy(request.query.includeDormant),
        limit: clampLimit(request.query.limit, context.config.memory.graph.maxNodes, 1000),
      });
    },
  );

  /** Entities for the graph's filter bar and for autocomplete. */
  app.get(
    '/api/entities',
    async (
      request: FastifyRequest<{ Querystring: { owner?: string; limit?: string; minMentions?: string } }>,
    ) => {
      const minMentions = Number(request.query.minMentions);
      return context.assistant.store.listEntities({
        owner: request.query.owner || undefined,
        limit: clampLimit(request.query.limit, 200, 1000),
        minMentions: Number.isFinite(minMentions) ? minMentions : 1,
      });
    },
  );

  /** One memory with its entities and both directions of its edges. */
  app.get(
    '/api/memories/:id/edges',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const neighbourhood = context.assistant.store.neighbourhood(request.params.id);
      if (!neighbourhood) {
        reply.code(404);
        return { error: 'No memory ' + request.params.id + '.' };
      }
      return neighbourhood;
    },
  );

  app.post('/api/memories', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = parseOrThrow(createMemorySchema, request.body ?? {});
    // Added by hand means added by the user: protected from the night.
    const record = context.assistant.rememberFact({
      kind: input.kind ?? 'fact',
      content: input.content,
      tags: input.tags,
      importance: input.importance,
    });
    reply.code(201);
    return record;
  });

  /** Pin, re-word, re-weight, or wake a sleeping memory. */
  app.patch(
    '/api/memories/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const input = parseOrThrow(patchMemorySchema, request.body ?? {});
      const store = context.assistant.store;
      if (!store.getMemory(request.params.id)) {
        reply.code(404);
        return { error: 'No memory ' + request.params.id + '.' };
      }
      if (input.dormant === false) store.wakeMemory(request.params.id);
      // The HTTP path is the only door a `user` label can enter through
      // (concept 4.2b, S5) - the model's own memory tool reaches
      // `updateMemory` too, but never with this actor.
      return store.updateMemory(
        request.params.id,
        {
          content: input.content,
          kind: input.kind,
          tags: input.tags,
          importance: input.importance,
          pinned: input.pinned,
          forgotten: input.forgotten,
          ...(input.dormant === true ? { dormantAt: Date.now() } : {}),
        },
        'user',
      );
    },
  );

  app.delete(
    '/api/memories/:id',
    async (request: FastifyRequest<{ Params: { id: string }; Querystring: { hard?: string } }>) => {
      const { id } = request.params;
      if (isTruthy(request.query.hard)) {
        context.assistant.store.deleteMemory(id, 'user');
      } else {
        context.assistant.store.forgetMemory(id, 'user');
      }
      return { ok: true };
    },
  );

  /**
   * The chat highlight's "was the point / was ballast" (concept 4.2b, S6):
   * the one `user` label with a real turn reference, because the highlight
   * already knows which memory a given turn surfaced. AP15 is the only
   * caller today, off the `'memory'` event's `turnId`.
   */
  app.post(
    '/api/memories/:id/feedback',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const input = parseOrThrow(memoryFeedbackSchema, request.body ?? {});
      const store = context.assistant.store;
      const memory = store.getMemory(request.params.id);
      if (!memory) {
        reply.code(404);
        return { error: 'No memory ' + request.params.id + '.' };
      }
      // `userLabel` (dream/label.ts) is built for this claim, but it asks
      // for a `sessionId` this route has no honest way to produce: nothing
      // here maps an arbitrary turn id back to the session it fell in
      // (`store.ts` exposes no such lookup), and guessing one would be
      // exactly the anachronism S3 forbids elsewhere. `scope` only ever
      // reads `turnId` when one is given, so the label is written directly,
      // with the memory's own source session carried along purely as the
      // denormalised metadata `DreamLabel.sessionId` already documents
      // itself as (S9's deletion paths) - never as part of the claim.
      store.putLabel({
        turnId: input.turnId,
        target: memory.id,
        source: 'user',
        relevance: input.verdict === 'point' ? 1 : 0,
        scope: 'turn',
        owner: memory.owner,
        evidence: 'memories:feedback',
        createdAt: Date.now(),
        ...(memory.sourceSessionId ? { sessionId: memory.sourceSessionId } : {}),
      });
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
