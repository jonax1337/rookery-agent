import { useEffect, useState } from 'react';

import { ResultMarkdown } from '@/components/result-markdown';
import { EmptyState } from '@/components/common/empty-state';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { baseSubject, statusNoteDetail, statusNoteKind, type StatusNoteKind } from '@/lib/mail';
import { useConfig, useOrgState } from '@/providers/rookery-provider';
import {
  BanIcon,
  CircleCheckIcon,
  MailboxIcon,
  ServerCrashIcon,
  type IconComponent,
} from '@/components/icons';
import type { Mail, RequesterKind } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One mail thread, oldest first, as a conversation.
 *
 * A task and its thread are the same matter, so the page that shows the task
 * shows what was said about it instead of linking away to a second place; the
 * mailbox's reading pane shows the same view for whichever thread is open.
 *
 * Two kinds of entry, drawn differently on purpose. What a person or an agent
 * wrote is a message with a sender. The controller's status notes ("The task
 * … is done.") are bookkeeping: a single line on the thread's timeline, with
 * the result folded away underneath, so they mark where the work stands
 * without reading like one more letter from the assistant.
 */

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

const NOTE_LOOK: Record<StatusNoteKind, { label: string; icon: IconComponent; className: string }> = {
  done: { label: 'Task done', icon: CircleCheckIcon, className: 'text-primary' },
  blocked: { label: 'Waiting for an answer', icon: MailboxIcon, className: 'text-amber-500' },
  cancelled: { label: 'Task cancelled', icon: BanIcon, className: 'text-muted-foreground' },
  failed: { label: 'Task failed', icon: ServerCrashIcon, className: 'text-destructive' },
};

export interface MailThreadViewProps {
  threadId: string;
  /** Whose mailbox the thread is read as; the user's by default. */
  mailbox?: string;
  /** The mail the reader opened the thread from; it is marked and scrolled to. */
  highlightId?: string;
  /** Any value that changes when the thread may have grown - it refetches. */
  reloadKey?: unknown;
  className?: string;
}

export function MailThreadView({ threadId, mailbox = 'user', highlightId, reloadKey, className }: MailThreadViewProps) {
  const org = useOrgState();
  const { assistantName } = useConfig();
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A new thread starts blank; a reload of the same one keeps what is on
  // screen until the answer is there, so a new reply does not flash the pane.
  useEffect(() => {
    setMails(null);
    setError(null);
  }, [threadId, mailbox]);

  useEffect(() => {
    let live = true;
    api
      .mailThread(threadId, mailbox)
      .then((thread) => {
        if (live) setMails(thread);
      })
      .catch((caught: Error) => {
        if (live) setError(caught.message);
      });
    return () => {
      live = false;
    };
  }, [threadId, mailbox, reloadKey]);

  useEffect(() => {
    if (!highlightId || mails === null) return;
    document.getElementById('mail-' + highlightId)?.scrollIntoView({ block: 'nearest' });
  }, [highlightId, mails]);

  const nameOf = (kind: RequesterKind, id?: string): string => {
    if (kind === 'user') return 'You';
    if (kind === 'assistant') return assistantName;
    return id ? (org.agentById(id)?.name ?? 'Former agent') : 'Former agent';
  };

  const roleOf = (kind: RequesterKind, id?: string): string | null =>
    kind === 'agent' && id ? (org.agentById(id)?.title?.trim() || null) : null;

  if (error) {
    return (
      <EmptyState
        icon={MailboxIcon}
        title="The thread could not be loaded"
        description={error}
        variant="plain"
        size="sm"
      />
    );
  }

  if (mails === null) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (mails.length === 0) {
    return (
      <EmptyState
        icon={MailboxIcon}
        title="Nothing said yet"
        description="This thread carries no mail."
        variant="plain"
        size="sm"
      />
    );
  }

  const topic = baseSubject(mails[0]?.subject ?? '');

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {mails.map((mail) => {
        const note = statusNoteKind(mail);
        const highlighted = mail.id === highlightId && mails.length > 1;

        if (note) {
          const look = NOTE_LOOK[note];
          const detail = statusNoteDetail(mail);
          return (
            <div key={mail.id} id={'mail-' + mail.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
                <look.icon className={cn('size-3.5 shrink-0', look.className)} aria-hidden="true" />
                <span className="font-medium text-foreground">{look.label}</span>
                <span>{formatDateTime(mail.createdAt)}</span>
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
              </div>
              {detail ? (
                <details className="group mx-auto w-full max-w-prose text-sm">
                  <summary className="cursor-pointer list-none text-center text-xs text-muted-foreground hover:text-foreground">
                    <span className="group-open:hidden">Show result</span>
                    <span className="hidden group-open:inline">Hide result</span>
                  </summary>
                  <div className="mt-2 rounded-lg border bg-muted/30 p-3">
                    <ResultMarkdown text={detail} />
                  </div>
                </details>
              ) : null}
            </div>
          );
        }

        const sender = nameOf(mail.fromKind, mail.fromAgentId);
        const role = roleOf(mail.fromKind, mail.fromAgentId);
        const to = mail.recipients
          .filter((recipient) => recipient.box === 'to')
          .map((recipient) => nameOf(recipient.recipientKind, recipient.recipientId))
          .join(', ');
        const cc = mail.recipients
          .filter((recipient) => recipient.box === 'cc')
          .map((recipient) => nameOf(recipient.recipientKind, recipient.recipientId))
          .join(', ');
        // Only a subject that changed mid-thread is news; "Re: <topic>" is not.
        const subject = baseSubject(mail.subject);
        const showSubject = subject !== '' && subject !== topic;
        return (
          <article
            key={mail.id}
            id={'mail-' + mail.id}
            className={cn('flex gap-3 rounded-lg border p-3', highlighted && 'border-primary/50 bg-muted/40')}
          >
            <Avatar className="size-8 shrink-0">
              <AvatarFallback className="text-xs">{initials(sender)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold">{sender}</span>
                {role ? <span className="text-xs text-muted-foreground">{role}</span> : null}
                <span className="ms-auto text-xs text-muted-foreground">
                  {formatDateTime(mail.createdAt)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {to ? 'to ' + to : null}
                {cc ? (to ? ' · ' : '') + 'cc ' + cc : null}
              </p>
              {showSubject ? <p className="mt-1 text-xs font-medium">{mail.subject}</p> : null}
              <ResultMarkdown text={mail.body} className="mt-2" />
            </div>
          </article>
        );
      })}
    </div>
  );
}
