import type { GatewayAttachment, GatewayAttachmentKind, TelegramGatewayConfig } from '../types.js';

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

/** What a config without an explicit ceiling means. */
const DEFAULT_ATTACHMENT_MB = 20;

/** What `getFile` will hand a bot, no matter what the config asks for. */
const TELEGRAM_DOWNLOAD_MB = 20;

const FENCE = '```';

/** What is appended to a piece whose code block continues in the next one. */
const CLOSING_FENCE = '\n```';

export type GatewayRejection =
  | 'not_a_message'
  | 'bot_sender'
  | 'not_allowed'
  | 'not_private'
  | 'forwarded'
  | 'no_content'
  | 'media_off'
  | 'unsupported_media'
  | 'too_large'
  | 'too_long';

/**
 * What the sender was answering, when they used Telegram's reply gesture.
 *
 * `fromBot` is the field that matters. In a private chat the only bot that
 * can have written the quoted message is this one, so a reply to a bot
 * message is a reply to something the assistant itself sent - which is what
 * makes it safe to look the original up and put it back into the turn. A
 * reply to anything else is treated as a plain message with a quote.
 */
export interface GatewayReplyTo {
  messageId: number;
  fromBot: boolean;
  /**
   * The quoted text, but only from a message whose author is known: this
   * bot, or the sender themselves. A quoted forward is somebody else's
   * words and never comes back out of here.
   */
  text?: string;
}

