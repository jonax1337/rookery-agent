import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId, ProviderQuota, QuotaWindow } from '../types.js';

/**
 * Subscription usage, read the way the CLIs' own `/usage` panels read it:
 * with the OAuth login each CLI keeps on disk, from the vendor's own usage
 * endpoint. Neither endpoint is a public contract, so parsing is defensive
 * and anything unrecognised is dropped rather than shown raw.
 *
 * Both endpoints rate-limit eager pollers hard. One answer is cached for a
 * minute, a 429 backs off for five, and a failure for two, so a UI that asks
 * on every hover never turns into a hammer.
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
  const hours = seconds > 0 ? seconds / 3600 : 0;
  let kind: string = fallbackKind;
  let label = fallbackKind === 'session' ? 'Session' : 'Week';
  if (hours > 0 && hours <= 6) {
    kind = 'session';
    label = hours === Math.round(hours) ? hours + ' hours' : Math.round(hours * 60) + ' minutes';
  } else if (hours >= 6 * 24 && hours <= 8 * 24) {
    kind = 'weekly';
    label = 'Week';
  } else if (hours > 0) {
    kind = Math.round(hours) + 'h';
    label = hours % 24 === 0 ? hours / 24 + ' days' : Math.round(hours) + ' hours';
  }
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

/* --------------------------------- shared --------------------------------- */

class HttpError extends Error {
  constructor(readonly status: number) {
    super('HTTP ' + status);
  }
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
    quota = provider === 'claude' ? await fetchClaude() : await fetchCodex();
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
  cache.set(quota.provider, {
    quota: { ...quota, ...(quota.plan || !previous?.plan ? {} : { plan: previous.plan }) },
    until: Date.now() + CACHE_MS,
  });
}
