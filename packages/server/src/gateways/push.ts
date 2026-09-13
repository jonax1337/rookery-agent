import { inQuietHours, pushRecipients, splitMessage } from '@rookery/core';
import type { AgentEvent, Mail, NotifyEvent, TelegramPushConfig } from '@rookery/core';
import type { ServerContext } from '../context.js';
import type { GatewayHandle } from './telegram.js';

/**
 * The assistant's own initiative, and the state changes worth interrupting a
 * phone for, turned into English push messages.
 *
 * `message`, `memory` and `changed` never reach here on purpose - those fire
 * on every turn and every recall, and a phone that buzzed for each would be
 * muted within the hour. What is reported is the handful of things that
 * finish without anyone watching: an agent's assignment, a schedule, a
 * night's sleep, a blocked task, and whatever `notify` decides to say.
 *
 * Mail addressed to the user is the one item here that is somebody writing
 * rather than something finishing, and it is the channel the defaults lean
 * on: the company talks to the user in mail, and the phone carries that mail
 * instead of a running commentary on the machinery behind it. Who counts as
 * worth a buzz is `push.mailFrom` - the assistant alone, the assistant plus
 * the agents named as a team's lead, or everything that reaches the mailbox.
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
  kind: 'assignment' | 'cron' | 'sleep' | 'task' | 'mail' | 'notify';
  /** `notify` with urgency `high` - the only thing quiet hours do not hold back. */
  urgent: boolean;
  /** Full text, used as-is when this item is sent alone. */
  message: string;
  /** Which counting bucket this item falls into inside a batched digest. */
  tallyKey: string;
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
  'mail:new': { one: 'new mail', many: 'new mails' },
  'notify:normal': { one: 'notice', many: 'notices' },
};

/**
 * How much of a mail body the phone carries.
 *
 * Not a transport limit: Telegram takes 4096 characters per message and
 * `splitMessage` cuts anything longer into several, so a mail arrives whole
 * unless something here shortens it first. 600 was that something, and it
 * beheaded every mail worth reading. What is left is a politeness cap - four
 * messages is a long read on a phone, and past that the web inbox is the
 * better place, which the marker says out loud rather than trailing off.
 */
const MAIL_BODY_LIMIT = 12_000;
const MAIL_CLIPPED_NOTE = '\n\n[…] The rest of this mail is in your inbox.';

const HOUR_MS = 60 * 60 * 1000;
/** How often the buffer gets a chance to drain once quiet hours or the rate cap let go. */
const FLUSH_CHECK_MS = 60_000;

function oneLine(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

/** A mail body as the phone gets it: whole, or honestly cut off. */
function mailBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > MAIL_BODY_LIMIT
    ? trimmed.slice(0, MAIL_BODY_LIMIT).replace(/\s+\S*$/, '') + MAIL_CLIPPED_NOTE
    : trimmed;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? minutes + ' min ' + seconds + ' sec' : seconds + ' sec';
}

/** A Telegram 403 reads differently depending on which layer surfaces it. */
function isForbidden(error: unknown): boolean {
  const status = (error as { status?: number; statusCode?: number } | undefined)?.status
    ?? (error as { statusCode?: number } | undefined)?.statusCode;
  if (status === 403) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b403\b/.test(message) || /forbidden/i.test(message);
}

