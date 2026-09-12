import {
  ASSISTANT_MEMORY_OWNER,
  classifyUpdate,
  escapeHtml,
  missingGatewaySettings,
  nextGatewayAction,
  providerQuota,
  splitMessage,
  type GatewayLifecycleState,
  type GatewayVerdict,
  type Session,
  type TelegramGatewayConfig,
} from '@rookery/core';
import type { ServerContext } from '../context.js';
import {
  createTelegramApi,
  TelegramApiError,
  type TelegramApi,
  type TelegramUpdate,
} from './telegram-api.js';

/**
 * The Telegram transport: the part that actually talks to api.telegram.org.
 *
 * Who may talk to the assistant from a phone is decided in
 * `@rookery/core`'s gateway policy and nowhere else - this file long-polls,
 * hands every update to `classifyUpdate`, and carries the verdict out. What
 * it adds on top is the behaviour a guard cannot express: a rejected update
 * gets no answer at all (a bot that replies "not allowed" tells a stranger he
 * found the right bot), the offset only moves after an update was classified,
 * and a flood from one sender queues instead of starting ten provider
 * processes at once.
 */

/** Seconds we ask Telegram to hold a poll open. */
const POLL_SECONDS = 50;

/** Only messages. Edits, callback queries and channel posts never arrive. */
const ALLOWED_UPDATES = ['message'];

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/** Telegram's typing bubble fades after a few seconds, so it is refreshed. */
const TYPING_INTERVAL_MS = 4000;

/** Silence a turn may spend before the first "still working" line goes out. */
const FIRST_NOTE_MS = 20_000;

/** Minimum distance between two progress lines after that first one. */
const NOTE_INTERVAL_MS = 60_000;

/** Messages one sender may have waiting. Beyond it, the rest is refused. */
const MAX_QUEUE_DEPTH = 3;

/** How often the same stranger can learn their own id. */
const ID_REPLY_INTERVAL_MS = 60 * 60 * 1000;

/** How much of a message ends up in the log. */
const AUDIT_TEXT = 120;
const REJECT_TEXT = 80;

export interface GatewayStatus {
  id: 'telegram';
  label: string;
  /** A bot token is set, wherever it came from. */
  configured: boolean;
  /** Where it came from: the settings page, the environment, or nowhere yet. */
  tokenSource: 'config' | 'env' | 'none';
  enabled: boolean;
  running: boolean;
  botUsername?: string;
  allowedCount: number;
  /**
   * Stopped for a reason that will not pass on its own - a rejected token, a
   * second process on the same bot. Distinct from "off": nothing is being
   * retried, and only a new token or an off/on will start it again.
   */
  blocked: boolean;
  lastError?: string;
  lastEventAt?: number;
}

export interface GatewayHandle {
  readonly id: 'telegram';
  start(): Promise<void>;
  stop(): Promise<void>;
  /** React to a config change: start or stop accordingly. */
  refresh(): Promise<void>;
  status(): GatewayStatus;
  send(userId: number, text: string): Promise<void>;
}

interface SenderQueue {
  depth: number;
  tail: Promise<void>;
}

/**
 * Markdown fences to Telegram HTML.
 *
 * `splitMessage` guarantees every piece carries balanced fences, so a piece
 * can be converted on its own. Everything outside a block is escaped text;
 * inside, the block is escaped in one go and wrapped in `<pre>`, which is the
 * only tag Telegram renders as a code block.
 */
function toHtml(piece: string): string {
  const out: string[] = [];
  let code: string[] | undefined;
  for (const line of piece.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
        code = undefined;
      } else {
        code = [];
      }
      continue;
    }
    if (code) code.push(line);
    else out.push(escapeHtml(line));
  }
  if (code) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
  return out.join('\n');
}

/** A sleep that neither keeps the process alive nor outlives a stop(). */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The sender's username, straight out of the raw update, for the log only. */
function usernameOf(update: TelegramUpdate): string | undefined {
  const message = update.message as Record<string, unknown> | undefined;
  const from = message?.from as Record<string, unknown> | undefined;
  return typeof from?.username === 'string' ? from.username : undefined;
}

