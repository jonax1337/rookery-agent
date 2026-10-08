import { inQuietHours, notificationPushAllowed, pushRecipients, splitMessage } from '@rookery/core';
import type { AgentEvent, MemoryLearnedEvent, Notification, NotifyEvent, TelegramPushConfig } from '@rookery/core';
import type { ServerContext } from '../context.js';
import type { MessageOrigin } from './threads.js';
import { notificationReadKeyboard, type GatewayHandle } from './telegram.js';
import type { TelegramInlineKeyboard } from './telegram-api.js';

/**
 * The assistant's own initiative, and the state changes worth interrupting a
 * phone for, turned into English push messages.
 *
 * There are two lanes, and the difference between them is the whole design.
 *
 * The first is for things that *finish* while nobody is watching: an agent's
 * assignment, a schedule, a night's sleep, a failed task, a notification, whatever
 * `notify` decides to say. Each is worth interrupting a phone for, so each is
 * rate limited, held back during quiet hours, and folded into a digest when
 * several pile up.
 *
 * The second is the running commentary - what the web app shows as toasts,
 * and, switched on separately, every tool the assistant reaches for. Those
 * fire on every turn, so the first lane's rules would be exactly wrong for
 * them: they are batched into one message every few seconds, dropped rather
 * than buffered in quiet hours, and counted against a ceiling of their own so
 * a busy afternoon cannot use up the budget that exists so a notification gets
 * through. Both are off by default; on, they turn the phone into something
 * closer to a screen you can watch.
 *
 * Notifications are the channel the defaults lean on: a schedule's result,
 * a card of the user's that ended, an agent's question, what the board
 * watcher or an agent reports. They are stored for the web inbox either way;
 * which kinds also buzz the phone is `push.schedules`, `push.tasks`,
 * `push.sleep` and `push.agents` (leads, all, off). A task's question always
 * goes out, at once, because a card waits on it.
 *
 * A question the assistant stopped to ask belongs to that same first lane and
 * is the one item in it that cannot be held back: it expires, so it is sent
 * now or not at all. It is carried here rather than only on the turn that
 * asked, because the turn may be a web turn, a schedule, or anything else
 * nobody is sitting in front of - which is exactly when the phone is the only
 * place the question can still be answered.
 *
 * Everything composed here is plain text. The gateway's `send` is the single
 * place where text becomes Telegram HTML, and it escapes what it is given -
 * a line that arrived already escaped, or already carrying a tag, would reach
 * the phone as visible `&amp;` and `<b>`.
 */

/** One thing worth telling the phone about, queued or sent as it happens. */
interface PushItem {
  /** Dedupe key: the same id within 10s is the same event told twice. */
  id: string;
  kind: 'assignment' | 'cron' | 'sleep' | 'task' | 'notification' | 'notify';
  /** `notify` with urgency `high`, or a question - quiet hours do not hold these back. */
  urgent: boolean;
  /**
   * Sent now or not at all: neither held back nor counted against the hourly
   * cap. Only a task's question - it waits on the person, and a question
   * delivered from a buffer is a card that sat still for nothing.
   */
  immediate?: boolean;
  /** Full text, used as-is when this item is sent alone. */
  message: string;
  /** Which counting bucket this item falls into inside a batched digest. */
  tallyKey: string;
  /**
   * What this notification is about, handed to the gateway so a reply to it
   * can be answered about *it* rather than about whatever conversation
   * happened to be open. Without this, the phone has one thread for
   * everything - which is exactly the confusion this field removes.
   */
  origin: Omit<MessageOrigin, 'at'>;
  /**
   * Buttons under the message. Only a notification carries one, and only because
   * Telegram gives a bot no way to learn that a message was read: the tap is
   * the read receipt the API does not have.
   */
  keyboard?: TelegramInlineKeyboard;
}