/**
 * Attach push delivery to one running gateway. Returns the unsubscribe
 * function; call it once, on server shutdown or when the gateway is torn
 * down, or the assistant's emitter keeps a listener for a channel nobody
 * reads from any more.
 */
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
    const cutoff = Date.now() - HOUR_MS;
    for (let oldest = sentAt[0]; oldest !== undefined && oldest < cutoff; oldest = sentAt[0]) sentAt.shift();
    const max = pushConfig().maxPerHour;
    return max > 0 && sentAt.length >= max;
  };

  async function sendNow(text: string): Promise<void> {
    const recipients = pushRecipients(context.config.gateways.telegram).filter((id) => !disabled.has(id));
    if (recipients.length === 0) return;
    sentAt.push(Date.now());
    const parts = splitMessage(text);
    for (const userId of recipients) {
      for (const part of parts) {
        try {
          // One call per message, in order - Telegram has no batch send.
          await gateway.send(userId, part);
        } catch (error) {
          if (isForbidden(error)) {
            disabled.add(userId);
            context.log.warn('Telegram push disabled: recipient blocked the bot (403)', { userId });
          } else {
            context.log.warn('Telegram push failed', {
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }
      }
    }
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
    void sendNow(single ? single.message : buildDigest(items));
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
      case 'mail':
        return config.mail;
      case 'notify':
        // No dedicated switch for the assistant's own notices - the master
        // `enabled` below is the only gate, same as the config shape defines it.
        return true;
    }
  }

  function dispatch(item: PushItem): void {
    if (!pushConfig().enabled || !perKindEnabled(item.kind)) return;

    const last = recentIds.get(item.id);
    if (last !== undefined && Date.now() - last < 10_000) return;
    recentIds.set(item.id, Date.now());

    // Give a backlog a chance to drain before deciding where this new item goes.
    attemptFlush();

    const quiet = !item.urgent && isQuietNow();
    if (quiet || isRateLimited()) {
      buffer.push(item);
      return;
    }
    void sendNow(item.message);
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
    });
  };

  const onCron = (event: AgentEvent): void => {
    if (event.type !== 'cron') return;
    if (event.job.kind === 'script' && event.run?.status === 'done' && !event.run.result?.trim()) return;
    if (event.deleted || !event.run || event.run.status === 'running') return;
    // A `sleep`-kind schedule also fires its own `sleep` event with the real
    // report; reporting the bare cron run too would say the same thing twice.
    if (event.job.kind === 'sleep') return;

    const label = event.run.status === 'done' ? 'completed' : 'failed';
    const duration = formatDuration(event.run.durationMs);
    const message =
      '⏰ Schedule “' + event.job.name + '” ' + label + (duration ? ' (' + duration + ')' : '') + '.';

    dispatch({
      id: 'cron:' + event.run.id,
      kind: 'cron',
      urgent: false,
      message,
      tallyKey: 'cron:' + event.run.status,
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
    });
  };

  const onTask = (event: AgentEvent): void => {
    if (event.type !== 'task') return;
    // `failed`, not `blocked`: the board has no blocked state, and a task
    // that ran and did not make it is the one change on it worth a buzz.
    // Everything else about a task is visible the next time the page is open.
    if (event.task.status !== 'failed') return;

    const message = '🚧 Task failed: ' + oneLine(event.task.title, 200);
    dispatch({
      id: 'task:' + event.task.id + ':failed',
      kind: 'task',
      urgent: false,
      message,
      tallyKey: 'task:failed',
    });
  };

  /**
   * Whether this agent is somebody the company answers to.
   *
   * Two ways to qualify, because the org chart has two: a team can name a
   * lead in `leadId`, and an agent can simply have people reporting to it.
   * A "Head of" with reports but no team of their own leads in every sense
   * that matters here, and asking only about `leadId` left exactly that
   * person unable to reach the phone. Read fresh on every mail, so a
   * promotion takes effect without a restart.
   */
  const isLead = (orgId: string, agentId: string): boolean =>
    assistant.store.org.listTeams(orgId).some((team) => team.leadId === agentId) ||
    assistant.store.org.listAgents(orgId, { managerId: agentId }).length > 0;

  /**
   * Who wrote this mail, and whether that is somebody the user asked to hear
   * from. `undefined` leaves the mail in the web inbox and nowhere else.
   */
  const mailSenderLabel = (mail: Mail): string | undefined => {
    const setting = pushConfig().mailFrom;
    // The user's own mail, echoed back to the phone it was written from.
    if (mail.fromKind === 'user') return undefined;
    if (mail.fromKind === 'assistant') return 'Assistant';
    if (!mail.fromAgentId) return undefined;
    const agent = assistant.store.org.getAgent(mail.fromAgentId);
    if (!agent) return undefined;
    if (setting === 'assistant') return undefined;
    if (setting === 'leads' && !isLead(mail.orgId, agent.id)) return undefined;
    return agent.name;
  };

  const onMail = (event: AgentEvent): void => {
    if (event.type !== 'mail') return;
    const mail = event.mail;
    // To or Cc, no difference: being looped in is being told.
    if (!mail.recipients.some((recipient) => recipient.recipientKind === 'user')) return;
    const sender = mailSenderLabel(mail);
    if (!sender) return;

    dispatch({
      id: 'mail:' + mail.id,
      kind: 'mail',
      urgent: false,
      message: '📬 ' + sender + ' – ' + oneLine(mail.subject, 120) + '\n\n' + mailBody(mail.body),
      tallyKey: 'mail:new',
    });
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
    });
  };

  assistant.on('assignment', onAssignment);
  assistant.on('cron', onCron);
  assistant.on('sleep', onSleep);
  assistant.on('task', onTask);
  assistant.on('mail', onMail);
  assistant.on('notify', onNotify);

  return {
    detach: () => {
      assistant.off('assignment', onAssignment);
      assistant.off('cron', onCron);
      assistant.off('sleep', onSleep);
      assistant.off('task', onTask);
      assistant.off('mail', onMail);
      assistant.off('notify', onNotify);
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
