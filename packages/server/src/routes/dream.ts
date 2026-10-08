import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ASSISTANT_MEMORY_OWNER, revertPolicy } from '@rookery/core';
import type { DreamSlot } from '@rookery/core';
import type { ServerContext } from '../context.js';
import { createNightRunHandler } from './night.js';
import { clampPositiveInt, isTruthy } from './query.js';

/**
 * The dream's own surface, over HTTP (concept 9.6, AP13).
 *
 * A `policy_versions` row is discriminated by `replayScore`, not by
 * `origin`: `promotedAt` set and `retiredAt` unset is in force; `replayScore`
 * set and not promoted is measured and passed over; `replayScore` unset and
 * not retired is a proposal the candidate writer wrote and nobody has
 * measured yet. Every route here returns the row as `store.ts` maps it -
 * numbers and this vocabulary, never a word of the frames behind it (E19).
 *
 * Registered in server.ts BEFORE `registerStatic`, or the SPA fallback would
 * answer every one of these with `index.html` instead of JSON - the same
 * trap `routes/memories.ts` already avoids. Literal paths are declared
 * before their parameterised siblings for the same reason `routes/memories.ts`
 * puts `/api/memories/stats` ahead of `/api/memories/:id`. Query strings are
 * not schema-validated anywhere in this server, so they are clamped by hand
 * here too.
 */
export async function registerDreamRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  /** What is in force right now, per slot, plus whether the slot is frozen. */
  app.get(
    '/api/dream/policies',
    async (request: FastifyRequest<{ Querystring: { owner?: string } }>) => {
      const owner = request.query.owner || ASSISTANT_MEMORY_OWNER;
      const store = context.assistant.store;
      return DREAM_SLOTS.map((slot) => ({
        slot,
        active: store.activePolicy(owner, slot),
        state: store.slotState(owner, slot),
      }));
    },
  );

  /** One slot's versions, newest first - what the version curve draws. */
  app.get(
    '/api/dream/policies/:slot/history',
    async (
      request: FastifyRequest<{ Params: { slot: string }; Querystring: { owner?: string; limit?: string } }>,
      reply: FastifyReply,
    ) => {
      const { slot } = request.params;
      if (!isDreamSlot(slot)) {
        reply.code(400);
        return { error: 'Unknown dream slot ' + slot + '.' };
      }
      const owner = request.query.owner || ASSISTANT_MEMORY_OWNER;
      return context.assistant.store.policyHistory(owner, slot, clampPositiveInt(request.query.limit, 50, 200));
    },
  );

  /**
   * Put an already-measured candidate in force by hand - the diff sheet's
   * promote button. Eligible only while it carries a holdout number and has
   * never itself been promoted or retired: a version already in force has
   * nothing to promote to, and a retired one goes back through `revert`,
   * over `prevActiveId`, not through this door (10.4).
   */
  app.post(
    '/api/dream/policies/:id/promote',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const store = context.assistant.store;
      const version = store.policyVersion(request.params.id);
      if (!version) {
        reply.code(404);
        return { error: 'No policy version ' + request.params.id + '.' };
      }
      if (version.promotedAt && !version.retiredAt) {
        reply.code(409);
        return { error: 'This policy is already in force.' };
      }
      if (version.retiredAt) {
        reply.code(409);
        return { error: 'A retired policy cannot be promoted directly; revert to it instead.' };
      }
      if (version.replayScore === undefined) {
        reply.code(409);
        return { error: 'This policy has not been measured on the holdout yet.' };
      }
      const active = store.activePolicy(version.owner, version.slot);
      const promoted = store.promotePolicyVersion(version.id, { prevActiveId: active?.id });
      return { ok: true, version: promoted, prevActiveId: active?.id ?? null };
    },
  );

  /**
   * Take one promotion back by hand: the later, manual path over
   * `prevActiveId` (10.4). The night's own undo is `undoSleepRun`, once per
   * run and only while that run is the newest thing that happened; this is
   * the other path, for any night, reverted by a person.
   */
  app.post(
    '/api/dream/policies/:id/revert',
    async (
      request: FastifyRequest<{ Params: { id: string }; Querystring: { owner?: string } }>,
      reply: FastifyReply,
    ) => {
      const result = revertPolicy(context.assistant.store, request.params.id, {
        owner: request.query.owner || undefined,
      });
      if (!result.ok) {
        const notFound = result.findings.includes('policy-not-found') || result.findings.includes('foreign-owner');
        reply.code(notFound ? 404 : 409);
        return { error: result.findings.join(', ') };
      }
      return result;
    },
  );

  /** Evaluations, newest first - the receipt behind a version's numbers. */
  app.get(
    '/api/dream/evals',
    async (
      request: FastifyRequest<{
        Querystring: {
          owner?: string;
          slot?: string;
          sleepRunId?: string;
          policyId?: string;
          promoted?: string;
          limit?: string;
        };
      }>,
    ) => {
      const { owner, slot, sleepRunId, policyId, promoted } = request.query;
      return context.assistant.store.listDreamEvals({
        owner: owner || undefined,
        slot: slot && isDreamSlot(slot) ? slot : undefined,
        sleepRunId: sleepRunId || undefined,
        policyId: policyId || undefined,
        promoted: promoted === undefined ? undefined : isTruthy(promoted),
        limit: clampPositiveInt(request.query.limit, 100, 500),
      });
    },
  );

  /**
   * The episode index behind an evaluation (concept, AP1 `dream_episodes`):
   * outcome, step count and split, never the wordlaut `dream_frames` holds -
   * this is the one dream table safe to hand straight to a browser.
   */
  app.get(
    '/api/dream/traces',
    async (
      request: FastifyRequest<{
        Querystring: { owner?: string; slot?: string; holdout?: string; audit?: string; limit?: string };
      }>,
    ) => {
      const owner = request.query.owner || ASSISTANT_MEMORY_OWNER;
      const { slot } = request.query;
      const limit = clampPositiveInt(request.query.limit, DEFAULT_TRACE_LIMIT, MAX_TRACE_LIMIT);
      // The store has no slot filter, so asking it for `limit` rows first and
      // filtering afterwards would hand back fewer than exist: read the whole
      // window, narrow it, then cut.
      const episodes = context.assistant.store.dreamEpisodes(owner, {
        holdout: request.query.holdout === undefined ? undefined : isTruthy(request.query.holdout),
        audit: request.query.audit === undefined ? undefined : isTruthy(request.query.audit),
        limit: slot ? MAX_TRACE_LIMIT : limit,
      });
      return slot ? episodes.filter((episode) => episode.slot === slot).slice(0, limit) : episodes;
    },
  );

  /**
   * Start a night by hand from the dream section. Same start/wait/409 shape
   * as `POST /api/sleep/run` (`routes/sleep.ts`).
   */
  app.post('/api/dream/run', createNightRunHandler(context, 'Dream run failed'));
}

const DEFAULT_TRACE_LIMIT = 100;
const MAX_TRACE_LIMIT = 500;

/** The three recall-family slots stage 2 carries a policy for (concept 7.1). */
const DREAM_SLOTS: DreamSlot[] = ['recall', 'budget', 'retry'];

function isDreamSlot(value: string): value is DreamSlot {
  return (DREAM_SLOTS as string[]).includes(value);
}
