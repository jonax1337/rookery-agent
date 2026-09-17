import {
  ASSISTANT_MEMORY_OWNER,
  classifyCallback,
  classifyUpdate,
  isAudible,
  mailReadCallbackData,
  mailReadDoneCallbackData,
  missingGatewaySettings,
  nextGatewayAction,
  providerQuota,
  questionCallbackData,
  questionDoneCallbackData,
  readCallbackData,
  splitMessage,
  type AgentEvent,
  type GatewayAttachment,
  type GatewayLifecycleState,
  type GatewayRejection,
  type GatewayReplyTo,
  type GatewayVerdict,
  type QuestionAnswer,
  type Session,
  type TelegramGatewayConfig,
} from '@rookery/core';
import type { ServerContext } from '../context.js';
import { localModelReady, transcribe, SttError } from '../services/stt.js';
import { voiceKeys } from '../services/voice-keys.js';
import { humanDuration, humanSize, pruneInbox, saveAttachment } from './attachments.js';
import { toTelegramHtml } from './markdown.js';
import {
  findOrigin,
  noteMessages,
  openThread,
  originContext,
  rememberOrigin,
  takeMessages,
  type MessageOrigin,
} from './threads.js';
import {
  createTelegramApi,
  TelegramApiError,
  type TelegramApi,
  type TelegramInlineKeyboard,
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

/**
 * Messages, and taps on the buttons the bot drew itself. Edits, channel
 * posts and everything else never arrive.
 */
const ALLOWED_UPDATES = ['message', 'callback_query'];

/**
 * The two things this channel draws buttons for, and nothing else.
 *
 * What goes *on* a button - the prefixes and how they read back - lives in
 * `@rookery/core`'s gateway policy, next to the guard that decides whether a
 * tap counts at all. What is left here is the drawing: labels, rows, and the
 * wording a spent button carries. Mail ids and question ids are opaque to
 * the phone either way; a tap is believed because the guard chain proved who
 * pressed it, never because of what the data says.
 */

/**
 * The button as it is drawn under a fresh mail push.
 *
 * The label is an *invitation*, not a state, and the difference is the whole
 * point: the first version read "✓ Read" both before and after the tap, so
 * the button did change and nobody could see it. A button says what tapping
 * it will do; what it did belongs to `mailReadDone` below.
 *
 * Exported so `push.ts` can ask for it without knowing what goes on a
 * button: the wording stays in the one file that also draws the rest.
 */
export function mailReadKeyboard(mailId: string): TelegramInlineKeyboard {
  return [[{ text: 'Mark as read', callbackData: mailReadCallbackData(mailId) }]];
}

/**
 * The same button, spent: a statement, with the time it happened.
 *
 * The clock is the server's own, because that is the room the user is in -
 * Telegram tells a bot nothing about the phone's time zone.
 */
export function mailReadDone(at: number): TelegramInlineKeyboard {
  const stamp = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return [[{ text: '✓ Read at ' + stamp, callbackData: mailReadDoneCallbackData() }]];
}

/** The assistant's question, as it arrives on the wire. */
export type QuestionPrompt = Extract<AgentEvent, { type: 'question' }>;

/** How a question ended, in the words the closing event uses. */
export type QuestionClosedReason = Extract<AgentEvent, { type: 'question-closed' }>['reason'];

/** Longest an option reads on a button before the phone wraps it badly. */
const OPTION_LABEL = 48;

/**
 * The options of an open question, one per row.
 *
 * Numbered, and numbered the same way the message above them is, because
 * there are two ways to answer on this channel and they have to agree: a tap
 * on "2." and the typed reply "2" must mean the same option. One option per
 * row rather than two side by side - a label long enough to be worth reading
 * is a label that gets cut in half in a two-column keyboard.
 */
export function questionKeyboard(question: QuestionPrompt): TelegramInlineKeyboard {
  return question.options.map((option, index) => [
    {
      text: String(index + 1) + '. ' + oneLine(option.label, OPTION_LABEL),
      callbackData: questionCallbackData(question.id, index),
    },
  ]);
}

/**
 * What is left standing once a question is over.
 *
 * The same reasoning as the mail button: Telegram has no disabled state, so
 * the spent keyboard is a keyboard too, and its one job is to say what
 * happened - including when the answer came from the web app or the terminal
 * rather than from here, which is the case this exists for.
 */
export function questionClosedKeyboard(
  reason: QuestionClosedReason | 'gone',
  chosen?: string,
): TelegramInlineKeyboard {
  const text =
    reason === 'answered'
      ? '✓ ' + oneLine(chosen || 'Answered', OPTION_LABEL)
      : reason === 'expired'
        ? '⏳ No answer in time'
        : reason === 'cancelled'
          ? '✕ Withdrawn'
          : // Closed between drawing the buttons and pressing one, and this
            // channel was not told which way. Saying that is better than
            // picking the likelier of two wordings and being wrong.
            '• No longer open';
  return [[{ text, callbackData: questionDoneCallbackData() }]];
}

/**
 * The question as a message.
 *
 * The options are written out above the buttons even though the buttons
 * carry them too, and that is deliberate: a button holds a label and nothing
 * more, while an option that needs a sentence of explanation only has room
 * for it here. The numbering is the bridge between the two answers this
 * channel takes - tapping "2." and writing "2" are the same act.
 *
 * The deadline is named rather than implied. A question that quietly stops
 * mattering while the phone is in a pocket is worse than one that said when
 * it would.
 */
export function questionText(question: QuestionPrompt): string {
  const lines = [
    '❓ ' + oneLine(question.header, 80),
    '',
    question.question.trim(),
    '',
    ...question.options.map(
      (option, index) =>
        String(index + 1) + '. ' + option.label + (option.description ? ' – ' + option.description : ''),
    ),
    '',
    question.multiSelect
      ? 'Tap one, or write the numbers you mean ("1 3"), or answer in your own words.'
      : 'Tap one, write its number, or answer in your own words.',
  ];
  if (Number.isFinite(question.expiresAt) && question.expiresAt > 0) {
    const stamp = new Date(question.expiresAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    lines.push('If nothing comes back by ' + stamp + ' I carry on without it.');
  }
  return lines.join('\n');
}

/**
 * A typed reply, read as an answer to the question that is open.
 *
 * Three shapes, in the order a person is likely to mean them: the numbers
 * printed next to the options, the wording of an option itself, and anything
 * else, which is a free answer and goes through whole. Nothing is rejected -
 * the registry takes free text on purpose, and a reply this cannot classify
 * is still the user talking to the question, not a new turn.
 *
 * Exported for its own test: "1" meaning the first option and "1" meaning
 * the literal word are the same three characters, and only the open question
 * tells them apart.
 */
export function readTypedAnswer(text: string, question: QuestionPrompt): QuestionAnswer {
  const at = Date.now();
  const written = text.trim();
  const source = 'telegram' as const;

  const tokens = written.split(/[\s,;]+/).filter(Boolean);
  const numbers = tokens.map((token) => Number(token));
  const inRange = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= question.options.length;
  if (tokens.length > 0 && numbers.every(inRange)) {
    const picked = [...new Set(numbers.map((value) => value - 1))];
    return { selected: question.multiSelect ? picked : picked.slice(0, 1), source, at };
  }

  const flat = written.toLowerCase();
  const labelled = question.options.findIndex((option) => option.label.trim().toLowerCase() === flat);
  if (labelled >= 0) return { selected: [labelled], source, at };

  return { selected: [], text: written, source, at };
}

/** The labels behind an answer, for the button that says what was chosen. */
function chosenLabels(question: QuestionPrompt, answer: QuestionAnswer | undefined): string | undefined {
  if (!answer) return undefined;
  const labels = answer.selected
    .map((index) => question.options[index]?.label)
    .filter((label): label is string => Boolean(label));
  if (labels.length > 0) return labels.join(', ');
  return answer.text?.trim() || undefined;
}

/**
 * How long an album is waited for.
 *
 * Several photos sent at once arrive as several updates that share a
 * `media_group_id`, one per picture, a few hundred milliseconds apart. One
 * turn per picture would answer the first one before the third has landed,
 * so the group is collected and handed over as a single message. The window
 * restarts with every further item, and one and a half seconds is well past
 * what Telegram needs to deliver them.
 */
const ALBUM_WINDOW_MS = 1500;

/** Most files one message (or one album) may carry into a single turn. */
const MAX_ATTACHMENTS = 10;

/** How much of a transcript is echoed back so the sender can check it. */
const TRANSCRIPT_ECHO = 600;

/** Smallest gap between two rewrites of the live progress line. */
const PROGRESS_EDIT_MS = 12_000;

/**
 * How soon the first words of a streamed answer go out, and how far apart
 * every rewrite after them is.
 *
 * Telegram rate limits edits per chat, and a turn that produces a page of
 * text would otherwise ask for a hundred of them. Half a second to first
 * sight, then one and a half between updates: fast enough to read as typing,
 * slow enough that a long answer costs tens of calls rather than hundreds.
 */
const STREAM_FIRST_MS = 500;
const STREAM_EDIT_MS = 1500;

/** How many rows a list command shows before it says "and more". */
const LIST_LIMIT = 8;

/**
 * How far back `/clear` counts from the newest message.
 *
 * Message ids are a per-chat counter, so this is "the last thousand
 * messages", not a thousand deletions: Telegram is handed the ids a hundred
 * at a time and skips whatever is not there or too old to delete. A
 * thousand covers a very talkative 48 hours - which is all Telegram will
 * delete anyway - at ten API calls per `/clear`.
 */
const CLEAR_SWEEP = 1000;

/**
 * The commands, in the order Telegram's menu shows them.
 *
 * One table, three uses: `/help` prints it, `setMyCommands` hands it to
 * Telegram so the app draws its own menu, and the switch in `handleCommand`
 * answers it. A command that is added in one place and forgotten in another
 * is the usual way a bot ends up lying about itself, so there is only the
 * one place. The German aliases (`/neu`, `/aus`) are still accepted and
 * deliberately not listed - they are history, not a second interface.
 *
 * Exported for the test that holds it against Telegram's own rules: the
 * whole list is refused if a single entry breaks them, and a refused list
 * is a menu that silently never appears.
 */
export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help', description: 'Every command, with what it does' },
  { command: 'new', description: 'Start a new conversation, keep the old one' },
  { command: 'clear', description: 'Empty this chat and start fresh' },
  { command: 'stop', description: 'Cancel the turn that is running' },
  { command: 'status', description: 'Provider, usage limits, running work, last sleep' },
  { command: 'tasks', description: 'Open tasks on the board' },
  { command: 'mail', description: 'Unread mail addressed to you' },
  { command: 'agents', description: 'Who works in the company' },
  { command: 'schedules', description: 'What runs on a schedule, and when' },
  { command: 'id', description: 'Your numeric Telegram ID' },
  { command: 'off', description: 'Silence the gateway until the server restarts' },
];

/** Reactions the bot puts on the sender's own message while it works. */
const REACTION = {
  /** Taken in, working on it. */
  working: '👀',
  /** Answered. */
  done: '👍',
  /** Something went wrong; the error itself still arrives as a message. */
  failed: '😢',
} as const;

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

/**
 * How long after a start that failed on something transient before trying
 * again, doubling up to the ceiling. Five seconds so a laptop whose network
 * arrives a moment late is back within one, a minute so a Telegram outage is
 * not hammered.
 */
const RETRY_START_MS = 5000;
const RETRY_MAX_MS = 60_000;

/** Telegram's typing bubble fades after a few seconds, so it is refreshed. */
const TYPING_INTERVAL_MS = 4000;

/** Silence a turn may spend before the live progress line appears. */
const FIRST_NOTE_MS = 20_000;

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
  /** Returns the ids of the messages that went out, newest call last. */
  send(
    userId: number,
    text: string,
    options?: { origin?: Omit<MessageOrigin, 'at'>; silent?: boolean; keyboard?: TelegramInlineKeyboard },
  ): Promise<number[]>;
  /**
   * Put an open question in front of one person, at most once per question.
   *
   * Two paths lead here and both are needed: the turn that asked, when it is
   * a Telegram turn, and `push.ts`, when the question was raised at a screen
   * the user has walked away from. They arrive milliseconds apart for a
   * Telegram turn, so this is idempotent per question and chat rather than
   * relying on either caller to know about the other.
   */
  ask(userId: number, question: QuestionPrompt): void;
  /**
   * Take a question's buttons away once it is over - answered here, answered
   * in the web app, withdrawn or expired. What is left says which.
   */
  closeQuestion(id: string, reason: QuestionClosedReason, answer?: QuestionAnswer): void;
}

