import type { TelegramGatewayConfig } from '../types.js';

/**
 * The guard in front of the Telegram gateway.
 *
 * A bot is reachable by anyone who knows its name, and a turn from this
 * channel runs with the permission level the config gives it - today `full`.
 * Everything between those two sentences is this file: it decides who may
 * drive the machine from a phone.
 *
 * It is deliberately free of HTTP. The transport in `packages/server` speaks
 * to `api.telegram.org`; what arrives here is the parsed JSON body and
 * nothing else, so the chain below can be tested in `packages/core/test`
 * without a socket, a clock or a timezone.
 *
 * Everything that reaches `classifyUpdate` is foreign input. It is typed
 * `unknown` on purpose: an update is only ever narrowed after it has been
 * checked, never asserted into shape, and an update nobody anticipated can
 * therefore never come out as `ok: true`.
 */

/** Telegram's own ceiling for a single outgoing message. */
const DEFAULT_MESSAGE_LIMIT = 4096;

/**
 * Longest incoming text accepted as a turn. Below Telegram's own limit,
 * because a wall of text pasted from somewhere else is the shape prompt
 * injection arrives in, and a turn with full rights is the wrong place to
 * find out what is in it.
 */
const MAX_TEXT_LENGTH = 4000;

const MINUTES_PER_DAY = 24 * 60;

const FENCE = '```';

/** What is appended to a piece whose code block continues in the next one. */
const CLOSING_FENCE = '\n```';

export type GatewayRejection =
  | 'not_a_message'
  | 'bot_sender'
  | 'not_allowed'
  | 'not_private'
  | 'forwarded'
  | 'no_text'
  | 'too_long';

export interface GatewayVerdict {
  ok: boolean;
  reason?: GatewayRejection;
  userId?: number;
  chatId?: number;
  text?: string;
  /** A leading `/command`, without slash, without `@botname`, lower case. */
  command?: string;
  /** Whatever followed the command, trimmed. */
  args?: string;
}

/** Narrow foreign JSON to an object without claiming anything about its fields. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * Telegram ids are integers that outgrew 32 bits but still fit a double. A
 * string, a fraction, or a number so large that parsing already lost digits
 * is not something we can compare against the allowlist - and what cannot be
 * compared is not let through.
 */
function asId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The allowlist, cleaned. The config is typed, but it comes from a file a
 * person edits, so an entry that is not a usable id is dropped rather than
 * trusted - a `"12345"` in quotes must not become a hole in the guard.
 */
function allowedIds(config: TelegramGatewayConfig): number[] {
  const raw: unknown = config?.allowedUserIds;
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const entry of raw) {
    const id = asId(entry);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Fields that mark a message as carrying text its sender did not write.
 * Bot API 7.0 replaced the `forward_*` family with `forward_origin`, but an
 * older server may still speak the old shape, so both count. `via_bot`
 * belongs here for the same reason: another bot wrote that text.
 */
const FOREIGN_TEXT_FIELDS = [
  'forward_origin',
  'forward_from',
  'forward_from_chat',
  'forward_sender_name',
  'forward_date',
  'is_automatic_forward',
  'via_bot',
];

function carriesForeignText(message: Record<string, unknown>): boolean {
  return FOREIGN_TEXT_FIELDS.some((field) => {
    const value = message[field];
    return value !== undefined && value !== null && value !== false;
  });
}

/**
 * A leading command: slash, name, optionally `@botname`, then the rest.
 * The bot name is parsed and thrown away - in a private chat there is only
 * one bot the message can mean.
 */
const COMMAND_PATTERN = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,32})?(?:\s([\s\S]*))?$/;