/** How a `tallyKey` reads in a digest, singular and plural. */
const TALLY_LABELS: Record<string, { one: string; many: string }> = {
  'assignment:done': { one: 'assignment completed', many: 'assignments completed' },
  'assignment:failed': { one: 'assignment failed', many: 'assignments failed' },
  'assignment:cancelled': { one: 'assignment cancelled', many: 'assignments cancelled' },
  'cron:done': { one: 'schedule completed', many: 'schedules completed' },
  'cron:failed': { one: 'schedule failed', many: 'schedules failed' },
  'sleep:done': { one: 'sleep run completed', many: 'sleep runs completed' },
  'sleep:failed': { one: 'sleep run failed', many: 'sleep runs failed' },
  'task:failed': { one: 'task failed', many: 'tasks failed' },
  'notification:schedule': { one: 'schedule result', many: 'schedule results' },
  'notification:watch': { one: 'board report', many: 'board reports' },
  'notification:task': { one: 'task update', many: 'task updates' },
  'notification:agent': { one: 'message from an agent', many: 'messages from agents' },
  'notification:sleep': { one: 'sleep note', many: 'sleep notes' },
  'notification:question': { one: 'question', many: 'questions' },
  'notify:normal': { one: 'notice', many: 'notices' },
};

/**
 * How much of a notification body the phone carries.
 *
 * Not a transport limit: Telegram takes 4096 characters per message and
 * `splitMessage` cuts anything longer into several, so a notification arrives whole
 * unless something here shortens it first. 600 was that something, and it
 * beheaded every message worth reading. What is left is a politeness cap - four
 * messages is a long read on a phone, and past that the web inbox is the
 * better place, which the marker says out loud rather than trailing off.
 */
const BODY_LIMIT = 12_000;
const CLIPPED_NOTE = '\n\n[…] The rest of this notification is in your inbox.';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The activity feed's own shape: how long lines are collected before they go
 * out together, how many fit in one message, and how many messages an hour
 * the lane may spend before it goes quiet on its own.
 *
 * Three seconds is long enough that a turn's burst of tool calls arrives as
 * one message and short enough to still read as live. Forty an hour is a
 * ceiling nobody reaches by working - only by looping.
 */
const FEED_WINDOW_MS = 3000;
const FEED_MAX_LINES = 10;
const FEED_MAX_PER_HOUR = 40;
/** How many memories one turn lists by name before the rest are only counted. */
const MEMORIES_LISTED_PER_TURN = 3;
/** How often the buffer gets a chance to drain once quiet hours or the rate cap let go. */
const FLUSH_CHECK_MS = 60_000;

/** The same event id inside this window is the same event told twice. */
const DEDUPE_WINDOW_MS = 10_000;

/** How many of the newest notifications of a kind are searched for "already told". */
const RECENT_NOTIFICATIONS_CHECKED = 25;

/** A failed task's own notification is written within the tick; this is how recent counts as that one. */
const TASK_NOTIFICATION_LOOKBACK_MS = 60_000;

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/** A notification body as the phone gets it: whole, or honestly cut off. */
function notificationBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > BODY_LIMIT
    ? trimmed.slice(0, BODY_LIMIT).replace(/\s+\S*$/, '') + CLIPPED_NOTE
    : trimmed;
}

/** Title, a blank line, the body - or the title alone when there is no body. */
function withBody(head: string, body: string): string {
  const text = notificationBody(body);
  return text ? head + '\n\n' + text : head;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? minutes + ' min ' + seconds + ' sec' : seconds + ' sec';
}

/** The message of any thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A Telegram 403 reads differently depending on which layer surfaces it. */
function isForbidden(error: unknown): boolean {
  const status = (error as { status?: number; statusCode?: number } | undefined)?.status
    ?? (error as { statusCode?: number } | undefined)?.statusCode;
  if (status === 403) return true;
  const message = errorMessage(error);
  return /\b403\b/.test(message) || /forbidden/i.test(message);
}

/** Forget the timestamps that have left the hour-long window; they are stored oldest first. */
function dropOlderThanAnHour(timestamps: number[]): void {
  const cutoff = Date.now() - HOUR_MS;
  for (let oldest = timestamps[0]; oldest !== undefined && oldest < cutoff; oldest = timestamps[0]) timestamps.shift();
}

/** The keyboard option for `sendNow`, present only when the item carries one. */
function keyboardOption(item: PushItem): { keyboard?: TelegramInlineKeyboard } {
  return item.keyboard ? { keyboard: item.keyboard } : {};
}