interface SenderQueue {
  depth: number;
  tail: Promise<void>;
}

/** One question, as it currently stands in one chat. */
interface QuestionPost {
  question: QuestionPrompt;
  chatId: number;
  /**
   * Where this card came from. `turn`: the asking run is this chat's own
   * turn, still holding this sender's queue - a typed line here must be
   * intercepted as the answer or it queues behind the very turn it releases.
   * `push`: the question was raised at another screen and the phone is only
   * watching - an ordinary message in this chat is a new turn, and only a
   * reply to the card itself counts as an answer.
   */
  origin: 'turn' | 'push';
  /**
   * The message the buttons sit under, so they can be rewritten when the
   * question ends. Unset until the send comes back - a tap cannot arrive
   * before that, because the buttons do not exist yet.
   */
  messageId?: number;
  /** When it was drawn here: the newest one is the one a typed reply means. */
  at: number;
}

/**
 * One piece of Markdown as Telegram HTML.
 *
 * The conversion itself lives in `markdown.ts`; what matters here is that it
 * is applied piece by piece. `splitMessage` guarantees every piece carries
 * balanced code fences, so each one converts on its own without the fence
 * state of its neighbours.
 */
function toHtml(piece: string): string {
  return toTelegramHtml(piece);
}

/** What Telegram accepts in one message, counted after escaping. */
const TELEGRAM_LIMIT = 4096;

/**
 * One message's worth of HTML at a time, each piece guaranteed to fit.
 *
 * `splitMessage` counts the text as written, but what goes on the wire is
 * escaped: a line of `&` grows fivefold, and a piece cut at exactly 4096
 * characters then arrives at the API as 20 000 and is refused - which reads,
 * from the phone, as a message that simply never came. So the pieces are
 * measured after conversion and cut again against a smaller budget until
 * they fit. The floor of 400 cannot overflow: the longest escape here is
 * `&quot;` at six characters, so 400 can become at most 2400.
 *
 * Exported for the test that feeds it a body of nothing but `&`.
 */
export function htmlPieces(text: string): string[] {
  let budget = TELEGRAM_LIMIT;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pieces = splitMessage(text, budget);
    const html = pieces.map(toHtml);
    if (html.every((piece) => piece.length <= TELEGRAM_LIMIT)) return html;
    // Re-cut against the worst growth actually seen, not a guess about it.
    const growth = Math.max(...html.map((piece, index) => piece.length / Math.max(1, pieces[index]?.length ?? 1)));
    budget = Math.max(400, Math.floor(TELEGRAM_LIMIT / growth));
  }
  return splitMessage(text, 400).map(toHtml);
}

/**
 * What a streamed message should say once the turn is over.
 *
 * Two texts describe the same turn and neither is the whole truth. The
 * deltas are what the user actually watched being written, thinking out loud
 * between tool calls included. The provider's `done` text is narrower:
 * Claude Code reports its *result*, the closing answer alone, so taking it as
 * the final state - which this used to do - wiped every intermediate step the
 * moment the turn finished.
 *
 * So the streamed text stands, and the final answer is added only when it is
 * not already in it. The comparison ignores whitespace, because the two
 * renderings differ in line breaks far more often than in words.
 *
 * Exported for its own test: this is a one-line decision that costs a visible
 * half of the conversation when it goes the wrong way.
 */
