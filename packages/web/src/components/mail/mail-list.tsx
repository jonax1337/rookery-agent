import { InboxIcon, MailCheckIcon, PenSquareIcon, SearchIcon, SendIcon } from 'lucide-react';

import type { Mail } from '@/lib/types';
import { relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, NoResults } from '@/components/common/empty-state';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

/**
 * The middle pane: which folder is open, the All/Unread filter, search, a
 * Compose button when the mailbox is writable, and the mail rows.
 *
 * The rows are shadcn's mail cards - a bordered block per mail with sender,
 * time, subject, a two-line snippet and the recipients as badges - rather than
 * the flat table rows this pane used to draw. Reading one is `MailDisplay`'s
 * job; this only ever selects one.
 *
 * Which folder is open is no longer decided here: Inbox and Outbox moved to
 * the rail, where a mail program puts its folders.
 */

/** The body on one line, for the row's snippet. */
function snippet(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

interface MailListEmptyProps {
  box: 'inbox' | 'outbox';
  /** Whose mailbox stands empty, for the sentence that explains it. */
  title: string;
  interactive: boolean;
  search: string;
  onSearch(value: string): void;
  filter: 'all' | 'unread';
  onFilterChange(filter: 'all' | 'unread'): void;
  showsUnread: boolean;
}

/**
 * What the list shows instead of rows.
 *
 * Three different situations used to share one sentence ("No mail matches
 * this view") inside a full-bleed outlined box that ran into the pane's own
 * borders. They are not the same thing: a search that missed wants its term
 * cleared, an Unread tab with nothing left is good news, and a mailbox that
 * has never received anything is simply new. Only the first two have a way
 * out, so only they offer a button.
 */
function MailListEmpty({
  box,
  title,
  interactive,
  search,
  onSearch,
  filter,
  onFilterChange,
  showsUnread,
}: MailListEmptyProps) {
  const owner = interactive ? 'You' : title;

  if (search.trim()) {
    return <NoResults query={search.trim()} onReset={() => onSearch('')} size="sm" />;
  }

  if (showsUnread && filter === 'unread') {
    return (
      <EmptyState
        icon={MailCheckIcon}
        title="Nothing unread"
        description="Every mail in this inbox has been read."
        actionLabel="Show all mail"
        onAction={() => onFilterChange('all')}
        variant="plain"
        size="sm"
      />
    );
  }

  return (
    <EmptyState
      icon={box === 'inbox' ? InboxIcon : SendIcon}
      title={box === 'inbox' ? 'Inbox is empty' : 'Outbox is empty'}
      description={
        box === 'inbox'
          ? interactive
            ? 'Nobody has written to you yet. Mail an agent and their reply lands here.'
            : owner + ' has not received any mail yet.'
          : interactive
            ? 'You have not sent any mail yet.'
            : owner + ' has not sent any mail yet.'
      }
      variant="plain"
      size="sm"
    />
  );
}

interface MailListProps {
  mails: Mail[];
  selectedId: string | null;
  onSelect(id: string): void;
  /** Whose mail this is, beside the folder heading. */
  title: string;
  box: 'inbox' | 'outbox';
  filter: 'all' | 'unread';
  onFilterChange(filter: 'all' | 'unread'): void;
  /** Only the "You" mailbox composes and shows unread state. */
  interactive: boolean;
  onCompose(): void;
  search: string;
  onSearch(value: string): void;
  /** The name the row leads with: the sender in the inbox, the recipients in the outbox. */
  primaryLabel(mail: Mail): string;
  /** That sender's job title, when there is one name and it belongs to an agent. */
  primaryRole(mail: Mail): string | null;
  /** To and Cc as separate chips, in that order. */
  recipientChips(mail: Mail): string[];
  isUnread(mail: Mail): boolean;
}

export function MailList({
  mails,
  selectedId,
  onSelect,
  title,
  box,
  filter,
  onFilterChange,
  interactive,
  onCompose,
  search,
  onSearch,
  primaryLabel,
  primaryRole,
  recipientChips,
  isUnread,
}: MailListProps) {
  // Read state belongs to the mailbox owner, and only the owner's own mailbox
  // is ever open for writing - so unread is a thing the inbox of "You" has.
  const showsUnread = interactive && box === 'inbox';

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2 px-4">
        <h1 className="shrink-0 text-xl font-bold">{box === 'inbox' ? 'Inbox' : 'Outbox'}</h1>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>
        {!interactive && (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            Read-only
          </Badge>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {showsUnread && (
            <Tabs value={filter} onValueChange={(value) => onFilterChange(value as 'all' | 'unread')}>
              <TabsList>
                <TabsTrigger value="all">All mail</TabsTrigger>
                <TabsTrigger value="unread">Unread</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {interactive && (
            <Button type="button" size="icon-sm" variant="outline" onClick={onCompose} aria-label="Compose">
              <PenSquareIcon />
            </Button>
          )}
        </div>
      </div>

      <Separator />

      <div className="shrink-0 p-4">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search"
            className="pl-8"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {mails.length === 0 ? (
          // Centred in what is left of the pane, with the rows' own side
          // padding - an empty state that touches the panel border reads as a
          // broken layout rather than as an answer.
          <div className="flex h-full items-center justify-center px-4 pb-10">
            <MailListEmpty
              box={box}
              title={title}
              interactive={interactive}
              search={search}
              onSearch={onSearch}
              filter={filter}
              onFilterChange={onFilterChange}
              showsUnread={showsUnread}
            />
          </div>
        ) : (
          // Radix sets `display: table` inline on the viewport's inner wrapper, so
          // it grows to the widest row instead of the pane and every `truncate`
          // below measures against that. Only `!important` beats an inline style.
          <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:block!">
            <div className="flex flex-col gap-2 px-4 pb-4">
              {mails.map((mail) => {
                const unread = showsUnread && isUnread(mail);
                const selected = mail.id === selectedId;
                const chips = recipientChips(mail);
                return (
                  <button
                    key={mail.id}
                    type="button"
                    onClick={() => onSelect(mail.id)}
                    className={cn(
                      'flex w-full min-w-0 flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm transition-all hover:bg-accent',
                      selected && 'bg-muted',
                    )}
                  >
                    <div className="flex w-full min-w-0 flex-col gap-1">
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <span className={cn('shrink-0 truncate', unread ? 'font-semibold' : 'font-medium')}>
                          {primaryLabel(mail)}
                        </span>
                        {/* The job title, so six agent names are six roles. It
                            gives up its width first: the name must stay whole. */}
                        {primaryRole(mail) && (
                          <span className="min-w-0 truncate text-xs text-muted-foreground">{primaryRole(mail)}</span>
                        )}
                        {unread && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />}
                        <span
                          className={cn(
                            'ml-auto shrink-0 text-xs',
                            selected ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {relativeTime(mail.createdAt)}
                        </span>
                      </div>
                      <div className="min-w-0 truncate text-xs font-medium">{mail.subject || '(No subject)'}</div>
                    </div>
                    <div className="line-clamp-2 w-full text-xs text-muted-foreground">{snippet(mail.body)}</div>
                    {chips.length > 0 && (
                      <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
                        {chips.map((chip) => (
                          <Badge key={chip} variant="secondary" className="max-w-full truncate font-normal">
                            {chip}
                          </Badge>
                        ))}
                      </div>
                    )}
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