/**
 * The guard, in the fixed order. The first no ends it.
 *
 * The caller is expected to have asked Telegram for `allowed_updates:
 * ["message"]`, so edited messages, callback queries and channel posts never
 * arrive; step 2 is what happens when one does anyway.
 *
 * Text, command and arguments are parsed before any check runs and are part
 * of the verdict even when it says no. That is not sloppiness: `/id` is the
 * single exception to discarding rejected updates in silence, and the
 * transport can only spot it if the parsed command survives the rejection.
 */
export function classifyUpdate(update: unknown, config: TelegramGatewayConfig): GatewayVerdict {
  const message = asObject(asObject(update)?.message);
  const from = message ? asObject(message.from) : undefined;
  // 2. No message, no sender, nothing to classify.
  if (!message || !from) return { ok: false, reason: 'not_a_message' };

  const userId = asId(from.id);
  const chat = asObject(message.chat);
  const chatId = chat ? asId(chat.id) : undefined;

  const known: GatewayVerdict = { ok: false };
  if (userId !== undefined) known.userId = userId;
  if (chatId !== undefined) known.chatId = chatId;

  const text = typeof message.text === 'string' ? message.text.trim() : undefined;
  if (text) {
    known.text = text;
    const match = COMMAND_PATTERN.exec(text);
    const name = match?.[1];
    if (name) {
      known.command = name.toLowerCase();
      const args = match?.[2]?.trim();
      if (args) known.args = args;
    }
  }

  const reject = (reason: GatewayRejection): GatewayVerdict => ({ ...known, ok: false, reason });

  // An id we cannot read is an update we cannot classify. Without it step 4
  // has nothing to compare, and guessing is not an option here.
  if (userId === undefined) return reject('not_a_message');

  // 3. No bot-to-bot traffic. A missing flag counts as a bot, the same as a
  // set one - this chain fails closed everywhere.
  if (from.is_bot !== false) return reject('bot_sender');

  // 4. The guard proper: the numeric id, never the username. Usernames are
  // free to change and get handed out again after release, so an allowlist
  // on names would let a stranger inherit the keys. An empty list means
  // nobody, ever; there is no setting that means everyone.
  if (!allowedIds(config).includes(userId)) return reject('not_allowed');

  // 5. Private chats only, and the chat has to be the sender's own. The
  // first half keeps groups, supergroups and channels out even when the bot
  // is dragged into one; the second keeps it from becoming a mouthpiece in
  // somebody else's conversation.
  if (chat?.type !== 'private' || chatId === undefined || chatId !== userId) {
    return reject('not_private');
  }

  // 6. A forwarded message is foreign text in the owner's hand. The
  // allowlist proves who sent the message, never who wrote it - and with
  // full rights, a single tap must not be enough to put somebody else's
  // instructions into a turn.
  if (carriesForeignText(message)) return reject('forwarded');

  // 7. Text only, and bounded. Photos, documents, voice notes and stickers
  // have no text and land here.
  if (!text) return reject('no_text');
  if (text.length > MAX_TEXT_LENGTH) return reject('too_long');

  return { ...known, ok: true };
}

/**
 * Where the next piece ends: at a paragraph break if the window holds one,
 * otherwise at a line break, otherwise hard. Telegram refuses anything over
 * the limit, so the hard cut is the floor rather than a preference.
 */
function cutAt(rest: string, budget: number): number {
  if (rest.length <= budget) return rest.length;
  const window = rest.slice(0, budget);
  const paragraph = window.lastIndexOf('\n\n');
  if (paragraph > 0) return paragraph;
  const line = window.lastIndexOf('\n');
  if (line > 0) return line;
  return budget;
}

/**
 * Run the fence state forward over one piece. `undefined` means no block is
 * open; a string is the info word of the block that is, so the next piece
 * can reopen it as it was.
 */
function scanFences(piece: string, open: string | undefined): string | undefined {
  let state = open;
  for (const line of piece.split('\n')) {
    const marker = line.trimStart();
    if (!marker.startsWith(FENCE)) continue;
    // A language tag is a word. Anything longer is not one, and it must not
    // eat into the budget of every following piece.
    state = state === undefined ? marker.slice(FENCE.length).trim().slice(0, 24) : undefined;
  }
  return state;
}

