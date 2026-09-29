import type { Notification, NotificationKind, TaskEvent } from '@/lib/types';

/**
 * How the web app names and routes notifications - the things Rookery stores
 * for the user since company mail is gone (see
 * docs/concepts/mail-removal-notifications-and-task-activity.md).
 */

/** What each kind is called, singular, as a badge and a toast line say it. */
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  question: 'Question',
  schedule: 'Schedule',
  task: 'Task',
  agent: 'Agent report',
  watch: 'Board watch',
  sleep: 'Sleep',
  system: 'System',
};

/** The filters the inbox rail offers, in rail order. `all` is no filter. */
export type NotificationFilter = 'all' | NotificationKind;

export const NOTIFICATION_FILTERS: { id: NotificationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'question', label: 'Questions' },
  { id: 'schedule', label: 'Schedules' },
  { id: 'task', label: 'Tasks' },
  { id: 'agent', label: 'Agents' },
  { id: 'watch', label: 'Watch' },
  { id: 'sleep', label: 'Sleep' },
  { id: 'system', label: 'System' },
];

/** One place a notification points at, as a link the reading pane shows. */
export interface NotificationSource {
  label: string;
  to: string;
}

/**
 * Where a notification came from, most specific first: the card it is
 * about, the schedule run it reports, the conversation it came out of.
 */
export function notificationSources(notification: Notification): NotificationSource[] {
  const sources: NotificationSource[] = [];
  if (notification.taskId) sources.push({ label: 'Open task', to: '/tasks/' + notification.taskId });
  if (notification.cronJobId) {
    sources.push({
      label: notification.cronRunId ? 'Open schedule run' : 'Open schedule',
      to:
        '/cron/' +
        notification.cronJobId +
        (notification.cronRunId ? '?run=' + encodeURIComponent(notification.cronRunId) : ''),
    });
  }
  if (notification.sessionId) sources.push({ label: 'Open conversation', to: '/c/' + notification.sessionId });
  return sources;
}

/** Whether the reading pane offers an answer box: a question about a card. */
export function isAnswerable(notification: Notification): boolean {
  return notification.kind === 'question' && Boolean(notification.taskId);
}

/**
 * The question a blocked card is waiting on: the newest `question` event, as
 * long as no `answer` came after it. `null` when nothing is open.
 */
export function openQuestion(events: readonly TaskEvent[]): TaskEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event) continue;
    if (event.kind === 'answer') return null;
    if (event.kind === 'question') return event;
  }
  return null;
}

/**
 * The body on one line with the Markdown taken out, for a list row. The row
 * is a preview, and `**Wetter:**` in a preview is noise, not emphasis.
 */
export function plainSnippet(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