export function createTelegramGateway(context: ServerContext): GatewayHandle {
  const log = context.log.child('telegram');

  let api: TelegramApi | undefined;
  /** The token the running poller was built with, to notice a swapped one. */
  let activeToken = '';
  let loop: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let running = false;
  let offset = 0;
  let botUsername: string | undefined;
  let lastError: string | undefined;
  /**
   * Why the channel gave up for good, and on which token.
   *
   * Two failures never heal by themselves: a token Telegram does not know
   * (401), and a second process polling the same bot (409). Retrying either
   * on a timer is a log full of the same line forever. So the channel stops
   * and stays stopped - but "stopped" must not mean "stopped for all time",
   * or a fixed token would need a server restart to take effect. The token
   * it failed with is therefore part of the record: change it and the block
   * is void. Switching the channel off clears it too, because that is the
   * gesture a person makes when they mean "try again from scratch".
   */
  let blocked: { reason: string; token: string } | undefined;
  let lastEventAt: number | undefined;
  /** `/aus` silences the channel until the process is restarted, not until the next config write. */
  let silenced = false;

  const queues = new Map<number, SenderQueue>();
  /** One running turn per sender, so `/stop` knows what to abort. */
  const turns = new Map<number, AbortController>();
  /** Per chat, so two answers never race each other onto the wire. */
  const outbox = new Map<number, Promise<void>>();
  const idReplies = new Map<number, number>();

  const settings = (): TelegramGatewayConfig => context.config.gateways.telegram;
  // The config is the source: `loadConfig` has already let TELEGRAM_BOT_TOKEN
  // override the stored value, so reading one place reads both.
  const token = (): string => settings().token.trim();
  // Which of the two it was. A page must not offer to edit a field that an
  // environment variable is going to shadow on the next start.
  const tokenSource = (): GatewayStatus['tokenSource'] =>
    process.env.TELEGRAM_BOT_TOKEN?.trim() ? 'env' : token() ? 'config' : 'none';

  /* --------------------------- sending --------------------------- */

  // Everything outgoing goes through one chain per chat: a progress line, an
  // answer and a push notification can be produced concurrently, but Telegram
  // shows them in the order they arrive, and out-of-order is confusing.
  function chain(chatId: number, run: () => Promise<void>): Promise<void> {
    const previous = outbox.get(chatId) ?? Promise.resolve();
    const next = previous.then(run, run);
    outbox.set(
      chatId,
      next.catch(() => {}),
    );
    return next;
  }

  async function deliver(chatId: number, text: string): Promise<void> {
    const client = api;
    if (!client) throw new Error('The Telegram gateway is not running.');
    for (const piece of splitMessage(text)) {
      await client.sendMessage(chatId, toHtml(piece), {
        parseMode: 'HTML',
        disablePreview: true,
      });
    }
  }

  /** Fire-and-forget delivery: used where a failed line must not break a turn. */
  function say(chatId: number, text: string): void {
    void chain(chatId, () => deliver(chatId, text)).catch((error: unknown) => {
      log.warn('Telegram send failed', { chatId, error: errorText(error) });
    });
  }

  /* --------------------------- sessions --------------------------- */

  /**
   * The conversation behind a chat. Deliberately an ordinary `chat` session
   * rather than a kind of its own, so what was said from the phone shows up
   * in the same sidebar as everything else.
   */
  function resolveSession(chatId: number, fresh = false): Session {
    const key = `telegram:chat:${chatId}`;
    if (!fresh) {
      const known = context.assistant.store.getMeta(key);
      const session = known ? context.assistant.getSession(known) : null;
      if (session) return session;
    }
    const session = context.assistant.createSession({ title: 'Telegram', kind: 'chat' });
    context.assistant.store.setMeta(key, session.id);
    return session;
  }

  /* --------------------------- commands --------------------------- */

  async function statusText(): Promise<string> {
    const lines: string[] = [];
    const provider = context.config.defaultProvider;
    const model = settings().model ?? context.config.defaultModel;
    lines.push(`Provider: ${provider}${model ? ` (${model})` : ''}`);

    try {
      const quota = await providerQuota(provider);
      const windows = quota.windows.map((w) => `${w.label} ${w.percent} %`).join(', ');
      lines.push(`Usage limits: ${windows || quota.error || 'unknown'}`);
    } catch (error) {
      lines.push(`Usage limits: unknown (${errorText(error)})`);
    }

    try {
      const orgId = context.assistant.org.activeOrganization().id;
      const open = context.assistant.store.org.listAssignments(orgId, {
        status: ['pending', 'running'],
        limit: 20,
      });
      lines.push(`Active assignments: ${open.length}`);
    } catch {
      lines.push('Active assignments: no company configured');
    }

    const [last] = context.assistant.store.listSleepRuns({
      owner: ASSISTANT_MEMORY_OWNER,
      limit: 1,
    });
    lines.push(
      last
        ? `Last sleep run: ${new Date(last.startedAt).toLocaleString('en-GB')} (${last.status})`
        : 'Last sleep run: none yet',
    );
    return lines.join('\n');
  }

  /** Returns true when the message was a command and is fully dealt with. */
  async function handleCommand(verdict: GatewayVerdict): Promise<boolean> {
    const chatId = verdict.chatId;
    const userId = verdict.userId;
    if (chatId === undefined || userId === undefined || !verdict.command) return false;

    switch (verdict.command) {
      case 'start':
        say(
          chatId,
          `Hello, this is ${context.config.assistantName}. Send a message and I will reply in ` +
            'the same conversation you can access in the browser.\n\n' +
            '/new new conversation, /stop cancel the current turn, /status current state, ' +
            '/id your user ID, /off silence the gateway until restart.',
        );
        return true;

      case 'new':
      case 'neu': {
        const session = resolveSession(chatId, true);
        log.info('Telegram session replaced', { from: userId, sessionId: session.id });
        say(chatId, 'New conversation created. The previous one is preserved.');
        return true;
      }

      case 'stop': {
        const turn = turns.get(userId);
        // The turn itself reports "Cancelled." on its way out, so this
        // branch stays silent unless there was nothing to stop.
        if (turn) turn.abort();
        else say(chatId, 'Nothing is running.');
        return true;
      }

      case 'status':
        say(chatId, await statusText());
        return true;

      case 'id':
        say(chatId, String(userId));
        return true;

      case 'off':
      case 'aus':
        silenced = true;
        say(chatId, 'The gateway is silenced until restart.');
        // Let the farewell leave before the socket does.
        void chain(chatId, () => Promise.resolve()).finally(() => {
          void stop();
        });
        return true;

      default:
        say(
          chatId,
          'Unknown command. Available commands: /start, /new, /stop, /status, /id and /off.',
        );
        return true;
    }
  }

  /* ----------------------------- turns ----------------------------- */

  async function runTurn(userId: number, chatId: number, text: string): Promise<void> {
    const config = settings();
    const session = resolveSession(chatId);

    log.info('Telegram message accepted', {
      from: userId,
      sessionId: session.id,
      permission: config.permission,
      text: text.slice(0, AUDIT_TEXT),
    });

    const turn = new AbortController();
    turns.set(userId, turn);

    const typing = setInterval(() => {
      void api?.sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);
    typing.unref?.();
    void api?.sendChatAction(chatId, 'typing').catch(() => {});

    let noteAt = 0;
    const note = (line: string): void => {
      noteAt = Date.now();
      say(chatId, line);
    };
    // Nothing to show yet is the normal state of a long turn; without a sign
    // of life the phone looks broken. Only when the turn has said nothing at
    // all so far - an error line is a sign of life too.
    const firstNote = setTimeout(() => {
      if (noteAt === 0) note('Still working on it ...');
    }, FIRST_NOTE_MS);
    firstNote.unref?.();

    let answer = '';
    try {
      for await (const event of context.assistant.chat({
        text,
        sessionId: session.id,
        permission: config.permission,
        model: config.model,
        signal: turn.signal,
      })) {
        if (event.type === 'done') {
          answer = event.text;
        } else if (event.type === 'error') {
          // Never swallowed: an error the user does not see is an answer that
          // simply never arrives.
          say(chatId, `Error: ${event.message}`);
          noteAt = Date.now();
        } else if (event.type === 'status' && noteAt > 0) {
          if (Date.now() - noteAt >= NOTE_INTERVAL_MS) {
            note(event.detail ? `${event.label} – ${event.detail}` : event.label);
          }
        }
      }
    } catch (error) {
      if (!turn.signal.aborted) {
        log.error('Telegram turn failed', { from: userId, error: errorText(error) });
        say(chatId, `Error: ${errorText(error)}`);
      }
    } finally {
      clearTimeout(firstNote);
      clearInterval(typing);
      if (turns.get(userId) === turn) turns.delete(userId);
    }

    if (turn.signal.aborted) say(chatId, 'Cancelled.');
    else if (answer.trim().length > 0) say(chatId, answer);
    else say(chatId, 'No answer was returned.');
  }

  /* ---------------------------- dispatch ---------------------------- */

  function enqueue(userId: number, job: () => Promise<void>): boolean {
    const queue = queues.get(userId) ?? { depth: 0, tail: Promise.resolve() };
    if (queue.depth >= MAX_QUEUE_DEPTH) return false;
    queue.depth += 1;
    queues.set(userId, queue);
    queue.tail = queue.tail
      .then(job, job)
      .catch((error: unknown) => {
        log.error('Telegram turn crashed', { from: userId, error: errorText(error) });
      })
      .finally(() => {
        queue.depth -= 1;
        if (queue.depth <= 0) queues.delete(userId);
      });
    return true;
  }

  function handleUpdate(update: TelegramUpdate): void {
    const verdict = classifyUpdate(update, settings());
    lastEventAt = Date.now();

    if (!verdict.ok) {
      log.warn('Telegram update rejected', {
        from: verdict.userId,
        username: usernameOf(update),
        reason: verdict.reason,
        text: verdict.text?.slice(0, REJECT_TEXT),
      });

      // The one and only answer a rejected update ever gets: the number the
      // sender already carries. Without it nobody can put themselves on the
      // allowlist; with it they learn nothing new. Once an hour, so it cannot
      // be used as an echo, and only in the sender's own chat - the
      // allowlist check comes before the private-chat one, so this is the
      // last place that could turn the bot into a voice in a group.
      if (verdict.reason === 'not_allowed' && verdict.command === 'id') {
        const userId = verdict.userId;
        const chatId = verdict.chatId;
        if (userId !== undefined && chatId === userId) {
          const last = idReplies.get(userId) ?? 0;
          if (Date.now() - last >= ID_REPLY_INTERVAL_MS) {
            idReplies.set(userId, Date.now());
            say(chatId, String(userId));
          }
        }
      }
      return;
    }

    if (verdict.command) {
      // Commands bypass the queue: `/stop` has to reach a running turn, not
      // wait behind it.
      void handleCommand(verdict).catch((error: unknown) => {
        log.warn('Telegram command failed', {
          command: verdict.command,
          error: errorText(error),
        });
      });
      return;
    }

    // An accepted verdict always carries all three, but they are checked
    // rather than asserted - nothing here narrows foreign input by claim.
    const { userId, chatId, text } = verdict;
    if (userId === undefined || chatId === undefined || text === undefined) return;

    if (!enqueue(userId, () => runTurn(userId, chatId, text))) {
      say(
        chatId,
        'The queue is full. Please wait until I have answered the previous messages.',
      );
    }
  }

  /* ----------------------------- polling ----------------------------- */

  async function poll(client: TelegramApi, signal: AbortSignal): Promise<void> {
    let backoff = BACKOFF_START_MS;

    while (!signal.aborted) {
      try {
        const updates = await client.getUpdates({
          offset,
          timeout: POLL_SECONDS,
          allowedUpdates: ALLOWED_UPDATES,
          signal,
        });
        backoff = BACKOFF_START_MS;
        for (const update of updates) {
          if (signal.aborted) break;
          try {
            handleUpdate(update);
          } catch (error) {
            // One unclassifiable update must not become a wall: retrying it
            // forever would only reproduce the same throw, and leaving the
            // offset where it is would hand it to us again on every poll.
            log.error('Telegram update could not be handled', { error: errorText(error) });
          }
          // Only now, so a crash mid-poll costs at most this one update
          // rather than the whole backlog behind it.
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted) break;

        // Two processes polling the same bot steal each other's updates
        // forever. Stopping with a visible reason beats a silent tug of war.
        if (error instanceof TelegramApiError && error.conflict) {
          lastError = 'Another process is polling the same bot (409). Gateway stopped.';
          blocked = { reason: lastError, token: activeToken };
          log.error('Telegram polling conflict, gateway stopped', { error: error.message });
          break;
        }

        // A token Telegram rejects will be rejected again in sixty seconds,
        // and in sixty after that. Say so once and wait for a new one.
        if (error instanceof TelegramApiError && error.unauthorized) {
          lastError = 'Telegram rejected this bot token (401). Gateway stopped.';
          blocked = { reason: lastError, token: activeToken };
          log.error('Telegram rejected the bot token, gateway stopped');
          break;
        }

        lastError = error instanceof TelegramApiError ? error.message : errorText(error);
        log.warn('Telegram polling failed, backing off', { waitMs: backoff, error: lastError });
        await delay(backoff, signal);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }

    running = false;
  }

  /* ---------------------------- lifecycle ---------------------------- */

  async function start(): Promise<void> {
    if (running) return;
    const config = settings();
    const secret = token();

    // Whoever calls start directly gets the same answer refresh would give:
    // a block only lifts when the token it named has changed.
    if (blocked && blocked.token === secret) {
      log.info('Telegram gateway stays stopped', { reason: blocked.reason });
      return;
    }

    // Say which condition was missing, never what the token was. The
    // decision itself lives in core/gateway/policy.ts, tested there.
    const missing = missingGatewaySettings(config, secret, silenced);
    if (missing.length > 0) {
      log.info('Telegram gateway not started', { missing });
      return;
    }

    const client = createTelegramApi(secret);
    try {
      // Webhook and backlog go first. A restart must not replay yesterday's
      // commands, so the offset is parked behind the last known update.
      await client.deleteWebhook(true);
      const me = await client.getMe();
      botUsername = me.username;
      const newest = (await client.getUpdates({ offset: -1, limit: 1, timeout: 0 })).at(-1);
      offset = newest ? newest.update_id + 1 : 0;
    } catch (error) {
      // The same two hopeless cases, caught on the way up rather than in the
      // loop: getMe is where a bad token usually announces itself.
      if (error instanceof TelegramApiError && (error.unauthorized || error.conflict)) {
        lastError = error.unauthorized
          ? 'Telegram rejected this bot token (401). Gateway stopped.'
          : 'Another process is polling the same bot (409). Gateway stopped.';
        blocked = { reason: lastError, token: secret };
        log.error('Telegram gateway cannot run with these settings', { reason: lastError });
        return;
      }
      lastError = error instanceof TelegramApiError ? error.message : errorText(error);
      log.error('Telegram gateway failed to start', { error: lastError });
      return;
    }

    api = client;
    activeToken = secret;
    lastError = undefined;
    running = true;
    controller = new AbortController();
    log.info('Telegram gateway started', {
      bot: botUsername,
      allowed: config.allowedUserIds.length,
      permission: config.permission,
    });
    loop = poll(client, controller.signal);
  }

  async function stop(): Promise<void> {
    controller?.abort();
    for (const turn of turns.values()) turn.abort();
    turns.clear();
    const pending = loop;
    controller = undefined;
    loop = undefined;
    running = false;
    // The client goes too, or `/aus` and a disabled channel would still reach
    // the phone through `send`: push holds this handle and only stops asking
    // when there is nothing left to send with.
    api = undefined;
    if (pending) await pending.catch(() => {});
    log.info('Telegram gateway stopped');
  }

  async function refresh(): Promise<void> {
    const config = settings();
    const secret = token();
    // The branch tree - switching off resets a block (that is the gesture
    // for "try again from scratch"), a swapped token while running is a
    // restart, a block on the same token is left alone - lives in
    // core/gateway/policy.ts, tested there without a fake Telegram API.
    const state: GatewayLifecycleState = { running, activeToken, blockedToken: blocked?.token };
    const decision = nextGatewayAction(state, config, secret, silenced);
    if (decision.clearBlock) blocked = undefined;

    switch (decision.action) {
      case 'stop':
        await stop();
        return;
      case 'restart':
        await stop();
        await start();
        return;
      case 'start':
        await start();
        return;
      case 'none':
        return;
    }
  }

  return {
    id: 'telegram',

    start,
    stop,
    refresh,

    status(): GatewayStatus {
      const config = settings();
      return {
        id: 'telegram',
        label: 'Telegram',
        configured: token() !== '',
        tokenSource: tokenSource(),
        enabled: config.enabled,
        running,
        botUsername,
        allowedCount: config.allowedUserIds.length,
        blocked: blocked !== undefined && blocked.token === token(),
        lastError,
        lastEventAt,
      };
    },

    /**
     * The way push reaches a phone. The chat id of a private chat is the user
     * id, so no lookup is needed. A 403 (the user blocked the bot) arrives at
     * the caller as a `TelegramApiError` with `forbidden`, because whoever
     * sends notifications has to be able to stop sending them.
     */
    async send(userId: number, text: string): Promise<void> {
      await chain(userId, () => deliver(userId, text));
    },
  };
}