export function mergeFinalText(streamed: string, finalText: string): string {
  const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const final = finalText.trim();
  const shown = streamed.trim();
  if (!final) return shown;
  if (!shown) return final;
  return flat(shown).includes(flat(final)) ? shown : shown + '\n\n' + final;
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

/** One row of a list: no line breaks, and short enough to read on a phone. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** Narrow foreign JSON to an object without claiming anything about its fields. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
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
  /** Albums still being collected, by Telegram's `media_group_id`. */
  const albums = new Map<string, { job: Incoming; timer: NodeJS.Timeout }>();
  /** One running turn per sender, so `/stop` knows what to abort. */
  const turns = new Map<number, AbortController>();
  /** Per chat, so two answers never race each other onto the wire. */
  const outbox = new Map<number, Promise<void>>();
  const idReplies = new Map<number, number>();
  /**
   * The questions standing on this phone, keyed by question *and* chat.
   *
   * One question can be drawn in several chats (push has a recipient list),
   * and one chat can hold more than one at a time (a scheduled turn and a
   * web turn can both stop to ask). So the key is the pair, the entry
   * carries the message the buttons sit under, and an entry exists exactly
   * as long as the question is worth answering from here: it is written when
   * the question is drawn and deleted the moment it is answered, withdrawn
   * or expired.
   */
  const questionPosts = new Map<string, QuestionPost>();

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

  /** What one delivery may be told about itself beyond the text. */
  interface SayOptions {
    /** Quote a message, so an answer reads as an answer to that one. */
    replyTo?: number;
    /**
     * What this message is about. Kept per chat, so a reply to it can find
     * its way back to the right conversation days later.
     */
    origin?: Omit<MessageOrigin, 'at'>;
    /** Land in the chat without making the phone ring. */
    silent?: boolean;
    /** Buttons under the message. Drawn beneath the last piece of a long one. */
    keyboard?: TelegramInlineKeyboard;
  }

  async function deliver(chatId: number, text: string, options: SayOptions = {}): Promise<number[]> {
    const client = api;
    if (!client) throw new Error('The Telegram gateway is not running.');
    const ids: number[] = [];
    // Materialised, because the last piece is the one that carries the
    // buttons and a generator cannot say which one that is.
    const pieces = [...htmlPieces(text)];
    for (const [index, piece] of pieces.entries()) {
      const id = await client.sendMessage(chatId, piece, {
        parseMode: 'HTML',
        disablePreview: true,
        ...(options.silent ? { silent: true } : {}),
        // Only the first piece quotes the original: Telegram would otherwise
        // draw the same quoted block above every part of a long answer.
        ...(ids.length === 0 && options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
        // And only the last one carries the buttons, so they sit at the
        // bottom of the whole message rather than in the middle of it.
        ...(index === pieces.length - 1 && options.keyboard ? { replyMarkup: options.keyboard } : {}),
      });
      if (id !== undefined) ids.push(id);
    }
    if (options.origin) rememberOrigin(context, chatId, ids, options.origin);
    // Everything standing in the chat is written down, because `/clear`
    // deletes by id and Telegram has no "delete everything".
    noteMessages(context, chatId, ids);
    return ids;
  }

  /** Fire-and-forget delivery: used where a failed line must not break a turn. */
  function say(chatId: number, text: string, options: SayOptions = {}): void {
    void chain(chatId, async () => {
      await deliver(chatId, text, options);
    }).catch((error: unknown) => {
      log.warn('Telegram send failed', { chatId, error: errorText(error) });
    });
  }

  /**
   * Put a reaction on the sender's own message.
   *
   * Decoration, and treated as such: a Telegram that refuses the emoji, or
   * an older Bot API that has never heard of reactions, must not cost the
   * answer. Failures are swallowed at debug level and nothing waits for it.
   */
  function react(chatId: number, messageId: number | undefined, emoji?: string): void {
    if (messageId === undefined) return;
    void api?.setMessageReaction(chatId, messageId, emoji).catch((error: unknown) => {
      log.debug('Telegram reaction not accepted', { chatId, error: errorText(error) });
    });
  }

  /* ---------------------------- questions ---------------------------- */

  /**
   * The assistant asking the person something, carried to the phone.
   *
   * A turn that asks is a turn that has stopped, and until now this channel
   * had no way to show that - the question was raised somewhere in core and
   * the phone saw a typing bubble until the question gave up. Two things make
   * it answerable from here: buttons, which are the second and last exception
   * to this channel's "no buttons" rule (see
   * `docs/concepts/telegram-channel.md`), and a plain typed reply, which is
   * what a phone is actually good at.
   *
   * The typed path is the one with the trap in it. A message normally becomes
   * a turn and turns are serialised per sender, so an answer typed while the
   * asking turn is still running would queue up *behind the very turn it
   * would release*, and both would sit there until the question expired. So a
   * message that answers an open question never reaches the queue. A tap has
   * the same property for free: a `callback_query` is not a message and never
   * was queued.
   */
  const postKey = (questionId: string, chatId: number): string => questionId + '@' + String(chatId);

  /** Is somebody being asked something in this chat right now? */
  function openQuestion(chatId: number): QuestionPost | undefined {
    let newest: QuestionPost | undefined;
    for (const post of questionPosts.values()) {
      if (post.chatId !== chatId) continue;
      // Expired questions are cleaned up by the closing event, but a clock
      // that has already passed the deadline is reason enough not to answer
      // into it - core has moved the turn on by then.
      if (post.question.expiresAt > 0 && post.question.expiresAt <= Date.now()) continue;
      if (!newest || post.at > newest.at) newest = post;
    }
    return newest;
  }

  /** Draw the question in one chat, unless it is already standing there. */
  function offerQuestion(chatId: number, question: QuestionPrompt, origin: 'turn' | 'push'): void {
    const key = postKey(question.id, chatId);
    // Claimed before anything is awaited: the turn that asked and the push
    // listener both arrive within the same tick. A Telegram turn claims the
    // post first, so the push that follows a heartbeat later does not
    // overwrite where the card came from.
    if (questionPosts.has(key)) return;
    const post: QuestionPost = { question, chatId, origin, at: Date.now() };
    questionPosts.set(key, post);

    void chain(chatId, async () => {
      const ids = await deliver(chatId, questionText(question), { keyboard: questionKeyboard(question) });
      // The buttons sit under the last piece, so that is the message a
      // closing event has to rewrite.
      post.messageId = ids[ids.length - 1];
    }).catch((error: unknown) => {
      // Undrawn means unanswerable from here: dropping the entry lets a
      // later attempt try again, and keeps a typed reply from being taken
      // as the answer to a question nobody ever saw.
      questionPosts.delete(key);
      log.warn('Telegram question could not be delivered', { chatId, error: errorText(error) });
    });
  }

  /** Rewrite one standing question's buttons to say how it ended. */
  function settlePost(post: QuestionPost, reason: QuestionClosedReason | 'gone', answer?: QuestionAnswer): void {
    const client = api;
    if (!client || post.messageId === undefined) return;
    const keyboard = questionClosedKeyboard(reason, chosenLabels(post.question, answer));
    void client.editMessageReplyMarkup(post.chatId, post.messageId, keyboard).catch((error: unknown) => {
      // A stale keyboard is a cosmetic loss; the answer itself was recorded
      // by the registry long before this ran.
      log.debug('Telegram question buttons could not be redrawn', { error: errorText(error) });
    });
  }

  /**
   * The question is over, wherever that happened. Every chat it was drawn in
   * gets its buttons rewritten - including the ones that did not answer,
   * which is the whole reason the closing event exists.
   */
  function closeQuestion(id: string, reason: QuestionClosedReason, answer?: QuestionAnswer): void {
    for (const [key, post] of questionPosts) {
      if (post.question.id !== id) continue;
      questionPosts.delete(key);
      settlePost(post, reason, answer);
    }
  }

  /**
   * Hand an answer to the registry that is holding the turn. `false` when
   * the registry no longer has that question - answered at another screen, or
   * given up on - which is normal rather than an error.
   *
   * The entry is dropped first, so the closing event that follows finds
   * nothing left to redraw here and this chat is not asked to rewrite the
   * same buttons twice; Telegram answers a second identical edit with a 400.
   */
  function submitAnswer(post: QuestionPost, answer: QuestionAnswer): boolean {
    questionPosts.delete(postKey(post.question.id, post.chatId));
    const taken = context.assistant.questions.answer(post.question.id, answer);
    settlePost(post, taken ? 'answered' : 'gone', taken ? answer : undefined);
    if (taken) {
      log.info('Question answered from Telegram', {
        chat: post.chatId,
        question: post.question.id,
        selected: answer.selected,
        free: answer.text !== undefined,
      });
    }
    return taken;
  }

  /**
   * The single line that says what a long turn is doing.
   *
   * One message, rewritten in place, rather than a column of "still working"
   * notes: on a phone the stack of them *is* the noise. It appears only when
   * the turn has been silent for a while, is rewritten at a distance that
   * stays well clear of Telegram's edit limit, and is taken away entirely
   * once the answer is there - it was scaffolding, and scaffolding comes
   * down.
   */
  function startProgress(chatId: number): {
    show: (line: string) => void;
    clear: () => void;
  } {
    let messageId: number | undefined;
    let shown = '';
    let shownAt = 0;
    let closed = false;

    const show = (line: string): void => {
      const text = line.trim();
      if (closed || !text || text === shown) return;
      const now = Date.now();
      if (messageId !== undefined && now - shownAt < PROGRESS_EDIT_MS) return;
      shown = text;
      shownAt = now;
      void chain(chatId, async () => {
        if (closed) return;
        const client = api;
        if (!client) return;
        if (messageId === undefined) {
          const [id] = await deliver(chatId, text);
          messageId = id;
          return;
        }
        await client.editMessageText(chatId, messageId, toHtml(text), {
          parseMode: 'HTML',
          disablePreview: true,
        });
      }).catch((error: unknown) => {
        log.debug('Telegram progress line failed', { chatId, error: errorText(error) });
      });
    };

    const clear = (): void => {
      closed = true;
      const id = messageId;
      messageId = undefined;
      if (id === undefined) return;
      void chain(chatId, async () => {
        await api?.deleteMessages(chatId, [id]);
      }).catch((error: unknown) => {
        log.debug('Telegram progress line could not be removed', { chatId, error: errorText(error) });
      });
    };

    return { show, clear };
  }

  /**
   * The answer, written as it is produced.
   *
   * Telegram has no streaming. What it has is `editMessageText`, and what
   * this does is rewrite one message on a timer while the deltas come in -
   * which reads, on a phone, exactly like someone typing. The timer is the
   * whole design constraint: edits are rate limited per chat, so the text is
   * flushed at a distance rather than per token, and only when it actually
   * changed.
   *
   * Long answers keep working because the pieces are recomputed from the
   * whole text every flush. `splitMessage` is greedy from the front, so
   * every piece but the last is settled once it exists: earlier messages are
   * left alone, the last one is edited, and a new one is sent when the text
   * grows past it. The `done` event has the last word - whatever the deltas
   * added up to, the final text is what stands.
   */
  function startStream(chatId: number, replyTo?: number): {
    push: (delta: string) => void;
    finish: (finalText: string) => Promise<number[]>;
    started: () => boolean;
  } {
    /** What has been sent so far, by index: message id and the text in it. */
    const ids: number[] = [];
    const texts: string[] = [];
    let text = '';
    let writtenAt = 0;
    let timer: NodeJS.Timeout | undefined;
    let writing = false;
    /** A delta arrived while a write was in flight; write again afterwards. */
    let again = false;
    let closed = false;

    async function write(): Promise<void> {
      const client = api;
      if (!client) return;
      const body = text.trim();
      if (!body) return;
      writtenAt = Date.now();
      const pieces = htmlPieces(body);
      for (let index = 0; index < pieces.length; index += 1) {
        const piece = pieces[index] as string;
        if (index < ids.length) {
          if (texts[index] === piece) continue;
          await client.editMessageText(chatId, ids[index] as number, piece, {
            parseMode: 'HTML',
            disablePreview: true,
          });
          // Noted as written only once it is written. Marking it first would
          // make a refused edit look like a finished one, and the next pass
          // would skip exactly the piece that never arrived.
          texts[index] = piece;
          continue;
        }
        const id = await client.sendMessage(chatId, piece, {
          parseMode: 'HTML',
          disablePreview: true,
          // Only the first message quotes what is being answered.
          ...(ids.length === 0 && replyTo !== undefined ? { replyTo } : {}),
        });
        if (id === undefined) return;
        ids.push(id);
        texts.push(piece);
        noteMessages(context, chatId, [id]);
      }
    }

    /** One writer at a time, in the chat's own order. */
    function run(): void {
      if (writing) {
        // Whatever arrived during this write is not lost: it is written by
        // the pass that follows it.
        again = true;
        return;
      }
      writing = true;
      void chain(chatId, async () => {
        await write();
      })
        .catch((error: unknown) => {
          // A refused edit is not worth the turn: the next pass rewrites the
          // same text anyway, and the answer still arrives.
          log.debug('Telegram stream update failed', { chatId, error: errorText(error) });
        })
        .finally(() => {
          writing = false;
          if (again) {
            again = false;
            arm();
          }
        });
    }

    /**
     * Make sure what has arrived gets written, and soon.
     *
     * The first version of this dropped a delta that arrived inside the
     * throttle window and waited for the next one to carry it - which is
     * fine while text keeps coming and wrong the moment it stops. A model
     * that writes a sentence and then reaches for a tool falls silent for
     * seconds, and the sentence sat there half-written. So the wait is a
     * timer rather than a test: every delta is followed by a write, at the
     * earliest the throttle allows.
     */
    function arm(): void {
      if (timer || closed) return;
      // The first words go out quickly - that is the point of streaming -
      // and everything after them at the slower, rate-limit-safe pace.
      const wait = ids.length === 0 ? STREAM_FIRST_MS : STREAM_EDIT_MS;
      const due = Math.max(0, writtenAt + wait - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        run();
      }, due);
      timer.unref?.();
    }

    return {
      started: () => ids.length > 0,

      push(delta: string): void {
        if (closed) return;
        text += delta;
        arm();
      },

      async finish(finalText: string): Promise<number[]> {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = undefined;

        // The streamed text stands, and the provider's closing answer is
        // added only when it is not already part of it. The reasoning, and
        // the bug it repairs, are with `mergeFinalText`.
        text = mergeFinalText(text, finalText);

        await chain(chatId, async () => {
          await write();
        }).catch((error: unknown) => {
          log.warn('Telegram stream could not be finished', { chatId, error: errorText(error) });
        });
        return ids;
      },
    };
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

  /** The command list as `/help` prints it, out of the one table above. */
  function helpText(): string {
    const rows = COMMANDS.map((entry) => `/${entry.command} – ${entry.description}`);
    return ['What I answer to:', '', ...rows].join('\n');
  }

  /** One organisation, or nothing to report from. */
  function orgId(): string | undefined {
    try {
      return context.assistant.org.activeOrganization().id;
    } catch {
      return undefined;
    }
  }

  /** "in 3 h 20 min", "12 min ago" - a clock reading nobody has to subtract. */
  function relativeTime(at?: number): string {
    if (!at) return '';
    const delta = at - Date.now();
    const minutes = Math.round(Math.abs(delta) / 60_000);
    const text =
      minutes < 60
        ? `${minutes} min`
        : minutes < 60 * 48
          ? `${Math.round(minutes / 60)} h`
          : `${Math.round(minutes / (60 * 24))} d`;
    return delta >= 0 ? `in ${text}` : `${text} ago`;
  }

  /** A list command's body, with the same shape for all four of them. */
  function listText(title: string, rows: string[], empty: string, total = rows.length): string {
    if (rows.length === 0) return empty;
    const shown = rows.slice(0, LIST_LIMIT);
    const rest = total - shown.length;
    return [title, '', ...shown, ...(rest > 0 ? ['', `… and ${rest} more. The web app has the rest.`] : [])].join('\n');
  }

  function tasksText(): string {
    const id = orgId();
    if (!id) return 'No company is configured yet.';
    const open = context.assistant.store.org.listTasks(id, {
      status: ['running', 'planned', 'open', 'failed'],
      limit: 40,
    });
    // Running first, then what is planned, then the rest: the order someone
    // looking at a phone actually wants.
    const rank: Record<string, number> = { running: 0, failed: 1, planned: 2, open: 3 };
    const sorted = [...open].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    const rows = sorted.map((task) => {
      const who = task.assigneeId ? context.assistant.store.org.getAgent(task.assigneeId)?.name : undefined;
      const mark = task.priority === 'high' ? '❗ ' : '';
      return `• ${mark}${oneLine(task.title, 70)} – ${task.status}${who ? `, ${who}` : ''}`;
    });
    // "Unfinished" rather than "open": a failed task is on this list too,
    // and it is the one most worth seeing from a phone.
    return listText(`Board: ${open.length} unfinished`, rows, 'Nothing open on the board.', open.length);
  }

  function mailText(): string {
    const id = orgId();
    if (!id) return 'No company is configured yet.';
    // Read without marking read: this is a glance at the inbox, not the act
    // of reading a mail, and the web inbox must not go quiet because of it.
    const unread = context.assistant.store.org.unreadMailFor(id, { kind: 'user' });
    const rows = unread.map((mail) => {
      const sender =
        mail.fromKind === 'assistant'
          ? context.config.assistantName
          : (mail.fromAgentId ? context.assistant.store.org.getAgent(mail.fromAgentId)?.name : undefined) ??
            mail.fromKind;
      return `• ${sender}: ${oneLine(mail.subject, 70)} (${relativeTime(mail.createdAt)})`;
    });
    return listText(`Inbox: ${unread.length} unread`, rows, 'No unread mail.', unread.length);
  }

  function agentsText(): string {
    const id = orgId();
    if (!id) return 'No company is configured yet.';
    const agents = context.assistant.store.org.listAgents(id);
    const running = context.assistant.store.org.listAssignments(id, { status: ['running'], limit: 50 });
    const busy = new Map<string, number>();
    for (const assignment of running) busy.set(assignment.agentId, (busy.get(assignment.agentId) ?? 0) + 1);
    const rows = agents.map((agent) => {
      const load = busy.get(agent.id);
      return `• ${agent.name} – ${oneLine(agent.title, 50)}${load ? ` (busy: ${load})` : ''}`;
    });
    return listText(`Company: ${agents.length} agents`, rows, 'Nobody works here yet.', agents.length);
  }

  function schedulesText(): string {
    const id = orgId();
    if (!id) return 'No company is configured yet.';
    const jobs = context.assistant.cron.list(id);
    const upcoming = [...jobs].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity));
    const rows = upcoming.map((job) => {
      const when = job.enabled ? (job.nextRunAt ? relativeTime(job.nextRunAt) : 'not scheduled') : 'off';
      const last = job.lastStatus ? `, last ${job.lastStatus}` : '';
      return `• ${oneLine(job.name, 50)} – ${job.schedule}, ${when}${last}`;
    });
    return listText(`Schedules: ${jobs.length}`, rows, 'No schedules are set up.', jobs.length);
  }

  /**
   * Empty the chat and start over.
   *
   * "As if writing the bot for the first time" is the whole point, so this
   * deletes the messages themselves rather than only opening a new
   * conversation.
   *
   * It does not delete only what the gateway happens to remember. That was
   * the first attempt, and it cleared two messages out of a full chat: the
   * ledger starts at the last restart, while the chat goes back as far as it
   * goes. Message ids are a per-chat counter, so the way to reach a message
   * nobody wrote down is to count backwards from the newest one and hand
   * Telegram the whole range - it skips every id that is not there, already
   * gone, or past its 48-hour deletion window. The ledger is still read, for
   * the one thing a range cannot supply: where to start counting when the
   * newest id is unknown.
   *
   * What stays is what Telegram will not part with: anything older than 48
   * hours. The answer says so rather than claiming an empty chat.
   *
   * The conversation itself is kept. It stays in the web app's sidebar with
   * everything that was said in it - the chat is cleared, the memory of it
   * is not.
   */
  async function clearChat(chatId: number, commandMessageId?: number): Promise<void> {
    const client = api;
    const known = takeMessages(context, chatId);
    const newest = Math.max(commandMessageId ?? 0, ...known, 0);

    let swept = 0;
    if (client && newest > 0) {
      // Downwards from the newest, so a flood limit that cuts this short
      // takes what is on screen first.
      for (let top = newest; top > 0 && newest - top < CLEAR_SWEEP; top -= 100) {
        const batch: number[] = [];
        for (let id = top; id > 0 && id > top - 100 && newest - id < CLEAR_SWEEP; id -= 1) batch.push(id);
        if (batch.length === 0) break;
        try {
          await client.deleteMessages(chatId, batch);
          swept += batch.length;
        } catch (error) {
          // A batch Telegram refuses outright - every id in it too old - is
          // not a reason to stop: further down is only older, but further up
          // may still hold something deletable in a chat with gaps.
          log.debug('Telegram delete batch refused', { chatId, error: errorText(error) });
        }
      }
    }

    const session = resolveSession(chatId, true);
    log.info('Telegram chat cleared', { chatId, swept, newest, sessionId: session.id });

    // One line on an empty screen, which is the whole point of the command.
    // The footnote about Telegram's 48 hours is true every time and worth
    // reading once, so it comes with the first clear in a chat and never
    // again - an explanation repeated on every use stops being read and
    // starts being clutter.
    const noticeKey = `telegram:clear-notice:${chatId}`;
    const explained = context.assistant.store.getMeta(noticeKey) !== null;
    if (!explained) context.assistant.store.setMeta(noticeKey, String(Date.now()));

    say(
      chatId,
      explained
        ? '✨ Fresh start.'
        : '✨ Fresh start — the old conversation is kept in the web app.\n' +
            'Telegram lets me delete only the last 48 hours; for anything older: hold the chat → Clear History.',
    );
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
            'Voice messages are transcribed, and photos and documents are read. ' +
            'Reply to one of my notifications and I will answer about that notification, ' +
            'in a conversation of its own, rather than about whatever we last discussed.\n\n' +
            helpText(),
        );
        return true;

      case 'help':
      case 'hilfe':
        say(chatId, helpText());
        return true;

      case 'new':
      case 'neu': {
        const session = resolveSession(chatId, true);
        log.info('Telegram session replaced', { from: userId, sessionId: session.id });
        say(chatId, 'New conversation created. The previous one is preserved.');
        return true;
      }

      case 'clear':
        await clearChat(chatId, verdict.messageId);
        return true;

      case 'tasks':
        say(chatId, tasksText());
        return true;

      case 'mail':
        say(chatId, mailText());
        return true;

      case 'agents':
        say(chatId, agentsText());
        return true;

      case 'schedules':
      case 'cron':
        say(chatId, schedulesText());
        return true;

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
        say(chatId, 'I do not know that one.\n\n' + helpText());
        return true;
    }
  }

  /* --------------------------- attachments --------------------------- */

  /** One message on its way to becoming a turn, files and all. */
  interface Incoming {
    userId: number;
    chatId: number;
    messageId?: number;
    text?: string;
    attachments: GatewayAttachment[];
    replyTo?: GatewayReplyTo;
  }

  /** What came out of taking the files in. */
  interface Intake {
    /** One line per file, written for the turn that is about to read them. */
    lines: string[];
    /** Spoken words, in the order they were sent. */
    transcripts: string[];
    saved: number;
  }

  /** How a file is named in the line the assistant is handed. */
  const KIND_LABEL: Record<GatewayAttachment['kind'], string> = {
    photo: 'A photo',
    voice: 'A voice message',
    audio: 'An audio file',
    video: 'A video',
    video_note: 'A video note',
    animation: 'An animation',
    document: 'A document',
    sticker: 'A sticker',
  };

  /**
   * Whether a turn would end up listening locally, and so might have to wait
   * for a model to be fetched. Read fresh: a key added on the voice page
   * takes effect on the next voice note, not on the next restart.
   */
  function listensLocally(config: TelegramGatewayConfig): boolean {
    if (config.transcribe === 'local') return true;
    if (config.transcribe !== 'auto') return false;
    const keys = voiceKeys(context.config.home);
    return !keys.openai && !keys.elevenlabs;
  }

  /**
   * Fetch, store and, where there is something to hear, transcribe.
   *
   * Every failure here is reported rather than thrown: one unreadable file
   * out of three must not cost the other two, and a photo that could not be
   * downloaded is something the assistant should be able to say out loud
   * instead of answering a question it never saw.
   */
  async function takeIn(job: Incoming, signal: AbortSignal): Promise<Intake> {
    const config = settings();
    const intake: Intake = { lines: [], transcripts: [], saved: 0 };
    const client = api;
    if (!client || job.attachments.length === 0) return intake;

    const maxBytes = Math.min(Math.max(1, config.maxAttachmentMb), 20) * 1024 * 1024;
    let announcedColdStart = false;

    for (const attachment of job.attachments.slice(0, MAX_ATTACHMENTS)) {
      const label = KIND_LABEL[attachment.kind] ?? 'A file';
      try {
        const file = await client.getFile(attachment.fileId, signal);
        if (!file.path) {
          intake.lines.push(`${label} was sent, but Telegram would not hand the file over.`);
          continue;
        }
        const bytes = await client.downloadFile(file.path, { maxBytes, signal });
        const stored = saveAttachment(context.config.workspace, attachment, bytes);
        intake.saved += 1;
        const size = humanSize(stored.bytes);
        const named = attachment.fileName ? ` named “${attachment.fileName}”` : '';

        if (isAudible(attachment) && config.transcribe !== 'off') {
          const length = humanDuration(attachment.duration);
          // The local model is fetched once, and that once takes about a
          // minute on a normal line. Saying so beats a silence that looks
          // like a bot which stopped working.
          if (!announcedColdStart && listensLocally(config) && !localModelReady(config.transcribeModel)) {
            announcedColdStart = true;
            say(job.chatId, 'Listening. The speech model is being downloaded once, which takes a minute.');
          }
          try {
            const result = await transcribe({
              audio: bytes,
              mime: attachment.mime,
              fileName: attachment.fileName,
              engine: config.transcribe,
              model: config.transcribeModel,
              lang: context.config.voice.lang,
              home: context.config.home,
              signal,
            });
            intake.transcripts.push(result.text);
            intake.lines.push(
              `${label}${length ? ` (${length})` : ''}, transcribed by ${result.engine}; the wording may be` +
                ` imperfect. The audio itself is at ${stored.path}.`,
            );
            // Echoed back, because a transcript nobody can check is a
            // misheard sentence the assistant answers with a straight face.
            const echo = result.text.length > TRANSCRIPT_ECHO ? result.text.slice(0, TRANSCRIPT_ECHO) + ' …' : result.text;
            say(job.chatId, '🎤 ' + echo);
            log.info('Telegram voice note transcribed', {
              from: job.userId,
              engine: result.engine,
              ms: result.ms,
              chars: result.text.length,
            });
          } catch (error) {
            const reason = error instanceof SttError ? error.message : errorText(error);
            intake.lines.push(`${label}${length ? ` (${length})` : ''} could not be transcribed: ${reason} The audio is at ${stored.path}.`);
            log.warn('Telegram transcription failed', { from: job.userId, error: reason });
          }
          continue;
        }

        switch (attachment.kind) {
          case 'photo':
          case 'sticker':
            intake.lines.push(
              `${label} (${size}) is at ${stored.path}. Open it with your file-reading tool before you answer; you can see images.`,
            );
            break;
          case 'video':
          case 'video_note':
          case 'animation':
            intake.lines.push(`${label} (${size}) is at ${stored.path}.`);
            break;
          default:
            intake.lines.push(
              `${label}${named} (${size}) is at ${stored.path}. Open it before you answer.`,
            );
        }
      } catch (error) {
        const reason = error instanceof TelegramApiError ? error.message : errorText(error);
        intake.lines.push(`${label} could not be taken in: ${reason}`);
        log.warn('Telegram attachment failed', { from: job.userId, kind: attachment.kind, error: reason });
      }
    }

    if (job.attachments.length > MAX_ATTACHMENTS) {
      intake.lines.push(
        `${job.attachments.length - MAX_ATTACHMENTS} further file(s) in this batch were not taken in.`,
      );
    }
    return intake;
  }

  /**
   * The prompt for a turn that arrived with files, a quoted notification, or
   * both.
   *
   * Everything the assistant did not write itself is introduced as what it
   * is: the user's own words stand as they are, a transcript says that it is
   * a transcript, and a quoted notification is fenced off with a line saying
   * where it ends. None of it is trusted less for that - it is all the
   * owner's own material - but a turn that cannot tell a mail apart from an
   * instruction is a turn that will eventually follow the mail.
   */
  function buildPrompt(job: Incoming, intake: Intake, quoted?: string): string {
    const parts: string[] = [];

    if (quoted) {
      parts.push(
        'The user is replying on Telegram to this notification from Rookery:\n\n' +
          quoted +
          '\n\n--- end of the notification; their reply follows ---',
      );
    }

    if (intake.lines.length > 0) {
      parts.push('Sent from Telegram:\n' + intake.lines.map((line) => '- ' + line).join('\n'));
    }

    for (const transcript of intake.transcripts) {
      parts.push('What they said:\n"' + transcript + '"');
    }

    const written = job.text?.trim();
    if (written) parts.push(intake.transcripts.length > 0 || intake.lines.length > 0 ? 'What they wrote with it:\n' + written : written);

    // A file with nothing said about it is still a request: look at this.
    if (parts.length === 0 || (!written && intake.transcripts.length === 0)) {
      parts.push('They sent this without saying anything. Look at it and say what you make of it.');
    }
    return parts.join('\n\n');
  }

  /* ----------------------------- turns ----------------------------- */

  async function runTurn(job: Incoming): Promise<void> {
    const config = settings();
    const { userId, chatId } = job;

    const turn = new AbortController();
    turns.set(userId, turn);

    const typing = setInterval(() => {
      // Not while the turn is waiting on an answer: a typing bubble over an
      // open question claims the machine is busy when it is the person who
      // is being waited for.
      if (openQuestion(chatId)) return;
      void api?.sendChatAction(chatId, 'typing').catch(() => {});
    }, TYPING_INTERVAL_MS);
    typing.unref?.();
    void api?.sendChatAction(chatId, 'typing').catch(() => {});

    // Seen, and being worked on. A reaction says that without adding a
    // message to a chat the answer is about to land in anyway.
    react(chatId, job.messageId, REACTION.working);

    // Nothing to show yet is the normal state of a long turn; without a sign
    // of life the phone looks broken. One line, rewritten as the turn moves
    // on, and gone once the answer is there.
    const openedAt = Date.now();
    const progress = startProgress(chatId);
    const firstNote = setTimeout(() => progress.show('Working on it …'), FIRST_NOTE_MS);
    firstNote.unref?.();

    let answer = '';
    let failed = false;
    // Set inside the try, so a failure on the way in still runs through the
    // one `finally` that stops the typing bubble and the progress timer.
    let session: Session | undefined;
    let origin: MessageOrigin | undefined;
    let stream: ReturnType<typeof startStream> | undefined;
    try {
      // Files first: downloading and listening is part of the turn, and the
      // typing bubble and the progress note above already cover the wait.
      const intake = await takeIn(job, turn.signal);

      // Where this belongs. A reply to something the bot sent goes back to
      // whatever that message was about; everything else is the running
      // Telegram conversation, exactly as before.
      origin = job.replyTo?.fromBot === true ? findOrigin(context, chatId, job.replyTo.messageId) : undefined;
      const thread = origin
        ? openThread(context, origin, () => resolveSession(chatId))
        : { session: resolveSession(chatId), fresh: false };
      session = thread.session;
      // The notification itself goes in front of the turn only when this
      // conversation has not seen it yet. A thread being continued already
      // holds it in its history, and repeating it every time would push the
      // actual exchange out of the window. A notice that never had a record
      // is the exception: there is nothing to read back, so its own text is
      // all the context there will ever be.
      const quoted = origin
        ? thread.fresh
          ? originContext(context, origin)
          : origin.ref
            ? undefined
            : origin.snippet
        : undefined;

      const prompt = buildPrompt(job, intake, quoted);

      log.info('Telegram message accepted', {
        from: userId,
        sessionId: session.id,
        permission: config.permission,
        attachments: intake.saved,
        spoken: intake.transcripts.length,
        replyingTo: origin?.kind,
        thread: thread.fresh ? 'new' : 'continued',
        text: prompt.slice(0, AUDIT_TEXT),
      });

      // A streamed answer quotes what it answers on its first message, the
      // way a whole one would.
      stream = config.stream
        ? startStream(chatId, origin && job.messageId !== undefined ? job.messageId : undefined)
        : undefined;

      for await (const event of context.assistant.chat({
        text: prompt,
        sessionId: session.id,
        permission: config.permission,
        model: config.model,
        signal: turn.signal,
      })) {
        if (event.type === 'text') {
          if (!stream) continue;
          // The progress line was standing in for an answer that had not
          // started. It has started.
          progress.clear();
          stream.push(event.delta);
        } else if (event.type === 'done') {
          answer = event.text;
        } else if (event.type === 'error') {
          // Never swallowed: an error the user does not see is an answer that
          // simply never arrives.
          failed = true;
          say(chatId, `Error: ${event.message}`);
        } else if (event.type === 'question') {
          // The turn has stopped and is waiting on a person. Whatever the
          // progress line last claimed it was doing, it is not doing that.
          progress.clear();
          // Idempotent: push may put the same question here in the same tick,
          // because it cannot know this turn came from the phone.
          offerQuestion(chatId, event, 'turn');
        } else if (event.type === 'question-closed') {
          closeQuestion(event.id, event.reason, event.answer);
        } else if (event.type === 'status' && Date.now() - openedAt >= FIRST_NOTE_MS) {
          // Only once the turn has been quiet long enough to worry about;
          // the line itself then rewrites at its own pace.
          progress.show(event.detail ? `${event.label} – ${event.detail}` : event.label);
        }
      }
    } catch (error) {
      if (!turn.signal.aborted) {
        failed = true;
        log.error('Telegram turn failed', { from: userId, error: errorText(error) });
        say(chatId, `Error: ${errorText(error)}`);
      }
    } finally {
      clearTimeout(firstNote);
      clearInterval(typing);
      progress.clear();
      if (turns.get(userId) === turn) turns.delete(userId);
    }

    // Whatever was streamed is written out one last time, cancelled turns
    // included: half an answer that stands is better than half an answer
    // that is quietly wound back.
    const streamed = stream ? await stream.finish(answer) : [];

    if (turn.signal.aborted) {
      react(chatId, job.messageId, REACTION.failed);
      say(chatId, 'Cancelled.');
      return;
    }

    react(chatId, job.messageId, failed ? REACTION.failed : REACTION.done);

    // The answer carries its own origin: replying to it comes back to this
    // conversation, whichever one it turned out to be. That is what lets a
    // thread continue days later, and what keeps a reply to an old answer
    // out of today's chat.
    const answered: SayOptions = {
      origin: {
        kind: 'answer',
        ...(session ? { sessionId: session.id } : {}),
        ...(origin?.title ? { title: origin.title } : {}),
      },
      // Quote the message being answered when this turn belongs to a thread
      // of its own, so the phone shows which of the day's notifications it
      // is about. In the plain chat the quoted line would only be noise.
      ...(origin && job.messageId !== undefined ? { replyTo: job.messageId } : {}),
    };

    if (streamed.length > 0) {
      // The answer is already on the screen. What is left is filing it, so
      // that a reply to it finds its way back to this conversation.
      if (answered.origin) rememberOrigin(context, chatId, streamed, answered.origin);
    } else if (answer.trim().length > 0) {
      say(chatId, answer, answered);
    } else {
      say(chatId, 'No answer was returned.', answered);
    }
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

  /**
   * What an allowed sender is told when their own message was refused.
   *
   * Every reason in here is one the guard can only reach *after* the
   * allowlist has said yes, in the sender's own private chat - so the
   * silence that protects the bot from strangers buys nothing here, and
   * costs the owner a message that seems to vanish. Everything else stays
   * silent, `not_private` included: a word in a group chat is exactly what
   * the guard refused to allow.
   */
  const REJECTION_NOTE: Partial<Record<GatewayRejection, string>> = {
    forwarded:
      'Forwarded messages are not accepted - they carry someone else\'s words. Send the text or the file yourself.',
    media_off: 'Attachments are switched off for this gateway. You can turn them on in the gateway settings.',
    unsupported_media: 'Animated and video stickers cannot be read.',
    too_large: 'That file is larger than this gateway accepts.',
    too_long: 'That message is too long. Shorten it, or send it as a file.',
    no_content: 'There was nothing in that message I can work with.',
  };

  /**
   * A tap on one of a question's options.
   *
   * The button is only trusted as far as the entry behind it: the index has
   * to name an option of a question this chat is actually holding open. A
   * question that has since been answered elsewhere, or expired, has no entry
   * any more - and says so, rather than writing into a turn that has long
   * since moved on.
   */
  async function answerFromTap(
    questionId: string,
    option: number,
    chatId: number | undefined,
    acknowledge: (text?: string) => Promise<void>,
  ): Promise<void> {
    const post = chatId === undefined ? undefined : questionPosts.get(postKey(questionId, chatId));
    if (!post) {
      await acknowledge('That question is no longer open.');
      return;
    }
    const chosen = post.question.options[option];
    if (!chosen) {
      await acknowledge('That option is gone.');
      return;
    }

    const taken = submitAnswer(post, { selected: [option], source: 'telegram', at: Date.now() });
    await acknowledge(taken ? '✓ ' + oneLine(chosen.label, 60) : 'That question is no longer open.');
  }

  /**
   * A tapped button: the one gesture on Telegram that means "I have read
   * this", and the only one there can be.
   *
   * The Bot API has no read receipts - a bot never learns that its message
   * was looked at. So being read is not observed here, it is *declared*, by
   * a deliberate tap, and only that tap marks the mail read in the store the
   * web inbox reads from. Anything softer (the push having been delivered, a
   * glance at `/mail`) would empty the unread list without anybody having
   * read a word, which is the failure mode `/mail` already avoids on purpose.
   *
   * No turn is started and no model is called: this is a database write and
   * an acknowledgement, the same weight as the four reading commands.
   */
  async function handleCallback(update: TelegramUpdate): Promise<void> {
    const verdict = classifyCallback(update, settings());
    lastEventAt = Date.now();

    const client = api;
    const { callbackId, chatId, messageId, data } = verdict;

    // Acknowledged even when refused: an unanswered tap spins on the phone
    // for a minute, and a stranger learns nothing from a silent button.
    const acknowledge = async (text?: string): Promise<void> => {
      if (!client || !callbackId) return;
      try {
        await client.answerCallbackQuery(callbackId, text);
      } catch (error) {
        log.debug('Telegram callback could not be acknowledged', { error: errorText(error) });
      }
    };

    if (!verdict.ok) {
      log.warn('Telegram callback rejected', { from: verdict.userId, reason: verdict.reason });
      await acknowledge();
      return;
    }

    // What the tap meant, read back through the one vocabulary in core. The
    // data is never believed because of what it says - the guard above has
    // already proved who pressed it.
    const action = readCallbackData(data);

    if (action.kind === 'mail-read-done') {
      await acknowledge('Already marked as read.');
      return;
    }

    if (action.kind === 'question-done') {
      await acknowledge('That question is already settled.');
      return;
    }

    if (action.kind === 'question') {
      await answerFromTap(action.questionId, action.option, chatId, acknowledge);
      return;
    }

    if (action.kind !== 'mail-read') {
      // A button from an older version of this code, or one we no longer
      // draw. Saying so beats leaving the phone to guess.
      await acknowledge('This button no longer does anything.');
      return;
    }

    const mailId = action.mailId;
    const store = context.assistant.store.org;
    const mail = mailId ? store.getMail(mailId) : null;
    if (!mail) {
      await acknowledge('That mail is gone.');
      return;
    }

    // The user's own recipient rows on this mail, and nobody else's -
    // `markMailReadFor` picks them by kind, so a mail an agent was Cc'd on
    // stays unread for that agent.
    store.markMailReadFor([mail], { kind: 'user' });

    // The web inbox follows the socket, so it has to hear about this. Not on
    // the `mail` event, though: push listens to that one and would send the
    // very mail that was just marked read straight back to the phone.
    context.assistant.emit('changed', { kind: 'mail', id: mail.id });

    log.info('Mail marked read from Telegram', { from: verdict.userId, mail: mail.id });

    await acknowledge('✓ Marked as read.');

    // The button has done its work; what is left in the chat should say so
    // rather than invite a second tap. A failure here costs a stale button,
    // never the read state that was already written.
    if (client && chatId !== undefined && messageId !== undefined) {
      try {
        await client.editMessageReplyMarkup(chatId, messageId, mailReadDone(Date.now()));
      } catch (error) {
        log.debug('Telegram read button could not be redrawn', { error: errorText(error) });
      }
    }
  }

  function handleUpdate(update: TelegramUpdate): void {
    // A tap is not a message and never becomes a turn, so it leaves before
    // `classifyUpdate` - which would only ever call it "not a message".
    if (asRecord(update.callback_query) !== undefined) {
      void handleCallback(update).catch((error: unknown) => {
        log.warn('Telegram callback failed', { error: errorText(error) });
      });
      return;
    }

    const verdict = classifyUpdate(update, settings());
    lastEventAt = Date.now();

    // Noted before anything is decided about it: `/clear` empties the chat,
    // and a message that was refused is standing in it just the same.
    if (verdict.chatId !== undefined && verdict.chatId === verdict.userId) {
      noteMessages(context, verdict.chatId, [verdict.messageId]);
    }

    if (!verdict.ok) {
      log.warn('Telegram update rejected', {
        from: verdict.userId,
        username: usernameOf(update),
        reason: verdict.reason,
        text: verdict.text?.slice(0, REJECT_TEXT),
      });

      // An allowed sender in their own chat hears why. Which is not a leak:
      // they already know the bot answers them.
      const note = verdict.reason ? REJECTION_NOTE[verdict.reason] : undefined;
      if (note && verdict.chatId !== undefined && verdict.chatId === verdict.userId) {
        say(verdict.chatId, note);
        return;
      }

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

    // An accepted verdict always carries the ids, but they are checked
    // rather than asserted - nothing here narrows foreign input by claim.
    const { userId, chatId } = verdict;
    if (userId === undefined || chatId === undefined) return;

    // A question is standing in this chat, so a written message may be its
    // answer and not a new turn.
    //
    // This is the branch the whole typed path depends on. Turns are
    // serialised per sender, and the turn that asked is still holding that
    // queue while it waits - so an answer that went in as a turn would be
    // queued behind the very turn it releases, and the two would deadlock
    // until the question expired. A tap never had this problem: a
    // `callback_query` is not a message and bypasses the queue by nature.
    //
    // But "the turn that asked" is the condition, not "a question exists
    // somewhere". A card the phone only received as a push - the question
    // came from a browser tab - leaves an ordinary message alone: swallowing
    // it would eat the user's next request and hand the blocked turn an
    // answer nobody gave. Such a card is answered by its buttons, or by a
    // reply addressed to the card itself.
    //
    // Only plain text, though. A photo is content in its own right, and
    // "here, look at this" is a new turn even mid-question.
    const candidate = (verdict.text ?? '').trim() && (verdict.attachments ?? []).length === 0 ? openQuestion(chatId) : undefined;
    const asked =
      candidate &&
      (candidate.origin === 'turn' ||
        (verdict.replyTo?.fromBot === true && verdict.replyTo.messageId === candidate.messageId))
        ? candidate
        : undefined;
    if (asked) {
      if (submitAnswer(asked, readTypedAnswer(verdict.text ?? '', asked.question))) {
        // No message back: the reaction says it arrived, and the turn that
        // was waiting is about to say the rest.
        react(chatId, verdict.messageId, REACTION.done);
        return;
      }
      // The question was already over by the time this got here. Then it was
      // never an answer, and it goes on as what it looks like: a message.
    }

    const job: Incoming = {
      userId,
      chatId,
      attachments: verdict.attachments ?? [],
      ...(verdict.text !== undefined ? { text: verdict.text } : {}),
      ...(verdict.messageId !== undefined ? { messageId: verdict.messageId } : {}),
      ...(verdict.replyTo ? { replyTo: verdict.replyTo } : {}),
    };

    // Several pictures sent at once are one message to the person who sent
    // them, and have to be one turn here too.
    if (verdict.mediaGroupId) {
      collectAlbum(verdict.mediaGroupId, job);
      return;
    }

    dispatch(job);
  }

  /** Hand one message to the queue, or say why it is not being taken. */
  function dispatch(job: Incoming): void {
    if (!enqueue(job.userId, () => runTurn(job))) {
      say(
        job.chatId,
        'The queue is full. Please wait until I have answered the previous messages.',
      );
    }
  }

  /**
   * Gather the items of an album, then send them on as one message.
   *
   * The caption sits on whichever item the sender wrote it under - usually
   * the first, but not always - so the first caption seen wins and the rest
   * only add their files. The timer restarts with every item, because
   * Telegram delivers an album across several polls.
   */
  function collectAlbum(groupId: string, job: Incoming): void {
    const pending = albums.get(groupId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.job.attachments.push(...job.attachments);
      if (!pending.job.text && job.text) pending.job.text = job.text;
      if (!pending.job.replyTo && job.replyTo) pending.job.replyTo = job.replyTo;
    }
    const collected = pending?.job ?? job;
    const timer = setTimeout(() => {
      albums.delete(groupId);
      dispatch(collected);
    }, ALBUM_WINDOW_MS);
    timer.unref?.();
    albums.set(groupId, { job: collected, timer });
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

  /** Pending retry after a start that failed for a reason that may pass. */
  let retryTimer: NodeJS.Timeout | undefined;
  let retryDelay = RETRY_START_MS;

  function clearRetry(): void {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    retryDelay = RETRY_START_MS;
  }

  /**
   * Try again later, further apart each time.
   *
   * Only from the transient branch of `start`: a rejected token and a second
   * poller on the same bot are handled by `blocked`, which this must never
   * paper over. The timer is unref'd, so a process with nothing else to do
   * still exits.
   */
  function scheduleRetry(): void {
    if (retryTimer || silenced) return;
    const wait = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (running || blocked) return;
      void start().catch((error: unknown) => {
        log.warn('Telegram gateway retry failed', { error: errorText(error) });
      });
    }, wait);
    retryTimer.unref?.();
  }

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
        clearRetry();
        log.error('Telegram gateway cannot run with these settings', { reason: lastError });
        return;
      }
      // Everything else is weather: a DNS hiccup, a laptop whose network
      // came up a second after the server did, Telegram having a moment.
      // The first version gave up here and stayed down until somebody
      // noticed and restarted - which is how a channel that exists to be
      // reachable ends up silently unreachable for a day. So it tries
      // again, further apart each time, for as long as the config still
      // wants it running.
      lastError = error instanceof TelegramApiError ? error.message : errorText(error);
      log.error('Telegram gateway failed to start', { error: lastError, retryInMs: retryDelay });
      scheduleRetry();
      return;
    }

    // Yesterday's photos are not worth keeping for ever. Best-effort, and
    // never a reason not to start.
    try {
      const removed = pruneInbox(context.config.workspace);
      if (removed > 0) log.info('Telegram inbox swept', { folders: removed });
    } catch (error) {
      log.warn('Telegram inbox could not be swept', { error: errorText(error) });
    }

    // What draws the blue menu button in the app. Best-effort: a bot whose
    // menu is a day out of date still answers every one of its commands.
    void client.setMyCommands(COMMANDS).catch((error: unknown) => {
      log.warn('Telegram command menu could not be published', { error: errorText(error) });
    });

    // What an empty chat shows above the Start button - which is exactly
    // what a chat looks like after `/clear`.
    void client
      .setMyDescription(
        `${context.config.assistantName}, your assistant. Write, send a photo or a document, or ` +
          'record a voice message. Replies to my notifications are answered about that ' +
          'notification. /help lists everything.',
        `${context.config.assistantName} · your assistant, on your own machine`,
      )
      .catch((error: unknown) => {
        log.debug('Telegram description could not be set', { error: errorText(error) });
      });

    api = client;
    activeToken = secret;
    lastError = undefined;
    running = true;
    clearRetry();
    controller = new AbortController();
    log.info('Telegram gateway started', {
      bot: botUsername,
      allowed: config.allowedUserIds.length,
      permission: config.permission,
    });
    loop = poll(client, controller.signal);
  }

  async function stop(): Promise<void> {
    clearRetry();
    controller?.abort();
    for (const turn of turns.values()) turn.abort();
    turns.clear();
    // A half-collected album belongs to a connection that is going away.
    for (const album of albums.values()) clearTimeout(album.timer);
    albums.clear();
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
     *
     * The ids of the messages that went out come back, because a
     * notification is only half sent until replying to it leads somewhere:
     * push hands them straight to the origin registry.
     */
    async send(
      userId: number,
      text: string,
      options: { origin?: Omit<MessageOrigin, 'at'>; silent?: boolean; keyboard?: TelegramInlineKeyboard } = {},
    ): Promise<number[]> {
      let ids: number[] = [];
      await chain(userId, async () => {
        ids = await deliver(userId, text, options);
      });
      return ids;
    },

    /**
     * A question, put where somebody can answer it. The chat id of a private
     * chat is the user id, so there is nothing to look up.
     *
     * Nothing is returned and nothing is awaited: whether this phone answers
     * is the person's business, and the turn waiting on it is held by the
     * registry in core, not by this call.
     */
    ask(userId: number, question: QuestionPrompt): void {
      if (!running) return;
      offerQuestion(userId, question, 'push');
    },

    closeQuestion(id: string, reason: QuestionClosedReason, answer?: QuestionAnswer): void {
      closeQuestion(id, reason, answer);
    },
  };
}
