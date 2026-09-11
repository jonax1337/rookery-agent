import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerContext } from '../context.js';

/**
 * The one aggregate call in the API.
 *
 * Everything else here is a list with a cap, which makes any total derived
 * from one of them quietly wrong the moment the cap bites. This route counts
 * in the database and groups by day there, so the dashboard can show numbers
 * instead of estimates.
 *
 * The window is `?since=<ISO or epoch ms>` when given, otherwise `?days=<n>`
 * whole local days back from today (90 by default). Gaps in the series are
 * left in: the response states the window it actually used, and the client
 * fills the missing days for the shape it means to draw.
 */
export async function registerStatsRoutes(app: FastifyInstance, context: ServerContext): Promise<void> {
  app.get(
    '/api/stats',
    async (request: FastifyRequest<{ Querystring: { since?: string; days?: string; owner?: string } }>) => {
      const until = Date.now();
      const since = parseSince(request.query.since) ?? startOfDaysAgo(until, clampDays(request.query.days, 90, 366));
      return context.assistant.store.stats({
        orgId: context.assistant.org.activeOrganization().id,
        since,
        until,
        owner: request.query.owner || undefined,
      });
    },
  );
}

/**
 * An ISO timestamp or plain epoch milliseconds. Nonsense falls through to the
 * `days` window rather than erroring, in keeping with the other query
 * parameters here - and the response echoes `since`, so a typo is visible
 * instead of silently shifting the chart.
 */
function parseSince(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const numeric = Number(raw);
  const ms = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function clampDays(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/**
 * Midnight of the day `days - 1` days ago, so `?days=90` covers ninety whole
 * calendar days including today rather than ninety times twenty-four hours
 * ending mid-afternoon. `setDate` across a month or DST boundary is the
 * calendar's arithmetic, which is the one a chart axis uses.
 */
function startOfDaysAgo(now: number, days: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}
