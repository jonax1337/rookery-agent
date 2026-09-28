import type { Mail } from '@/lib/types';

/**
 * How the mailbox reads its mail: as conversations, not as a pile.
 *
 * The server hands out mail one row per recipient-visible message. A task
 * thread with a work order, three replies and two status notes therefore used
 * to be six cards in the list, most of them titled "Re: …". These helpers let
 * the list show one row per thread and the reading pane tell a status note
 * apart from something a colleague actually wrote.
 */

/** The outcome a status note reports - see `statusNote` in core's org/controller.ts. */
export type StatusNoteKind = 'done' | 'failed' | 'cancelled' | 'blocked';

// The current wording, and the older "was marked as <status>." that threads
// from before the notes carried their result still hold.
const STATUS_NOTE =
  /^The task "[\s\S]*?" (is done|was cancelled|is waiting for an answer|failed|was marked as (?:done|failed|cancelled|blocked))/;

/**
 * Whether a mail is the controller's bookkeeping note about a task ending,
 * and which ending. Those are written by the assistant into an assignment
 * thread in one fixed wording; anything else is correspondence.
 */
export function statusNoteKind(mail: Mail): StatusNoteKind | null {
  if (mail.fromKind !== 'assistant' || mail.threadKind !== 'assignment') return null;
  const match = STATUS_NOTE.exec(mail.body.trimStart());
  if (!match) return null;
  switch (match[1]?.replace('was marked as ', '')) {
    case 'done':
    case 'is done':
      return 'done';
    case 'cancelled':
    case 'was cancelled':
      return 'cancelled';
    case 'blocked':
    case 'is waiting for an answer':
      return 'blocked';
    default:
      return 'failed';
  }
}

/** A status note's result, without the sentence that announced it. */
export function statusNoteDetail(mail: Mail): string {
  const body = mail.body.trim();
  const breakAt = body.indexOf('\n\n');
  if (breakAt >= 0) return body.slice(breakAt + 2).trim();
  // "… failed: <error>" carries its detail on the same line.
  const colon = body.indexOf('" failed: ');
  return colon >= 0 ? body.slice(colon + '" failed: '.length).trim() : '';
}

/** The subject without the "Re: " / "Fwd: " chain a reply puts in front of it. */
export function baseSubject(subject: string): string {
  return subject.replace(/^(\s*(re|aw|fwd?|wg)\s*:\s*)+/i, '').trim();
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

/** One conversation as the list shows it. */
export interface MailThreadSummary {
  threadId: string;
  /** The newest mail of the thread that is in the loaded list. */
  latest: Mail;
  /**
   * The newest one somebody actually wrote - not a status note. The row and
   * the reply are about it: answering a status note would write to the
   * assistant that filed it instead of to whoever did the work.
   */
  latestMessage: Mail;
  /** The oldest loaded mail - its subject names the thread. */
  first: Mail;
  /** How many loaded mails the thread has; status notes included. */
  count: number;
  /** Whether any of them is unread for the mailbox owner. */
  unread: boolean;
}

/**
 * Folds a newest-first mail list into one entry per thread, newest thread
 * first. Only the loaded mails count: the list is capped by the server, so a
 * thread's full length is the reading pane's to show, not the row's.
 */
export function groupThreads(mails: readonly Mail[], isUnread: (mail: Mail) => boolean): MailThreadSummary[] {
  const byThread = new Map<string, MailThreadSummary>();
  for (const mail of mails) {
    const known = byThread.get(mail.threadId);
    if (!known) {
      byThread.set(mail.threadId, {
        threadId: mail.threadId,
        latest: mail,
        latestMessage: mail,
        first: mail,
        count: 1,
        unread: isUnread(mail),
      });
      continue;
    }
    known.count += 1;
    if (mail.createdAt > known.latest.createdAt) known.latest = mail;
    // Mail arrives newest first, so the first entry kept is only a stand-in
    // when it is a note: any written message replaces it, and among written
    // ones the newest wins.
    const keptIsNote = statusNoteKind(known.latestMessage) !== null;
    const isNote = statusNoteKind(mail) !== null;
    if ((keptIsNote && !isNote) || (keptIsNote === isNote && mail.createdAt > known.latestMessage.createdAt)) {
      known.latestMessage = mail;
    }
    if (mail.createdAt < known.first.createdAt) known.first = mail;
    if (!known.unread && isUnread(mail)) known.unread = true;
  }
  return [...byThread.values()].sort((a, b) => b.latest.createdAt - a.latest.createdAt);
}
