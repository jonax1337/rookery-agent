import { PenSquareIcon, SearchIcon } from 'lucide-react';

import type { Mail } from '@/lib/types';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * The middle pane: the Inbox/Outbox toggle, search, a Compose button when the
 * mailbox is writable, and the mail rows. Reading one row is `MailDisplay`'s
 * job - this only ever selects one.
 */

/** First line of the body, for the row's snippet. */
function snippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

interface MailListProps {
  mails: Mail[];
  selectedId: string | null;
  onSelect(id: string): void;
  box: 'inbox' | 'outbox';
  onBoxChange(box: 'inbox' | 'outbox'): void;
  /** Only the "You" mailbox composes and shows unread state. */
  interactive: boolean;
  onCompose(): void;
  search: string;
  onSearch(value: string): void;
  senderLabel(mail: Mail): string;
  recipientSummary(mail: Mail): string;
  isUnread(mail: Mail): boolean;
}

export function MailList({
  mails,
  selectedId,
  onSelect,
  box,
  onBoxChange,
  interactive,
  onCompose,
  search,
  onSearch,
  senderLabel,
  recipientSummary,
  isUnread,
}: MailListProps) {
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Tabs value={box} onValueChange={(value) => onBoxChange(value as 'inbox' | 'outbox')}>
          <TabsList>
            <TabsTrigger value="inbox">Inbox</TabsTrigger>
            <TabsTrigger value="outbox">Outbox</TabsTrigger>
          </TabsList>
        </Tabs>
        {interactive && (
          <Button type="button" size="icon-sm" variant="outline" onClick={onCompose} title="Compose" className="ml-auto">
            <PenSquareIcon />
            <span className="sr-only">Compose</span>
          </Button>
        )}
      </div>

      <div className="border-b p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search mail…"
            className="pl-8"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {mails.length === 0 ? (
          <EmptyState title="Nothing here" description="No mail matches this view." className="mt-10" />
        ) : (
          // Radix sets `display: table` inline on the viewport's inner wrapper, so
          // it grows to the widest row instead of the pane and every `truncate`
          // below measures against that. Only `!important` beats an inline style.
          <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:block!">
            <div className="flex flex-col">
              {mails.map((mail) => {
                const unread = interactive && box === 'inbox' && isUnread(mail);
                const selected = mail.id === selectedId;
                return (
                  <button
                    key={mail.id}
                    type="button"
                    onClick={() => onSelect(mail.id)}
                    className={cn(
                      'flex w-full min-w-0 flex-col gap-1 border-b px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
                      selected && 'bg-muted',
                    )}
                  >
                    <div className="flex w-full min-w-0 items-center justify-between gap-2">
                      <span className={cn('min-w-0 truncate text-sm', unread && 'font-semibold')}>
                        {mail.subject || '(No subject)'}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {relativeTime(mail.createdAt)}
                      </span>
                    </div>
                    <div className="flex w-full min-w-0 items-center gap-1.5">
                      {unread && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />}
                      <p className="min-w-0 truncate text-xs text-muted-foreground">
                        {box === 'outbox' ? snippet(mail.body) : senderLabel(mail) + ': ' + snippet(mail.body)}
                      </p>
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">{recipientSummary(mail)}</p>
                  </button>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
