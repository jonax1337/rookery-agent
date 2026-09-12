/**
 * The thinnest possible shell around the Telegram Bot API.
 *
 * Only what the gateway actually calls, on Node's own `fetch`: no framework,
 * no dependency, no state beyond the token. Everything that decides *whether*
 * a message may become a turn lives in `@rookery/core`'s policy; this file
 * only speaks HTTP.
 *
 * Two things it does take seriously. The bot token stands in the URL *path*
 * at Telegram, so any message that quotes a URL would hand out remote control
 * of the assistant - every string that leaves here is masked, including the
 * text of errors thrown by `fetch` itself. And the answer is judged by the
 * `{ ok, result }` envelope rather than by the HTTP status, because Telegram
 * reports plenty of refusals with a 200.
 */

const BASE_URL = 'https://api.telegram.org';

/** Timeout for the short calls. Long polling passes its own, far larger one. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** How long a `retry_after` may park a call before we give up on it. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Attempts spent on 429 before the error is handed to the caller. */
const MAX_RETRIES = 2;

/** What `getMe` gives us, as much of it as the gateway needs. */
export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

/**
 * One update, still foreign JSON. Only `update_id` is claimed here - the
 * offset bookkeeping needs it; the rest is handed to `classifyUpdate`
 * untouched and narrowed there.
 */
export type TelegramUpdate = { update_id: number } & Record<string, unknown>;

export interface TelegramSendOptions {
  parseMode?: 'HTML';
  /** Link previews turn a stray URL in an answer into a fetch we did not ask for. */
  disablePreview?: boolean;
  signal?: AbortSignal;
}

export interface TelegramGetUpdatesOptions {
  offset?: number;
  limit?: number;
  /** Long-poll seconds handed to Telegram; the HTTP timeout is derived from it. */
  timeout?: number;
  allowedUpdates?: string[];
  signal?: AbortSignal;
}

/**
 * A failed Bot API call. The distinctions the gateway acts on get their own
 * accessors: a 409 means a second process is polling the same bot and the
 * channel has to stop instead of fighting over updates, a 403 means the user
 * blocked the bot and push has nowhere to go.
 */
export class TelegramApiError extends Error {
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** Telegram's own `error_code`, when it sent an envelope. */
  readonly code?: number;
  /** Seconds Telegram asked us to wait, from `parameters.retry_after`. */
  readonly retryAfter?: number;
  readonly method: string;

  constructor(
    message: string,
    init: { method: string; status: number; code?: number; retryAfter?: number },
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.method = init.method;
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter;
  }

  /** Another instance is long-polling the same bot. */
  get conflict(): boolean {
    return this.status === 409 || this.code === 409;
  }

  /** The user blocked the bot, or never started it. */
  get forbidden(): boolean {
    return this.status === 403 || this.code === 403;
  }

  /** Telegram does not know this token. No amount of retrying fixes that. */
  get unauthorized(): boolean {
    return this.status === 401 || this.code === 401;
  }
}

export interface TelegramApi {
  getMe(signal?: AbortSignal): Promise<TelegramUser>;
  getUpdates(options?: TelegramGetUpdatesOptions): Promise<TelegramUpdate[]>;
  deleteWebhook(dropPendingUpdates: boolean, signal?: AbortSignal): Promise<void>;
  sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<void>;
  sendChatAction(chatId: number, action: string, signal?: AbortSignal): Promise<void>;
  /** Redact the token from anything that is about to be logged or shown. */
  mask(text: string): string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A sleep that never keeps the process alive on its own. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createTelegramApi(token: string): TelegramApi {
  const secret = token.trim();

  // Masking is a plain string replacement rather than a URL rewrite, because
  // the token also turns up in text we never built: `fetch` puts the whole URL
  // into its own error messages.
  const mask = (text: string): string =>
    secret.length > 0 ? text.split(secret).join('<token>') : text;

  async function call<T>(
    method: string,
    payload: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let attempt = 0;

    for (;;) {
      // A per-call deadline plus whatever the caller uses to stop the channel.
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

      let response: Response;
      try {
        response = await fetch(`${BASE_URL}/bot${secret}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TelegramApiError(mask(reason), { method, status: 0 });
      }

      const body = asRecord(await response.json().catch(() => undefined));
      const ok = body?.ok === true;
      if (ok && response.ok) return body?.result as T;

      const code = typeof body?.error_code === 'number' ? body.error_code : undefined;
      const description =
        typeof body?.description === 'string' ? body.description : `HTTP ${response.status}`;
      const retryAfter = asRecord(body?.parameters)?.retry_after;
      const seconds = typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : undefined;

      // Telegram's own rate limit is an instruction, not an opinion: wait the
      // requested time and try again, but never longer than a minute and never
      // forever, or a flood would stall the whole channel behind one call.
      const waitMs = seconds === undefined ? undefined : Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      if (
        (response.status === 429 || code === 429) &&
        waitMs !== undefined &&
        attempt < MAX_RETRIES &&
        !options.signal?.aborted
      ) {
        attempt += 1;
        await delay(waitMs, options.signal);
        continue;
      }

      throw new TelegramApiError(mask(description), {
        method,
        status: response.status,
        code,
        retryAfter: seconds,
      });
    }
  }

  return {
    mask,

    async getMe(signal) {
      return call<TelegramUser>('getMe', {}, { signal });
    },

    async getUpdates(options = {}) {
      const seconds = Math.max(0, Math.floor(options.timeout ?? 0));
      const payload: Record<string, unknown> = { timeout: seconds };
      if (options.offset !== undefined) payload.offset = options.offset;
      if (options.limit !== undefined) payload.limit = options.limit;
      if (options.allowedUpdates) payload.allowed_updates = options.allowedUpdates;
      // The socket has to outlive the long poll itself, with room for a slow
      // answer on top; otherwise every single poll would end in a timeout.
      const result = await call<unknown>('getUpdates', payload, {
        timeoutMs: seconds * 1000 + DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      });
      if (!Array.isArray(result)) return [];
      return result.filter(
        (entry): entry is TelegramUpdate =>
          typeof asRecord(entry)?.update_id === 'number',
      );
    },

    async deleteWebhook(dropPendingUpdates, signal) {
      await call<boolean>('deleteWebhook', { drop_pending_updates: dropPendingUpdates }, { signal });
    },

    async sendMessage(chatId, text, options = {}) {
      const payload: Record<string, unknown> = { chat_id: chatId, text };
      if (options.parseMode) payload.parse_mode = options.parseMode;
      if (options.disablePreview) payload.link_preview_options = { is_disabled: true };
      await call<unknown>('sendMessage', payload, { signal: options.signal });
    },

    async sendChatAction(chatId, action, signal) {
      await call<boolean>('sendChatAction', { chat_id: chatId, action }, { signal });
    },
  };
}
