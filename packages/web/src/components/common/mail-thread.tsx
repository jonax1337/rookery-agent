import { useEffect, useState } from 'react';

import { ResultMarkdown } from '@/components/result-markdown';
import { EmptyState } from '@/components/common/empty-state';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useConfig, useOrgState } from '@/providers/rookery-provider';
import { MailboxIcon } from '@/components/icons';
import type { Mail, RequesterKind } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One mail thread, read-only, where the case it belongs to lives.
 *
 * A task and its thread are the same matter, so the page that shows the task
 * shows what was said about it instead of linking away to a second place.
 * Writing stays in the mailbox: this is the record, not the desk.
 */

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export interface MailThreadViewProps {
  threadId: string;
  /** Whose mailbox the thread is read as; the user's by default. */
  mailbox?: string;
  className?: string;
}

export function MailThreadView({ threadId, mailbox = 'user', className }: MailThreadViewProps) {
  const org = useOrgState();
  const { assistantName } = useConfig();
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMails(null);
    setError(null);
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
  }, [threadId, mailbox]);

  const nameOf = (kind: RequesterKind, id?: string): string => {
    if (kind === 'user') return 'You';
    if (kind === 'assistant') return assistantName;
    return id ? (org.agentById(id)?.name ?? 'Former agent') : 'Former agent';
  };

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
        description="The thread of this task carries no mail."
        variant="plain"
        size="sm"
      />
    );
  }

  return (
    <div className={cn('flex flex-col divide-y', className)}>
      {mails.map((mail) => {
        const sender = nameOf(mail.fromKind, mail.fromAgentId);
        const to = mail.recipients
          .filter((recipient) => recipient.box === 'to')
          .map((recipient) => nameOf(recipient.recipientKind, recipient.recipientId))
          .join(', ');
        return (
          <article key={mail.id} className="flex gap-3 py-4 first:pt-0 last:pb-0">
            <Avatar className="size-8 shrink-0">
              <AvatarFallback className="text-xs">{initials(sender)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold">{sender}</span>
                {to ? <span className="text-xs text-muted-foreground">to {to}</span> : null}
                <span className="ms-auto text-xs text-muted-foreground">
                  {formatDateTime(mail.createdAt)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{mail.subject || '(No subject)'}</p>
              <ResultMarkdown text={mail.body} className="mt-2" />
            </div>
          </article>
        );
      })}
    </div>
  );
}