/** What an attachment hands back: how to stop it, and whether it could send. */
export interface GatewayPush {
  /** Unsubscribe from every event and stop the flush ticker. */
  detach: () => void;
  /**
   * Whether a message handed over now would actually reach somebody. The
   * `notify` tool asks this before telling the assistant it was sent: the
   * listener is attached from server start onwards, so being attached proves
   * nothing about the channel being on, configured or unblocked.
   */
  canDeliver: () => boolean;
}

/**
 * Attach push delivery to one running gateway. Returns the unsubscribe
 * function; call it once, on server shutdown or when the gateway is torn
 * down, or the assistant's emitter keeps a listener for a channel nobody
 * reads from any more.
 */
export function attachGatewayPush(context: ServerContext, gateway: GatewayHandle): GatewayPush {
  const assistant = context.assistant;

  // Buffered items: anything caught by quiet hours or the hourly cap waits
  // here instead of being dropped. `sentAt` is the sliding window the cap is
  // measured against; one entry per message (or digest) actually delivered.
  const buffer: PushItem[] = [];
  const sentAt: number[] = [];
  const recentIds = new Map<string, number>();
  // Recipients a 403 has already told us are gone; skipped, not retried, for
  // the rest of this attachment's lifetime.
  const disabled = new Set<number>();

  const pushConfig = (): TelegramPushConfig => context.config.gateways.telegram.push;

  const isQuietNow = (): boolean => {
    const config = pushConfig();
    const now = new Date();
    return inQuietHours(now.getHours() * 60 + now.getMinutes(), config.quietFrom, config.quietUntil);
  };

  const isRateLimited = (): boolean => {
    dropOlderThanAnHour(sentAt);
    const max = pushConfig().maxPerHour;
    return max > 0 && sentAt.length >= max;
  };

  /** A recipient that blocked the bot is skipped from now on; any other failure is only logged. */
  function onSendFailed(userId: number, error: unknown): void {
    if (!isForbidden(error)) {
      context.log.warn('Telegram push failed', { userId, error: errorMessage(error) });
      return;
    }
    disabled.add(userId);
    context.log.warn('Telegram push disabled: recipient blocked the bot (403)', { userId });
  }

  /** One call per message, in order - Telegram has no batch send. Stops at the first failure. */
  async function sendParts(
    userId: number,
    parts: string[],
    origin: Omit<MessageOrigin, 'at'>,
    options: { silent?: boolean; keyboard?: TelegramInlineKeyboard },
  ): Promise<void> {
    for (const [index, part] of parts.entries()) {
      try {
        // The gateway files each message under this origin as it goes.
        await gateway.send(userId, part, {
          origin,
          ...(options.silent ? { silent: true } : {}),
          // The buttons go under the final part only: a notification long enough
          // to be split would otherwise offer "read" halfway through it.
          ...(index === parts.length - 1 && options.keyboard ? { keyboard: options.keyboard } : {}),
        });
      } catch (error) {
        onSendFailed(userId, error);
        return;
      }
    }
  }

  async function sendNow(
    text: string,
    origin: Omit<MessageOrigin, 'at'>,
    options: { counted?: boolean; silent?: boolean; keyboard?: TelegramInlineKeyboard } = {},
  ): Promise<void> {
    const recipients = pushRecipients(context.config.gateways.telegram).filter((id) => !disabled.has(id));
    if (recipients.length === 0) return;
    // The commentary has a budget of its own and must not eat the one that
    // decides whether a notification gets through.
    if (options.counted !== false) sentAt.push(Date.now());
    const parts = splitMessage(text);
    for (const userId of recipients) await sendParts(userId, parts, origin, options);
  }

  function buildDigest(items: PushItem[]): string {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.tallyKey, (counts.get(item.tallyKey) ?? 0) + 1);
    const parts: string[] = [];
    for (const [key, count] of counts) {
      const label = TALLY_LABELS[key];
      parts.push(label ? count + ' ' + (count === 1 ? label.one : label.many) : String(count) + '×' + key);
    }
    return '🌙 Summary: ' + parts.join(', ') + '.';
  }

  /** Send whatever is waiting, if quiet hours and the rate cap both allow it. */
  function attemptFlush(): void {
    if (buffer.length === 0 || isQuietNow() || isRateLimited()) return;
    const items = buffer.splice(0, buffer.length);
    // A lone buffered item keeps its own text; a digest is only for several
    // at once, which is the case the summary format ("3 completed, 1
    // failed") exists for.
    const single = items.length === 1 ? items[0] : undefined;
    if (single) {
      void sendNow(single.message, single.origin, keyboardOption(single));
      return;
    }
    // A digest is several subjects in one message, so it has no record of
    // its own to reply to. Its own text becomes the context instead, which
    // is enough for "what was the failed one?" to be answerable.
    const digest = buildDigest(items);
    void sendNow(digest, { kind: 'digest', snippet: digest, title: 'Summary' });
  }

  const ticker = setInterval(attemptFlush, FLUSH_CHECK_MS);
  ticker.unref?.();

  function perKindEnabled(kind: PushItem['kind']): boolean {
    const config = pushConfig();
    switch (kind) {
      case 'assignment':
        return config.assignments;
      case 'cron':
        return config.cron;
      case 'sleep':
        return config.sleep;
      case 'task':
        return config.tasks;
      case 'notification':
        // Filtered per kind before it gets here (`notificationPushAllowed`).
        return true;
      case 'notify':
        // No dedicated switch for the assistant's own notices - the master
        // `enabled` below is the only gate, same as the config shape defines it.
        return true;
    }
  }

  function dispatch(item: PushItem): void {
    if (!pushConfig().enabled || !perKindEnabled(item.kind)) return;
    if (!fresh(item.id)) return;

    // Give a backlog a chance to drain before deciding where this new item goes.
    attemptFlush();

    if (item.immediate) {
      void sendNow(item.message, item.origin, { counted: false, ...keyboardOption(item) });
      return;
    }

    const quiet = !item.urgent && isQuietNow();
    if (quiet || isRateLimited()) {
      buffer.push(item);
      return;
    }
    void sendNow(item.message, item.origin, keyboardOption(item));
  }

  /* ------------------------------- the feed ------------------------------- */

  /**
   * The running commentary: what the web app shows as toasts, and - when it
   * is switched on - every tool the assistant reaches for.
   *
   * A lane of its own, deliberately, because everything the digest machinery
   * above does is wrong for this kind of line. A tool call is worth seeing
   * while it happens and worthless twenty minutes later, so these are never
   * buffered: in quiet hours they are dropped, not delivered at breakfast.
   * They are not counted against the hourly cap either, or a busy turn would
   * use up the budget that exists so a notification gets through. What keeps them
   * from flooding the phone instead is shape: lines are collected for a few
   * seconds and sent as one message, and the lane has its own ceiling per
   * hour after which it goes quiet on its own.
   */
  const feed: string[] = [];
  const feedSentAt: number[] = [];
  let feedTimer: NodeJS.Timeout | undefined;
  let feedMuted = false;

  function feedHasRoom(): boolean {
    dropOlderThanAnHour(feedSentAt);
    return feedSentAt.length < FEED_MAX_PER_HOUR;
  }

  function flushFeed(): void {
    if (feedTimer) clearTimeout(feedTimer);
    feedTimer = undefined;
    const lines = feed.splice(0, FEED_MAX_LINES);
    const dropped = feed.length;
    feed.length = 0;
    if (lines.length === 0) return;
    if (!feedHasRoom()) {
      // Said once per hour, not once per line: a flood that also floods the
      // warning about the flood is the worst of both.
      if (!feedMuted) {
        feedMuted = true;
        context.log.warn('Telegram activity feed muted for this hour', { cap: FEED_MAX_PER_HOUR });
      }
      return;
    }
    feedMuted = false;
    feedSentAt.push(Date.now());
    const text = lines.join('\n') + (dropped > 0 ? `\n… and ${dropped} more` : '');
    // Silently: commentary belongs in the chat, not on the lock screen.
    void sendNow(text, { kind: 'notify', snippet: text, title: 'Activity' }, { counted: false, silent: true });
  }

  function note(line: string): void {
    if (!pushConfig().enabled || isQuietNow()) return;
    feed.push(line);
    if (feed.length >= FEED_MAX_LINES) {
      flushFeed();
      return;
    }
    if (!feedTimer) {
      feedTimer = setTimeout(flushFeed, FEED_WINDOW_MS);
      feedTimer.unref?.();
    }
  }

  /**
   * Seen this id a moment ago? Records get saved twice more often than you think.
   * Remembers an id only for the dedupe window, so the map holds the last few
   * seconds of events and not every event since the server started.
   */
  function fresh(key: string): boolean {
    const now = Date.now();
    // Insertion order is time order, so the first recent entry ends the sweep.
    for (const [id, at] of recentIds) {
      if (now - at < DEDUPE_WINDOW_MS) break;
      recentIds.delete(id);
    }
    if (recentIds.has(key)) return false;
    recentIds.set(key, now);
    return true;
  }

  /**
   * One tool call in one line: what it was, and the one detail that says
   * which one. `Read · package.json` rather than a paragraph of arguments -
   * this is a feed to glance at, and the transcript is in the web app.
   */
  const onToolCall = (event: AgentEvent): void => {
    if (event.type !== 'tool' || !pushConfig().tools) return;
    // Only the start. Reporting the end as well would double every line and
    // say nothing the first one did not.
    if (event.status !== 'start') return;
    const detail = event.detail ? ' · ' + oneLine(event.detail, 70) : '';
    note('🔧 ' + oneLine(event.name, 40) + detail);
  };

  /** What the turn learned, as the memory page would put it. */
  const onMemoryLearned = (event: MemoryLearnedEvent): void => {
    if (!pushConfig().activity) return;
    const stored = event.stored ?? [];
    for (const record of stored.slice(0, MEMORIES_LISTED_PER_TURN)) {
      if (!fresh('memory:' + record.id)) continue;
      note('🧠 ' + oneLine(record.content, 120));
    }
    if (stored.length > MEMORIES_LISTED_PER_TURN) {
      note(`🧠 … and ${stored.length - MEMORIES_LISTED_PER_TURN} more memories`);
    }
  };

  /**
   * A record was written. The id alone means nothing to a person, so each
   * kind is resolved to its name and anything that cannot be resolved is
   * left out rather than reported as a uuid.
   */
  function describeChange(change: { kind: string; id: string }): string | undefined {
    const org = assistant.store.org;
    switch (change.kind) {
      case 'skill':
        // The id *is* the name for a skill, which is why this one reads well.
        return '📝 Skill saved · ' + oneLine(change.id, 60);
      case 'memory': {
        const record = assistant.store.getMemory(change.id);
        return record ? '🧠 ' + oneLine(record.content, 120) : undefined;
      }
      case 'agent': {
        const agent = org.getAgent(change.id);
        return agent ? '👤 Agent saved · ' + oneLine(agent.name, 60) : undefined;
      }
      case 'project': {
        const project = org.getProject(change.id);
        return project ? '📁 Project saved · ' + oneLine(project.name, 60) : undefined;
      }
      case 'team': {
        const orgId = activeOrgId();
        const team = orgId ? org.listTeams(orgId).find((entry) => entry.id === change.id) : undefined;
        return team ? '👥 Team saved · ' + oneLine(team.name, 60) : undefined;
      }
      case 'tools':
        return '🧰 Tool server changed · ' + oneLine(change.id, 60);
      default:
        // Everything else - a task, a notification, an assignment - has a proper
        // notification of its own above. This lane is for what does not.
        return undefined;
    }
  }

  const onChanged = (change: { kind: string; id: string }): void => {
    if (!pushConfig().activity || !change?.id) return;
    const line = describeChange(change);
    if (line && fresh('changed:' + change.kind + ':' + change.id)) note(line);
  };

  /** The active organisation's id, or nothing to look records up in. */
  function activeOrgId(): string | undefined {
    try {
      return assistant.org.activeOrganization().id;
    } catch {
      return undefined;
    }
  }

  const onAssignment = (event: AgentEvent): void => {
    if (event.type !== 'assignment') return;
    const view = event.assignment;
    if (view.status !== 'done' && view.status !== 'failed' && view.status !== 'cancelled') return;

    const label = view.status === 'done' ? 'completed' : view.status === 'failed' ? 'failed' : 'cancelled';
    const duration = formatDuration(view.durationMs);
    const header = '🤖 ' + view.agentName + ' – ' + label + (duration ? ' (' + duration + ')' : '');
    const taskLine = oneLine(view.task);
    // The event itself only carries a short preview; the full text a person
    // would actually want lives on the stored record.
    const body =
      view.status === 'done'
        ? assistant.store.org.getAssignment(view.id)?.result
        : view.status === 'failed'
          ? view.error
          : undefined;
    const bodyLine = body ? '\n\n' + clip(body, 600) : '';

    dispatch({
      id: 'assignment:' + view.id,
      kind: 'assignment',
      urgent: false,
      message: header + '\n' + taskLine + bodyLine,
      tallyKey: 'assignment:' + view.status,
      origin: { kind: 'assignment', ref: view.id, title: oneLine(view.task, 60) },
    });
  };

  const onCron = (event: AgentEvent): void => {
    if (event.type !== 'cron') return;
    if (event.job.kind === 'script' && event.run?.status === 'done' && !event.run.result?.trim()) return;
    if (event.deleted || !event.run || event.run.status === 'running') return;
    // A `sleep`-kind schedule also fires its own `sleep` event with the real
    // report; reporting the bare cron run too would say the same thing twice.
    if (event.job.kind === 'sleep') return;
    // The run's outcome is a `schedule` notification (written before this
    // event fires) with the result in it, and that notification is the
    // delivery. This line exists only for runs that have none - a silent
    // run, when `push.cron` asks to hear about every run anyway.
    if (hasNotification('schedule', (entry) => entry.cronRunId === event.run?.id)) return;

    const label = event.run.status === 'done' ? 'completed' : 'failed';
    const duration = formatDuration(event.run.durationMs);
    const message =
      '⏰ Schedule “' + event.job.name + '” ' + label + (duration ? ' (' + duration + ')' : '') + '.';

    // The conversation the run happened in, or else the one its job lives in.
    const sessionId = event.run.sessionId ?? event.job.sessionId;

    dispatch({
      id: 'cron:' + event.run.id,
      kind: 'cron',
      urgent: false,
      message,
      tallyKey: 'cron:' + event.run.status,
      // The run points at its job, and at the conversation the job runs in:
      // answering the daily schedule continues that very conversation
      // instead of starting a stranger next to it.
      origin: {
        kind: 'cron',
        ref: event.run.id,
        parent: event.job.id,
        title: event.job.name,
        ...(sessionId ? { sessionId } : {}),
        ...(event.run.result?.trim() ? { snippet: event.run.result } : {}),
      },
    });
  };

  const onSleep = (event: AgentEvent): void => {
    if (event.type !== 'sleep') return;
    if (event.run.status === 'running') return;

    const label = event.run.status === 'done' ? 'completed' : 'failed';
    // The report field is the same two or three sentences the memory page
    // shows for this run - reused rather than summarised again here.
    const body = event.run.status === 'done' ? event.run.report ?? 'The run is complete.' : event.run.error ?? 'unknown error';
    const message = '🌙 Sleep ' + label + '\n\n' + body;

    dispatch({
      id: 'sleep:' + event.run.id,
      kind: 'sleep',
      urgent: false,
      message,
      tallyKey: 'sleep:' + event.run.status,
      origin: {
        kind: 'sleep',
        ref: event.run.id,
        title: new Date(event.run.startedAt).toLocaleDateString('en-GB'),
        snippet: body,
      },
    });
  };

  const onTask = (event: AgentEvent): void => {
    if (event.type !== 'task') return;
    // `failed`, not `blocked`: the board has no blocked state, and a task
    // that ran and did not make it is the one change on it worth a buzz.
    // Everything else about a task is visible the next time the page is open.
    if (event.task.status !== 'failed') return;
    const task = event.task;

    // A card the user is owed news about gets a `task` notification with the
    // reason in it, and that is the push. It is written right after this
    // event, in the same tick - so look once the tick is over, and speak
    // only for the failures nobody is told about otherwise (an agent's own
    // card, say).
    setImmediate(() => {
      const since = Date.now() - TASK_NOTIFICATION_LOOKBACK_MS;
      if (hasNotification('task', (entry) => entry.taskId === task.id && entry.createdAt >= since)) return;
      dispatch({
        id: 'task:' + task.id + ':failed',
        kind: 'task',
        urgent: false,
        message: '🚧 Task failed: ' + oneLine(task.title, 200),
        tallyKey: 'task:failed',
        origin: { kind: 'task', ref: task.id, title: oneLine(task.title, 60) },
      });
    });
  };

  /** Whether a recent notification of this kind matches - the "already told" check. */
  function hasNotification(kind: Notification['kind'], matches: (entry: Notification) => boolean): boolean {
    try {
      return assistant.store.org.listNotifications({ kind, limit: RECENT_NOTIFICATIONS_CHECKED }).some(matches);
    } catch {
      return false;
    }
  }

  /**
   * Whether this agent is somebody the company answers to.
   *
   * Two ways to qualify, because the org chart has two: a team can name a
   * lead in `leadId`, and an agent can simply have people reporting to it.
   * A "Head of" with reports but no team of their own leads in every sense
   * that matters here, and asking only about `leadId` left exactly that
   * person unable to reach the phone. Read fresh on every notification, so
   * a promotion takes effect without a restart.
   */
  const isLead = (orgId: string, agentId: string): boolean =>
    assistant.store.org.listTeams(orgId).some((team) => team.leadId === agentId) ||
    assistant.store.org.listAgents(orgId, { managerId: agentId }).length > 0;

  /** Who is speaking in a notification, by name. */
  const speaker = (notification: Notification): string =>
    notification.fromKind === 'assistant'
      ? context.config.assistantName
      : notification.fromKind === 'agent'
        ? ((notification.fromAgentId ? assistant.store.org.getAgent(notification.fromAgentId)?.name : undefined) ??
          'An agent')
        : 'Rookery';

  /** The phone's text for one notification, by kind. */
  function notificationMessage(notification: Notification): string {
    const title = oneLine(notification.title, 200);
    switch (notification.kind) {
      case 'schedule':
        return withBody('⏰ ' + title, notification.body);
      case 'question': {
        const task = notification.taskId ? assistant.store.org.getTask(notification.taskId) : null;
        const head = task
          ? '❓ ' + speaker(notification) + ' asks about task “' + oneLine(task.title, 120) + '”:'
          : '❓ ' + title;
        return withBody(head, notification.body) + '\n\nReply to this message to answer.';
      }
      case 'task': {
        const status = notification.taskId ? assistant.store.org.getTask(notification.taskId)?.status : undefined;
        const failed = status ? status === 'failed' : / failed$/.test(notification.title);
        const cancelled = status ? status === 'cancelled' : / was cancelled$/.test(notification.title);
        return withBody((failed ? '❌ ' : cancelled ? '🚫 ' : '✅ ') + title, notification.body);
      }
      case 'watch':
        return withBody('👀 ' + title, notification.body);
      case 'agent':
        return withBody('📬 ' + speaker(notification) + ' – ' + oneLine(notification.title, 120), notification.body);
      case 'sleep':
        return withBody('🌙 ' + title, notification.body);
      default:
        return withBody('🔔 ' + title, notification.body);
    }
  }

  /**
   * Something for the user - the one road that replaced mail. Which kinds
   * reach the phone is the user's per-kind switches (`notificationPushAllowed`);
   * a question always does, and goes out at once, like the assistant's own
   * questions: it holds a card still until somebody answers it.
   */
  const onNotification = (event: AgentEvent): void => {
    if (event.type !== 'notification') return;
    const notification = event.notification;
    if (!notificationPushAllowed(pushConfig(), notification, (agentId) => isLead(notification.orgId, agentId))) return;
    const question = notification.kind === 'question';

    dispatch({
      id: 'notification:' + notification.id,
      kind: 'notification',
      urgent: question,
      ...(question ? { immediate: true } : {}),
      message: notificationMessage(notification),
      tallyKey: 'notification:' + notification.kind,
      // The notification's own id: a reply is about what was pushed, and the
      // store has the whole thing when it is needed. A schedule's outcome
      // also names the conversation the run happened in, so answering it
      // continues that conversation instead of starting a stranger next to it.
      origin: {
        kind: 'notification',
        ref: notification.id,
        title: oneLine(notification.title, 60),
        ...(notification.kind === 'schedule' && notification.sessionId ? { sessionId: notification.sessionId } : {}),
        ...(notification.body.trim() ? { snippet: notification.body } : {}),
      },
      // The read receipt Telegram does not give. Having read it on the phone
      // is worth nothing to the web inbox unless it is said out loud, and a
      // tap is the only place the user can say it.
      keyboard: notificationReadKeyboard(notification.id),
    });
  };

  /**
   * The assistant asking the user something, carried to the phone.
   *
   * It belongs in this lane and not in the commentary above: a question is
   * somebody writing, not something finishing, which is the same reason notifications are
   * is here. What it does *not* take from this lane is the buffering. Quiet
   * hours and the hourly cap exist so a finished assignment can wait until
   * breakfast - a question cannot, because it expires, and a question
   * delivered from a buffer asks about a decision the turn was forced to make
   * without it twenty minutes ago. So it goes out now or not at all, and for
   * the same reason it is not counted against the cap that protects notifications.
   *
   * The gateway does the drawing, because the buttons and the registry that
   * makes a typed reply count are its business, and it only draws a question
   * once per chat however many paths lead to it.
   */
  const onQuestion = (event: AgentEvent): void => {
    if (event.type !== 'question') return;
    if (!pushConfig().enabled) return;
    for (const userId of pushRecipients(context.config.gateways.telegram)) {
      if (disabled.has(userId)) continue;
      gateway.ask(userId, event);
    }
  };

  /** The question is over: the buttons say so, wherever it was answered. */
  const onQuestionClosed = (event: AgentEvent): void => {
    if (event.type !== 'question-closed') return;
    gateway.closeQuestion(event.id, event.reason, event.answer);
  };

  const onNotify = (event: NotifyEvent): void => {
    dispatch({
      id: 'notify:' + event.at,
      kind: 'notify',
      urgent: event.urgency === 'high',
      // Verbatim: this is the assistant speaking in its own words, not a
      // state-change line this module composed, so nothing is added to it.
      message: event.text,
      tallyKey: 'notify:normal',
      // No record behind a notice, so it carries its own text: replying to
      // it puts the notice itself back in front of the turn.
      origin: { kind: 'notify', snippet: event.text, title: oneLine(event.text, 60) },
    });
  };

  assistant.on('assignment', onAssignment);
  assistant.on('cron', onCron);
  assistant.on('sleep', onSleep);
  assistant.on('task', onTask);
  assistant.on('notification', onNotification);
  assistant.on('notify', onNotify);
  assistant.on('question', onQuestion);
  assistant.on('question-closed', onQuestionClosed);
  assistant.on('tool', onToolCall);
  assistant.on('memory', onMemoryLearned);
  assistant.on('changed', onChanged);

  return {
    detach: () => {
      assistant.off('assignment', onAssignment);
      assistant.off('cron', onCron);
      assistant.off('sleep', onSleep);
      assistant.off('task', onTask);
      assistant.off('notification', onNotification);
      assistant.off('notify', onNotify);
      assistant.off('question', onQuestion);
      assistant.off('question-closed', onQuestionClosed);
      assistant.off('tool', onToolCall);
      assistant.off('memory', onMemoryLearned);
      assistant.off('changed', onChanged);
      if (feedTimer) clearTimeout(feedTimer);
      clearInterval(ticker);
    },
    // The three ways a notice silently goes nowhere, asked in the same order
    // `dispatch` and `sendNow` would hit them: the channel is not polling,
    // push is switched off, or every recipient is gone or blocked us.
    canDeliver: () =>
      gateway.status().running &&
      pushConfig().enabled &&
      pushRecipients(context.config.gateways.telegram).some((id) => !disabled.has(id)),
  };
}
