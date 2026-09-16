import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, ProviderProfile, ProviderQuota, QuotaWindow } from '../types.js';

/**
 * Subscription usage, read the way the CLIs' own `/usage` panels read it:
 * with the OAuth login each CLI keeps on disk, from the vendor's own usage
 * endpoint. A configured provider profile is read the same way, except that
 * the credential is the API key the profile already runs its turns with -
 * z.ai reports a GLM Coding Plan's two windows much as Anthropic reports
 * Claude's. None of these endpoints is a public contract, so parsing is
 * defensive and anything unrecognised is dropped rather than shown raw.
 *
 * They all rate-limit eager pollers hard. One answer is cached for a minute,
 * a 429 backs off for five, and a failure for two, so a UI that asks on every
 * hover never turns into a hammer.
 */

const CACHE_MS = 60 * 1000;
const COOLDOWN_429_MS = 5 * 60 * 1000;
const COOLDOWN_ERROR_MS = 2 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const cache = new Map<ProviderId, { quota: ProviderQuota; until: number }>();

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

function unavailable(provider: ProviderId, error: string): ProviderQuota {
  return { provider, windows: [], fetchedAt: Date.now(), error };
}

/* --------------------------------- Claude --------------------------------- */

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** Only windows a person can act on; the endpoint also carries codename buckets. */
const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: '5 hours',
  seven_day: 'Week',
  seven_day_opus: 'Week · Opus',
  seven_day_sonnet: 'Week · Sonnet',
};

/** "default_claude_max_5x" -> "Max 5×". */
function claudePlanLabel(tier: unknown): string | undefined {
  if (typeof tier !== 'string' || !tier) return undefined;
  const label = tier
    .replace(/^default_claude_/, '')
    .replace(/_(\d+)x$/, ' $1×')
    .replace(/^\w/, (c) => c.toUpperCase());
  return label || undefined;
}

/**
 * Shared by the usage endpoint (utilization 0..100, `resets_at` ISO) and the
 * CLI's `rate_limit_event` (utilization 0..1, `resetsAt` unix seconds).
 * `fraction` says which of the two scales the caller is holding.
 */