export interface GatewayVerdict {
  ok: boolean;
  reason?: GatewayRejection;
  userId?: number;
  chatId?: number;
  text?: string;
  /** Telegram's id for this message, needed to answer it as a reply. */
  messageId?: number;
  /** A leading `/command`, without slash, without `@botname`, lower case. */
  command?: string;
  /** Whatever followed the command, trimmed. */
  args?: string;
  /** Files hanging off the message, in the order they were found. */
  attachments?: GatewayAttachment[];
  /** Set when the message is one item of an album; all items share it. */
  mediaGroupId?: string;
  /** The message this one answers, when Telegram says it answers one. */
  replyTo?: GatewayReplyTo;
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

/* ------------------------------------------------------------------ *
 * Attachments
 *
 * A message carries at most one file, except for a photo, which arrives as
 * a ladder of sizes, and an album, which arrives as one update per item
 * tied together by `media_group_id`. Everything below narrows foreign JSON
 * the same way the guard does: checked, never asserted, and a shape nobody
 * anticipated yields no attachment rather than a half-built one.
 * ------------------------------------------------------------------ */

/**
 * The fields a message can carry a file in, in the order they are looked
 * for. `photo` is handled separately - it is an array.
 */
const MEDIA_FIELDS: Array<[string, GatewayAttachmentKind]> = [
  ['voice', 'voice'],
  ['audio', 'audio'],
  ['video_note', 'video_note'],
  ['video', 'video'],
  ['animation', 'animation'],
  ['document', 'document'],
  ['sticker', 'sticker'],
];

/** Kinds that carry sound, and are therefore worth handing to a transcriber. */
const AUDIBLE: GatewayAttachmentKind[] = ['voice', 'audio', 'video_note', 'video'];

/** Whether this attachment is one a transcript can be made from. */
export function isAudible(attachment: GatewayAttachment): boolean {
  return AUDIBLE.includes(attachment.kind);
}

/** One Telegram file object, as much of it as is usable. */
function asFile(value: unknown, kind: GatewayAttachmentKind): GatewayAttachment | undefined {
  const file = asObject(value);
  const id = file?.file_id;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  const attachment: GatewayAttachment = { kind, fileId: id };
  if (typeof file?.file_unique_id === 'string') attachment.uniqueId = file.file_unique_id;
  if (typeof file?.mime_type === 'string') attachment.mime = file.mime_type;
  if (typeof file?.file_name === 'string') attachment.fileName = file.file_name;
  if (typeof file?.file_size === 'number' && Number.isFinite(file.file_size)) {
    attachment.size = file.file_size;
  }
  if (typeof file?.duration === 'number' && Number.isFinite(file.duration)) {
    attachment.duration = file.duration;
  }
  return attachment;
}

/**
 * The photo worth having out of the ladder Telegram sends: the biggest one
 * it offers. The small sizes exist for previews, and a preview is exactly
 * what a model cannot read the writing on.
 */
function largestPhoto(value: unknown): GatewayAttachment | undefined {
  if (!Array.isArray(value)) return undefined;
  let best: GatewayAttachment | undefined;
  let bestArea = -1;
  for (const entry of value) {
    const photo = asObject(entry);
    const file = asFile(photo, 'photo');
    if (!file) continue;
    const width = typeof photo?.width === 'number' ? photo.width : 0;
    const height = typeof photo?.height === 'number' ? photo.height : 0;
    const area = width * height || file.size || 0;
    if (area > bestArea) {
      best = file;
      bestArea = area;
    }
  }
  return best;
}

/** Every file on one message, largest photo size only, in a fixed order. */
function attachmentsOf(message: Record<string, unknown>): GatewayAttachment[] {
  const found: GatewayAttachment[] = [];
  const photo = largestPhoto(message.photo);
  if (photo) found.push(photo);
  for (const [field, kind] of MEDIA_FIELDS) {
    const file = asFile(message[field], kind);
    if (file) found.push(file);
  }
  return found;
}

/**
 * Stickers that are not a still image. A `.tgs` is a Lottie animation and a
 * video sticker is a webm loop; neither is something a turn can do anything
 * with, and saving them would only fill the inbox with confetti.
 */
function isMovingSticker(message: Record<string, unknown>): boolean {
  const sticker = asObject(message.sticker);
  return sticker?.is_animated === true || sticker?.is_video === true;
}

/**
 * The message being answered, reduced to what may be used.
 *
 * The quoted text survives only when its author is beyond doubt - this bot
 * or the sender themselves. A quoted forward carries a third party's words,
 * and section 6 of this file exists precisely so those never reach a turn
 * through a single tap.
 */
function replyOf(message: Record<string, unknown>, senderId: number): GatewayReplyTo | undefined {
  const quoted = asObject(message.reply_to_message);
  if (!quoted) return undefined;
  const messageId = asId(quoted.message_id);
  if (messageId === undefined) return undefined;
  const from = asObject(quoted.from);
  const fromBot = from?.is_bot === true;
  const ownWords = asId(from?.id) === senderId && from?.is_bot === false;
  const reply: GatewayReplyTo = { messageId, fromBot };
  const text = typeof quoted.text === 'string' ? quoted.text : typeof quoted.caption === 'string' ? quoted.caption : undefined;
  if (text && (fromBot || ownWords) && !carriesForeignText(quoted)) {
    reply.text = text.trim().slice(0, MAX_TEXT_LENGTH);
  }
  return reply;
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
  const messageId = asId(message.message_id);
  if (messageId !== undefined) known.messageId = messageId;
  if (typeof message.media_group_id === 'string') known.mediaGroupId = message.media_group_id;

  // A caption is the text of a message that carries a file, and the only
  // place the sender can say what they want done with it.
  const written = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : undefined;
  const text = written?.trim() || undefined;
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

  // A reply is the gesture this channel answers notifications with, so what
  // is being replied to is part of the verdict - for accepted messages and
  // for rejected ones alike, since the reason may still be worth logging.
  const replyTo = replyOf(message, userId);
  if (replyTo) known.replyTo = replyTo;

  // 7. Files. A photo, a voice note or a document is content in its own
  // right now, so the length check applies to whatever was written next to
  // it and the emptiness check applies to both together.
  const attachments = attachmentsOf(message);
  if (attachments.length > 0) {
    if (!config?.media) return reject('media_off');
    if (isMovingSticker(message)) return reject('unsupported_media');
    // Telegram itself refuses to hand a bot anything past 20 MB, so a
    // larger ceiling in the config is a promise the API would break; the
    // smaller of the two wins.
    const configured = typeof config?.maxAttachmentMb === 'number' ? config.maxAttachmentMb : DEFAULT_ATTACHMENT_MB;
    const limit = Math.min(Math.max(1, configured), TELEGRAM_DOWNLOAD_MB) * 1024 * 1024;
    if (attachments.some((file) => (file.size ?? 0) > limit)) return reject('too_large');
    known.attachments = attachments;
  }

  // 8. Something has to have been said or sent. A message with neither text
  // nor a usable file - a poll, a contact, a location - lands here.
  if (!text && attachments.length === 0) return reject('no_content');
  if (text && text.length > MAX_TEXT_LENGTH) return reject('too_long');

  return { ...known, ok: true };
}

/**
 * A button under a bot message, tapped.
 *
 * Telegram calls this a `callback_query`, and it is a second door into the
 * assistant: no text, no turn, but an action all the same. So it walks the
 * same guard chain as a message - not a bot, on the allowlist, in the
 * sender's own private chat - and for the same reasons. The steps a tap
 * cannot fail are simply absent: there is no content to be empty, no length
 * to exceed, nothing forwarded.
 *
 * What comes back is deliberately thin. `data` is a string the bot itself
 * put on the button, at most 64 bytes by Telegram's rule, and it is handed
 * back unread: whoever drew the button decides what it means. A tap proves
 * only that somebody on the allowlist pressed something this bot drew.
 */
export interface GatewayCallbackVerdict {
  ok: boolean;
  reason?: GatewayRejection;
  userId?: number;
  chatId?: number;
  /** Telegram's id for this tap, which has to be acknowledged within seconds. */
  callbackId?: string;
  /** The `callback_data` the bot put on the button. */
  data?: string;
  /** The message the button hangs under, so its keyboard can be rewritten. */
  messageId?: number;
}

export function classifyCallback(update: unknown, config: TelegramGatewayConfig): GatewayCallbackVerdict {
  const query = asObject(asObject(update)?.callback_query);
  const from = query ? asObject(query.from) : undefined;
  if (!query || !from) return { ok: false, reason: 'not_a_message' };

  const userId = asId(from.id);
  const message = asObject(query.message);
  const chat = message ? asObject(message.chat) : undefined;
  const chatId = chat ? asId(chat.id) : undefined;

  const known: GatewayCallbackVerdict = { ok: false };
  if (userId !== undefined) known.userId = userId;
  if (chatId !== undefined) known.chatId = chatId;
  // The id is a string at Telegram, and it is kept even for a tap that gets
  // refused: an unanswered button spins on the phone for a minute.
  if (typeof query.id === 'string' && query.id) known.callbackId = query.id;
  if (typeof query.data === 'string') known.data = query.data;
  const messageId = message ? asId(message.message_id) : undefined;
  if (messageId !== undefined) known.messageId = messageId;

  const reject = (reason: GatewayRejection): GatewayCallbackVerdict => ({ ...known, ok: false, reason });

  if (userId === undefined) return reject('not_a_message');
  if (from.is_bot !== false) return reject('bot_sender');
  if (!allowedIds(config).includes(userId)) return reject('not_allowed');
  if (chat?.type !== 'private' || chatId === undefined || chatId !== userId) return reject('not_private');
  // A tap with nothing on it is a button we did not draw, or one whose data
  // Telegram dropped. Either way there is nothing to act on.
  if (!known.data) return reject('no_content');

  return { ...known, ok: true };
}

/* ------------------------- what a button says -------------------------- */

/**
 * The words the bot is allowed to write on a button, and how they read back.
 *
 * `callback_data` is a round trip through Telegram: the bot writes a string
 * on a button, and gets that same string back when it is tapped. It is not
 * evidence of anything - `classifyCallback` above has already proved who
 * pressed it - so this is a vocabulary, not a token: a small closed set of
 * sentences this channel knows how to say, written in one place and read in
 * the same one, because a prefix that is built in one file and parsed in
 * another drifts the first time one of them is edited.
 *
 * Telegram allows 64 bytes. `question:<uuid>:<index>` is 48 of them, and a
 * mail id is the same shape, so both fit with room left - but the budget is
 * why ids go on a button and never a label.
 */
const MAIL_READ = 'mail:read:';
const MAIL_READ_DONE = 'mail:read-done';
const QUESTION = 'question:';
const QUESTION_DONE = 'question:done';

/** What a tap turned out to mean. */
export type GatewayCallbackAction =
  /** Mark this mail as read - the read receipt the Bot API does not have. */
  | { kind: 'mail-read'; mailId: string }
  /** A tap on a read button that has already been spent. */
  | { kind: 'mail-read-done' }
  /** Answer the open question with the option at this index. */
  | { kind: 'question'; questionId: string; option: number }
  /** A tap on a question that has already been answered, or has expired. */
  | { kind: 'question-done' }
  /** A button from an older version of this code, or one we never drew. */
  | { kind: 'unknown' };

/** The data under one option of a question. */
export function questionCallbackData(questionId: string, option: number): string {
  return QUESTION + questionId + ':' + String(option);
}

/** The data under a question that is over, whichever way it ended. */
export function questionDoneCallbackData(): string {
  return QUESTION_DONE;
}

/** The data under a fresh mail's read button. */
export function mailReadCallbackData(mailId: string): string {
  return MAIL_READ + mailId;
}

/** The data under a read button that has been pressed. */
export function mailReadDoneCallbackData(): string {
  return MAIL_READ_DONE;
}

/**
 * Read a tap back.
 *
 * Anything unrecognised comes back as `unknown` rather than being guessed
 * at: a button whose meaning is no longer known must say so on the phone,
 * not do the nearest thing it can think of.
 */
export function readCallbackData(data: string | undefined): GatewayCallbackAction {
  if (!data) return { kind: 'unknown' };
  if (data === MAIL_READ_DONE) return { kind: 'mail-read-done' };
  if (data === QUESTION_DONE) return { kind: 'question-done' };

  if (data.startsWith(MAIL_READ)) {
    const mailId = data.slice(MAIL_READ.length);
    return mailId ? { kind: 'mail-read', mailId } : { kind: 'unknown' };
  }

  if (data.startsWith(QUESTION)) {
    const rest = data.slice(QUESTION.length);
    // The index is the tail, so an id carrying a colon of its own still
    // comes back whole.
    const cut = rest.lastIndexOf(':');
    if (cut <= 0) return { kind: 'unknown' };
    const questionId = rest.slice(0, cut);
    const option = Number(rest.slice(cut + 1));
    if (!Number.isInteger(option) || option < 0) return { kind: 'unknown' };
    return { kind: 'question', questionId, option };
  }

  return { kind: 'unknown' };
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
  if (silenced) missing.push('/off until restart');
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
