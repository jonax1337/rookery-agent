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

/** A download gets longer than a call: 20 MB over a phone line is not instant. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Telegram's own ceiling for what a bot may fetch, and so ours. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

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
  /**
   * Answer a specific message rather than the chat. Telegram then draws the
   * quoted line above the answer, which is what keeps a reply to yesterday's
   * mail readable as a reply to yesterday's mail.
   */
  replyTo?: number;
  /**
   * Deliver without a sound. For the running commentary: it belongs in the
   * chat, it does not belong on the lock screen.
   */
  silent?: boolean;
  signal?: AbortSignal;
}

/** A file as `getFile` describes it: a path valid for about an hour. */
export interface TelegramFile {
  /** Relative path under `/file/bot<token>/`; absent for a file too large. */
  path?: string;
  size?: number;
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
  /** Returns Telegram's id for the message that was sent, when it says one. */
  sendMessage(chatId: number, text: string, options?: TelegramSendOptions): Promise<number | undefined>;
  sendChatAction(chatId: number, action: string, signal?: AbortSignal): Promise<void>;
  /** Rewrite a message the bot sent. Used for the one live progress line. */
  editMessageText(chatId: number, messageId: number, text: string, options?: TelegramSendOptions): Promise<void>;
  /**
   * Remove messages, up to 100 per call. Anything that cannot be deleted -
   * older than Telegram's 48 hours, already gone - is skipped rather than
   * failing the call.
   */
  deleteMessages(chatId: number, messageIds: number[], signal?: AbortSignal): Promise<void>;
  /** Put a single emoji reaction on a message, or clear it with no emoji. */
  setMessageReaction(chatId: number, messageId: number, emoji?: string, signal?: AbortSignal): Promise<void>;
  /** Publish the command list, which is what draws Telegram's own menu. */
  setMyCommands(commands: Array<{ command: string; description: string }>, signal?: AbortSignal): Promise<void>;
  /** What an empty chat shows above the Start button, and the profile page. */
  setMyDescription(description: string, shortDescription: string, signal?: AbortSignal): Promise<void>;
  /** Where a file id can be fetched from, for the next hour or so. */
  getFile(fileId: string, signal?: AbortSignal): Promise<TelegramFile>;
  /** The bytes themselves, refused rather than truncated when too large. */
  downloadFile(path: string, options?: { maxBytes?: number; signal?: AbortSignal }): Promise<Buffer>;
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
      if (options.silent) payload.disable_notification = true;
      if (options.replyTo !== undefined) {
        // `allow_sending_without_reply` so a deleted original costs the
        // quoted line rather than the whole answer.
        payload.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
      }
      const result = asRecord(await call<unknown>('sendMessage', payload, { signal: options.signal }));
      return typeof result?.message_id === 'number' ? result.message_id : undefined;
    },

    async sendChatAction(chatId, action, signal) {
      await call<boolean>('sendChatAction', { chat_id: chatId, action }, { signal });
    },

    async editMessageText(chatId, messageId, text, options = {}) {
      const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
      if (options.parseMode) payload.parse_mode = options.parseMode;
      if (options.disablePreview) payload.link_preview_options = { is_disabled: true };
      await call<unknown>('editMessageText', payload, { signal: options.signal });
    },

    async deleteMessages(chatId, messageIds, signal) {
      // Telegram takes at most a hundred at a time, and rejects an empty
      // list outright, so the batching is not optional.
      for (let index = 0; index < messageIds.length; index += 100) {
        const batch = messageIds.slice(index, index + 100);
        if (batch.length === 0) continue;
        await call<boolean>('deleteMessages', { chat_id: chatId, message_ids: batch }, { signal });
      }
    },

    async setMessageReaction(chatId, messageId, emoji, signal) {
      // An empty list is how a reaction is taken off again; Telegram has no
      // separate method for that.
      const reaction = emoji ? [{ type: 'emoji', emoji }] : [];
      await call<boolean>('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction }, { signal });
    },

    async setMyCommands(commands, signal) {
      await call<boolean>('setMyCommands', { commands }, { signal });
    },

    async setMyDescription(description, shortDescription, signal) {
      // Two calls, because Telegram keeps the long text (empty chat) and the
      // short one (profile card) apart, and a failure of one should not cost
      // the other.
      await call<boolean>('setMyDescription', { description }, { signal });
      await call<boolean>('setMyShortDescription', { short_description: shortDescription }, { signal });
    },

    async getFile(fileId, signal) {
      const result = asRecord(await call<unknown>('getFile', { file_id: fileId }, { signal }));
      const file: TelegramFile = {};
      if (typeof result?.file_path === 'string') file.path = result.file_path;
      if (typeof result?.file_size === 'number') file.size = result.file_size;
      return file;
    },

    /**
     * The download endpoint, which is the one place Telegram answers with
     * bytes instead of an envelope - so success is judged by the HTTP status
     * here, and only here.
     *
     * The path comes from `getFile`, but it is checked anyway: it goes into
     * a URL directly, and a `..` in a field we did not write has no business
     * walking up the file service. The size is checked twice, once against
     * the header and once against what actually arrived, because a missing
     * or lying `content-length` must not be the thing that decides how much
     * memory this takes.
     */
    async downloadFile(path, options = {}) {
      const clean = path.replace(/^\/+/, '');
      if (clean === '' || clean.includes('..') || /[\r\n]/.test(clean)) {
        throw new TelegramApiError('Telegram returned an unusable file path.', {
          method: 'downloadFile',
          status: 0,
        });
      }
      const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
      const deadline = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;

      let response: Response;
      try {
        response = await fetch(
          `${BASE_URL}/file/bot${secret}/${clean.split('/').map(encodeURIComponent).join('/')}`,
          { signal },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new TelegramApiError(mask(reason), { method: 'downloadFile', status: 0 });
      }

      if (!response.ok) {
        throw new TelegramApiError(mask(`HTTP ${response.status}`), {
          method: 'downloadFile',
          status: response.status,
        });
      }

      const announced = Number(response.headers.get('content-length'));
      if (Number.isFinite(announced) && announced > maxBytes) {
        throw new TelegramApiError('The file is larger than the configured limit.', {
          method: 'downloadFile',
          status: 413,
        });
      }

      const chunks: Buffer[] = [];
      let total = 0;
      // Streamed rather than `arrayBuffer()`: a body that ignores its own
      // content-length would otherwise be in memory before anyone objects.
      for await (const chunk of response.body ?? []) {
        const buffer = Buffer.from(chunk as Uint8Array);
        total += buffer.length;
        if (total > maxBytes) {
          throw new TelegramApiError('The file is larger than the configured limit.', {
            method: 'downloadFile',
            status: 413,
          });
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks);
    },
  };
}