export function parseClaudeWindows(payload: unknown, fraction = false): QuotaWindow[] {
  const record = asRecord(payload);
  if (!record) return [];
  const windows: QuotaWindow[] = [];
  for (const [kind, label] of Object.entries(CLAUDE_WINDOWS)) {
    const entry = asRecord(record[kind]);
    if (!entry) continue;
    const utilization = entry.utilization;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue;
    const percent = fraction ? utilization * 100 : utilization;
    const resetsAt = normaliseReset(entry.resets_at ?? entry.resetsAt);
    windows.push({ kind, label, percent: clampPercent(percent), ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

async function fetchClaude(): Promise<ProviderQuota> {
  const credentials = readJson(join(homedir(), '.claude', '.credentials.json'));
  const oauth = asRecord(credentials?.claudeAiOauth);
  const token = oauth?.accessToken;
  if (typeof token !== 'string' || !token) {
    return unavailable('claude', 'Claude Code is not signed in.');
  }
  const response = await fetch(CLAUDE_USAGE_URL, {
    headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status);
  const windows = parseClaudeWindows(await response.json());
  const plan = claudePlanLabel(oauth?.rateLimitTier);
  return { provider: 'claude', ...(plan ? { plan } : {}), windows, fetchedAt: Date.now() };
}

/* ---------------------------------- Codex --------------------------------- */

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const CODEX_PLANS: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  prolite: 'Pro Lite',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

function codexPlanLabel(plan: unknown): string | undefined {
  if (typeof plan !== 'string' || !plan.trim()) return undefined;
  return CODEX_PLANS[plan.toLowerCase()] ?? plan.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Codex calls its windows primary and secondary; only the length says what
 * they are. Label by duration so a plan with a lone weekly window is never
 * shown as a session.
 */
function codexWindow(raw: unknown, fallbackKind: 'session' | 'weekly'): QuotaWindow | null {
  const window = asRecord(raw);
  if (!window || typeof window.used_percent !== 'number') return null;
  const seconds = typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : 0;
  const span = describeSpan(seconds > 0 ? seconds / 3600 : 0);
  const kind = span ? span.kind : fallbackKind;
  const label = span ? span.label : fallbackKind === 'session' ? 'Session' : 'Week';
  const resetsAt = normaliseReset(window.reset_at);
  return { kind, label, percent: clampPercent(window.used_percent), ...(resetsAt ? { resetsAt } : {}) };
}

export function parseCodexWindows(payload: unknown): QuotaWindow[] {
  const record = asRecord(payload);
  const limit = asRecord(record?.rate_limit);
  if (!limit) return [];
  const windows: QuotaWindow[] = [];
  const primary = codexWindow(limit.primary_window, 'session');
  const secondary = codexWindow(limit.secondary_window, 'weekly');
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows;
}

async function fetchCodex(): Promise<ProviderQuota> {
  const auth = readJson(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'));
  const tokens = asRecord(auth?.tokens);
  const token = tokens?.access_token;
  if (typeof token !== 'string' || !token) {
    return unavailable('codex', 'Codex is not signed in.');
  }
  const accountId = tokens?.account_id;
  const response = await fetch(CODEX_USAGE_URL, {
    headers: {
      Authorization: 'Bearer ' + token,
      'User-Agent': 'codex-cli',
      ...(typeof accountId === 'string' ? { 'ChatGPT-Account-Id': accountId } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status);
  const payload = (await response.json()) as Record<string, unknown>;
  const plan = codexPlanLabel(payload.plan_type);
  return { provider: 'codex', ...(plan ? { plan } : {}), windows: parseCodexWindows(payload), fetchedAt: Date.now() };
}

/* ---------------------------------- z.ai ---------------------------------- */

const GLM_USAGE_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

/**
 * z.ai states a window as a count of units: `{unit: 3, number: 5}` is the
 * Coding Plan's five hours, `{unit: 6, number: 1}` its week. Only the units a
 * plan actually uses are mapped, and an unrecognised one drops its window
 * rather than labelling it with a guess.
 */
const GLM_UNIT_HOURS: Record<string, number> = { '3': 1, '4': 24, '6': 24 * 7 };

/** `data.level`: which Coding Plan the key is subscribed to. */
const GLM_LEVELS: Record<string, string> = { lite: 'Lite', pro: 'Pro', max: 'Max' };

function glmPlanLabel(level: unknown): string | undefined {
  if (typeof level !== 'string' || !level.trim()) return undefined;
  const tier = GLM_LEVELS[level.toLowerCase()] ?? level.replace(/^\w/, (c) => c.toUpperCase());
  return 'Coding Plan ' + tier;
}

/**
 * How much of a window is gone, 0..100. `percentage` is the endpoint's own
 * figure; behind it sit `currentValue` spent out of the `usage` allowance -
 * a pair whose names read backwards, so it is only the fallback for payloads
 * that omit the percentage.
 */
function glmPercent(entry: Record<string, unknown>): number | null {
  if (typeof entry.percentage === 'number' && Number.isFinite(entry.percentage)) {
    return clampPercent(entry.percentage);
  }
  const spent = entry.currentValue;
  const allowance = entry.usage;
  if (typeof spent === 'number' && typeof allowance === 'number' && allowance > 0) {
    return clampPercent((spent / allowance) * 100);
  }
  return null;
}

/**
 * `nextResetTime` counts unix milliseconds where the other two endpoints
 * count seconds - dividing it down would lose the millisecond, so it is read
 * as what it is.
 */
function glmReset(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return normaliseReset(value);
}

/**
 * The plan's rolling windows out of `data.limits`.
 *
 * Entries are taken whatever their `type` says: the same window has been
 * reported as `TIME_LIMIT`, `TOKENS_LIMIT` and `CREDIT_LIMIT` as z.ai changed
 * what it meters, and readers that matched on the type went to zero each time
 * it moved. What identifies a window is its length, so that is what is matched
 * on, and a length seen twice is the same limit counted a second way.
 */
export function parseGlmWindows(payload: unknown): QuotaWindow[] {
  const limits = asRecord(asRecord(payload)?.data)?.limits;
  if (!Array.isArray(limits)) return [];
  const windows: QuotaWindow[] = [];
  for (const raw of limits) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const percent = glmPercent(entry);
    if (percent === null) continue;
    const units = typeof entry.number === 'number' ? entry.number : 1;
    const span = describeSpan((GLM_UNIT_HOURS[String(entry.unit)] ?? 0) * units);
    if (!span || windows.some((window) => window.kind === span.kind)) continue;
    const resetsAt = glmReset(entry.nextResetTime);
    windows.push({ ...span, percent, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows;
}

async function fetchGlm(provider: ProviderId, token: string): Promise<ProviderQuota> {
  const response = await fetch(GLM_USAGE_URL, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status);
  const payload = (await response.json()) as Record<string, unknown>;
  // z.ai answers 200 and carries its verdict in the body, so a key that works
  // for turns but is on no Coding Plan arrives here rather than as an error.
  if (payload.success === false) {
    const message = typeof payload.msg === 'string' && payload.msg ? payload.msg : '';
    return unavailable(provider, message || 'z.ai reports no Coding Plan for this key.');
  }
  const plan = glmPlanLabel(asRecord(payload.data)?.level);
  return { provider, ...(plan ? { plan } : {}), windows: parseGlmWindows(payload), fetchedAt: Date.now() };
}

/* -------------------------------- profiles -------------------------------- */

/**
 * The backends that answer for their own usage, keyed by API host.
 *
 * By host rather than by profile id, because what has a usage endpoint is the
 * backend, not the name a profile was given: a key pointed at z.ai reports its
 * Coding Plan whether the profile is called `glm` or something else.
 */
const PROFILE_USAGE: Record<string, (provider: ProviderId, token: string) => Promise<ProviderQuota>> = {
  'api.z.ai': fetchGlm,
};

/** The configured provider profiles, kept in step by the provider registry. */
const profiles = new Map<ProviderId, ProviderProfile>();

/**
 * Tell the quota reader which profiles exist. Usage is read with the key the
 * profile already runs its turns with, so there is no second credential to
 * store - only the same list the registry builds its adapters from.
 */
export function rememberProviderProfiles(list: ProviderProfile[]): void {
  profiles.clear();
  for (const profile of list) profiles.set(profile.id, profile);
}

function usageHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '';
  }
}

async function fetchProfile(provider: ProviderId): Promise<ProviderQuota> {
  const profile = profiles.get(provider);
  const fetcher = profile && PROFILE_USAGE[usageHost(profile.baseUrl)];
  if (!profile || !fetcher) return unavailable(provider, 'This provider does not report usage.');
  if (!profile.authToken) return unavailable(provider, 'No API key set for this provider yet.');
  return fetcher(provider, profile.authToken);
}

/* --------------------------------- shared --------------------------------- */

class HttpError extends Error {
  constructor(readonly status: number) {
    super('HTTP ' + status);
  }
}

/**
 * A window's length, as the key and the label a UI shows for it: "5 hours",
 * "30 minutes", "Week", "30 days". Null when the length is unknown, so a
 * caller can fall back to whatever its own payload implies instead.
 */
function describeSpan(hours: number): { kind: string; label: string } | null {
  if (!(hours > 0)) return null;
  if (hours <= 6) {
    return {
      kind: 'session',
      label: hours === Math.round(hours) ? hours + ' hours' : Math.round(hours * 60) + ' minutes',
    };
  }
  if (hours >= 6 * 24 && hours <= 8 * 24) return { kind: 'weekly', label: 'Week' };
  return {
    kind: Math.round(hours) + 'h',
    label: hours % 24 === 0 ? hours / 24 + ' days' : Math.round(hours) + ' hours',
  };
}

/** ISO string, from an ISO string or unix seconds; anything else is dropped. */
function normaliseReset(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

/** Cached subscription usage for one provider. Never throws. */
export async function providerQuota(provider: ProviderId, force = false): Promise<ProviderQuota> {
  const cached = cache.get(provider);
  if (cached && Date.now() < cached.until && (!force || cached.quota.error)) return cached.quota;

  let quota: ProviderQuota;
  let ttl = CACHE_MS;
  try {
    quota =
      provider === 'claude'
        ? await fetchClaude()
        : provider === 'codex'
          ? await fetchCodex()
          : await fetchProfile(provider);
    // A successful read that shows headroom clears a recorded failure; the
    // catch path below carries stale windows forward and must not.
    recoverIfHealthy(quota);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 0;
    ttl = status === 429 ? COOLDOWN_429_MS : COOLDOWN_ERROR_MS;
    quota = {
      ...unavailable(
        provider,
        status === 429
          ? 'Usage limits are temporarily unavailable (too many requests).'
          : status === 401
            ? 'Sign-in expired; the next chat will refresh it.'
            : 'Usage limits are temporarily unavailable.',
      ),
      // Keep the previous windows visible through a hiccup.
      windows: cached?.quota.windows ?? [],
      ...(cached?.quota.plan ? { plan: cached.quota.plan } : {}),
    };
  }
  cache.set(provider, { quota, until: Date.now() + ttl });
  return quota;
}

/** Feed a quota the provider stream reported, so the next read is fresh. */
export function rememberQuota(quota: ProviderQuota): void {
  const previous = cache.get(quota.provider)?.quota;
  const merged: ProviderQuota = {
    ...quota,
    ...(quota.plan || !previous?.plan ? {} : { plan: previous.plan }),
  };
  cache.set(quota.provider, { quota: merged, until: Date.now() + CACHE_MS });
  recoverIfHealthy(merged);
}

/* ------------------------------- usage gate ------------------------------- */

/** Why a provider is being routed around, and until when. */
export interface UsageBlock {
  reason: 'limit' | 'failure';
  until?: string;
}

/** A turn that died on quota parks its provider this long when no window reset is known. */
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
/** A maxed-out window that states no reset time is trusted only this long. */
const WINDOW_STALE_MS = 10 * 60 * 1000;
/** How old the cached quota may be before a read kicks off a background refresh. */
const REFRESH_AFTER_MS = 2 * CACHE_MS;

/** Set by a turn that died on quota; cleared by windows that show headroom again. */
const failures = new Map<ProviderId, { until: number }>();

/**
 * Whether a fatal turn error says the provider's quota gave out. Phrases, not
 * codes: the CLIs report usage limits as text, and the set stays narrow so an
 * ordinary tool or permission error never reads as one. `429` keeps to word
 * boundaries so a file count or a duration cannot match.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate.?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted|reached)/i,
  /insufficient (?:balance|quota|credit)/i,
  /limit reached/i,
];

export function isUsageLimitError(message: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Live windows under the wall prove a provider takes turns again. */
function recoverIfHealthy(quota: ProviderQuota): void {
  if (quota.windows.length && !quota.windows.some((window) => window.percent >= 100)) {
    failures.delete(quota.provider);
  }
}

/** The earliest window reset still in the future, in epoch ms. */
function futureReset(quota: ProviderQuota): number | undefined {
  const resets = quota.windows
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN))
    .filter((at) => Number.isFinite(at) && at > Date.now());
  return resets.length ? Math.min(...resets) : undefined;
}

/** A provider whose turn died on quota is left alone until its window resets. */
export function rememberUsageFailure(provider: ProviderId): void {
  const quota = cache.get(provider)?.quota;
  const until = (quota ? futureReset(quota) : undefined) ?? Date.now() + FAILURE_COOLDOWN_MS;
  const previous = failures.get(provider);
  // The longer horizon wins: a second failure never shortens the time the
  // first one already bought.
  if (!previous || previous.until < until) failures.set(provider, { until });
}

/** Forget a recorded failure, e.g. because a turn on the provider succeeded. */
export function rememberUsageRecovered(provider: ProviderId): void {
  failures.delete(provider);
}

/** Refresh a quota nobody has looked at for a while, without waiting for it. */
const refreshKicked = new Map<ProviderId, number>();

function refreshIfStale(provider: ProviderId, until: number): void {
  if (Date.now() < until + (REFRESH_AFTER_MS - CACHE_MS)) return;
  const kicked = refreshKicked.get(provider) ?? 0;
  // One kick per cache span: a fetch already in flight answers for the next.
  if (Date.now() - kicked < CACHE_MS) return;
  refreshKicked.set(provider, Date.now());
  void providerQuota(provider);
}

/**
 * Hard routing block: a recorded failure, or a window that is full and says
 * when it empties. Windows without a reset time only count while fresh,
 * because a full window that never states its end is indistinguishable from a
 * stale one. Never throws and never fetches on its own beyond a refresh.
 */
export function providerBlocked(provider: ProviderId): UsageBlock | null {
  const failure = failures.get(provider);
  if (failure) {
    if (failure.until > Date.now()) {
      return { reason: 'failure', until: new Date(failure.until).toISOString() };
    }
    failures.delete(provider);
  }

  const entry = cache.get(provider);
  if (!entry || entry.quota.error) return null;
  refreshIfStale(provider, entry.until);
  for (const window of entry.quota.windows) {
    if (window.percent < 100) continue;
    const reset = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
    if (Number.isFinite(reset)) {
      if (reset > Date.now()) return { reason: 'limit', until: new Date(reset).toISOString() };
    } else if (Date.now() - entry.quota.fetchedAt < WINDOW_STALE_MS) {
      return { reason: 'limit' };
    }
  }
  return null;
}

/**
 * Soft routing signal: some window of the provider's quota is at or above the
 * configured share. A provider nobody has reported usage for is never low -
 * unknown is not nearly-empty.
 */
export function providerLow(provider: ProviderId, thresholdPercent: number): boolean {
  const entry = cache.get(provider);
  if (!entry) return false;
  refreshIfStale(provider, entry.until);
  return entry.quota.windows.some((window) => window.percent >= thresholdPercent);
}