/**
 * Cut an answer into messages Telegram accepts.
 *
 * A code block is never left cut open: when a block runs past the end of a
 * piece it is closed there and reopened - with its language - at the top of
 * the next one, because half a fence renders as a wall of backticks on the
 * phone. Empty pieces are never returned, and empty text yields an empty
 * array rather than one blank message.
 */
export function splitMessage(text: string, limit = DEFAULT_MESSAGE_LIMIT): string[] {
  if (typeof text !== 'string') return [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_MESSAGE_LIMIT;
  const parts: string[] = [];
  let rest = text.trim();
  let open: string | undefined;

  while (rest.length > 0) {
    const prefix = open === undefined ? '' : `${FENCE}${open}\n`;
    // Math.max keeps a pathological prefix from stalling the loop; a piece
    // one character long still consumes text.
    const budget = Math.max(1, max - prefix.length);
    let take = cutAt(rest, budget);
    let piece = rest.slice(0, take);
    let next = scanFences(piece, open);

    // The closing fence has to fit inside the same message, so a cut that
    // leaves a block open is taken again with room reserved for it.
    if (
      next !== undefined &&
      take < rest.length &&
      prefix.length + piece.length + CLOSING_FENCE.length > max
    ) {
      take = cutAt(rest, Math.max(1, budget - CLOSING_FENCE.length));
      piece = rest.slice(0, take);
      next = scanFences(piece, open);
    }

    const more = take < rest.length;
    const body = piece.replace(/\s+$/, '');
    if (body.length > 0) {
      parts.push(prefix + body + (next !== undefined && more ? CLOSING_FENCE : ''));
    }
    // Only leading newlines go: they are the seam we just cut at. Leading
    // spaces are indentation and belong to the line.
    rest = rest.slice(take).replace(/^\n+/, '');
    open = next;
  }

  return parts;
}

/**
 * Escaping for `parse_mode: 'HTML'`. Ampersand first, or the escapes of the
 * later rounds would be escaped again. HTML rather than MarkdownV2 because
 * this is four characters instead of seventeen, and the seventeen break on
 * every other model answer.
 */
export function escapeHtml(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "22:00" to minutes since midnight. Undefined for anything unreadable. */
function parseClock(value: string): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined;
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/**
 * Is this minute inside the quiet window?
 *
 * Minutes since midnight rather than a `Date`, so the caller owns the
 * timezone and the function can be tested without one. The window wraps
 * midnight when `from` is later than `until`, which is the normal case for
 * a night. It is half open, so a message at exactly `until` goes out.
 *
 * An empty or unreadable bound means no quiet hours at all, and so does a
 * window of zero length: a setting nobody can read must not end up silencing
 * the phone for good.
 */
export function inQuietHours(minutesOfDay: number, from: string, until: string): boolean {
  const start = parseClock(from);
  const end = parseClock(until);
  if (start === undefined || end === undefined || start === end) return false;
  if (typeof minutesOfDay !== 'number' || !Number.isFinite(minutesOfDay)) return false;
  const now = ((Math.floor(minutesOfDay) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * Who gets push, in the order they were configured.
 *
 * The recipient list is cut against the allowlist, never added to it: an id
 * that may not talk to the assistant does not get told what it is doing
 * either, no matter what stands in `recipients`. One list must not become
 * the back door of the other. An empty list falls back to the first allowed
 * id - the owner - so that turning push on is enough to receive it.
 */
export function pushRecipients(config: TelegramGatewayConfig): number[] {
  const allowed = allowedIds(config);
  const [owner] = allowed;
  if (owner === undefined) return [];

  const raw: unknown = config?.push?.recipients;
  const chosen: number[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const id = asId(entry);
      if (id !== undefined && allowed.includes(id) && !chosen.includes(id)) chosen.push(id);
    }
  }
  return chosen.length > 0 ? chosen : [owner];
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 *
 * Whether the poller should be running is a question about the config, the
 * token and one piece of history - is it stopped and blocked, and on which
 * token - not about sockets. It lives here for the same reason the guard
 * does: a decision tree with this many branches is worth testing without a
 * fake Telegram API, and the transport should be left with nothing to get
 * wrong beyond "call the function, do what it says".
 * ------------------------------------------------------------------ */

/**
 * What the transport remembers between one `refresh()` and the next - the
 * three facts a decision needs that are not in the config.
 */
export interface GatewayLifecycleState {
  /** Whether the poller is currently running. */
  running: boolean;
  /** The token the running poller was actually built with. */
  activeToken: string;
  /**
   * Set when a failure that will not pass on its own (401, 409) stopped the
   * channel, to the token that failed. Undefined when nothing is blocking a
   * start.
   */
  blockedToken?: string;
}

/** Whether the channel should be polling at all, config and token combined. */
export function wantsGatewayRunning(
  config: TelegramGatewayConfig,
  token: string,
  silenced: boolean,
): boolean {
  // Boolean(...) at the edge: `config.pairing` is `undefined` on a config
  // that never set it, and `false || undefined` is `undefined`, not `false` -
  // a caller comparing this against `false` deserves an actual boolean.
  return Boolean(
    config.enabled &&
      (allowedIds(config).length > 0 || config.pairing) &&
      token !== '' &&
      !silenced,
  );
}

/**
 * Why `start()` would refuse right now, in words a log line can show - never
 * the token itself. Empty means nothing obviously stops it (the attempt can
 * still fail once it reaches Telegram).
 */
export function missingGatewaySettings(
  config: TelegramGatewayConfig,
  token: string,
  silenced: boolean,
): string[] {
  const missing: string[] = [];
  if (!token) missing.push('gateways.telegram.token');
  if (!config.enabled) missing.push('gateways.telegram.enabled');
  // Pairing mode is the one reason to poll with nobody allowed: every
  // message still fails the guard, and `/id` is the only thing that answers.
  if (allowedIds(config).length === 0 && !config.pairing) {
    missing.push('gateways.telegram.allowedUserIds');
  }
  if (silenced) missing.push('/aus bis zum Neustart');
  return missing;
}

export type GatewayLifecycleAction = 'start' | 'stop' | 'restart' | 'none';

export interface GatewayLifecycleDecision {
  action: GatewayLifecycleAction;
  /**
   * Whether a stored block no longer applies and should be forgotten. True
   * whenever the attempt is not the exact same token failing the exact same
   * way again - which is the one case a fresh try cannot help, so the block
   * survives untouched and `action` comes back `'none'`.
   */
  clearBlock: boolean;
}

/**
 * What `refresh()` should do about a config or token change, decided once so
 * the branches are not re-derived (and re-risked) at every call site.
 *
 * Switching the channel off is treated as a reset - it is the gesture for
 * "try again from scratch", so it clears a block even though nothing about
 * the failure itself has changed. A token swap while running is a different
 * bot, not a setting to shrug off until the next restart, so it restarts
 * rather than idling on the old connection.
 */
export function nextGatewayAction(
  state: GatewayLifecycleState,
  config: TelegramGatewayConfig,
  token: string,
  silenced: boolean,
): GatewayLifecycleDecision {
  if (!wantsGatewayRunning(config, token, silenced)) {
    return { action: state.running ? 'stop' : 'none', clearBlock: true };
  }
  if (state.blockedToken !== undefined && state.blockedToken === token) {
    return { action: 'none', clearBlock: false };
  }
  if (state.running && token !== state.activeToken) {
    return { action: 'restart', clearBlock: true };
  }
  return { action: state.running ? 'none' : 'start', clearBlock: true };
}
