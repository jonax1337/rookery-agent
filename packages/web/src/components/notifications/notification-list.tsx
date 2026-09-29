import { ArchiveIcon, CheckIcon, MailCheckIcon, SearchIcon } from '@/components/icons';

import type { Notification, TaskStatus } from '@/lib/types';
import { relativeTime } from '@/lib/format';
import { NOTIFICATION_FILTERS, NOTIFICATION_KIND_LABEL, plainSnippet, type NotificationFilter } from '@/lib/notifications';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, NoResults } from '@/components/common/empty-state';
import { StatusBadge } from '@/components/common/status-badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { filterIcon, NOTIFICATION_KIND_ICON } from './notification-nav';

/**
 * The middle pane: which kind is open, the All/Unread filter, "Mark all
 * read", search, and one card per notification - sender, time, title, a
 * two-line snippet and the kind as a badge. Reading one is
 * `NotificationDisplay`'s job; this only ever selects one.
 */

interface NotificationListEmptyProps {
  filter: NotificationFilter;
  archived: boolean;
  search: string;
  onSearch(value: string): void;
  unreadOnly: boolean;
  onUnreadOnlyChange(value: boolean): void;
}

function NotificationListEmpty({
  filter,
  archived,
  search,
  onSearch,
  unreadOnly,
  onUnreadOnlyChange,
}: NotificationListEmptyProps) {
  if (search.trim()) {
    return <NoResults query={search.trim()} onReset={() => onSearch('')} size="sm" />;
  }

  if (unreadOnly && !archived) {
    return (
      <EmptyState
        icon={MailCheckIcon}
        title="Nothing unread"
        description="Every notification here has been read."
        actionLabel="Show all"
        onAction={() => onUnreadOnlyChange(false)}
        variant="plain"
        size="sm"
      />
    );
  }

  if (archived) {
    return (
      <EmptyState
        icon={ArchiveIcon}
        title="Archive is empty"
        description="Notifications you archive are kept here."
        variant="plain"
        size="sm"
      />
    );
  }

  return (
    <EmptyState
      icon={filterIcon(filter)}
      title="No notifications"
      description={
        filter === 'all'
          ? 'Schedule results, questions from agents and finished tasks land here.'
          : 'Nothing of this kind has come in yet.'
      }
      variant="plain"
      size="sm"
    />
  );
}

interface NotificationListProps {
  notifications: Notification[];
  selectedId: string | null;
  onSelect(id: string): void;
  filter: NotificationFilter;
  archived: boolean;
  unreadOnly: boolean;
  onUnreadOnlyChange(value: boolean): void;
  /** Absent when nothing is unread. */
  onMarkAllRead?: (() => void) | undefined;
  search: string;
  onSearch(value: string): void;
  /** Who said it: an agent's name, the assistant's, or "Rookery". */
  senderLabel(notification: Notification): string;
  /** The board status of the card a notification is about. */
  taskStatus(notification: Notification): TaskStatus | null;
}

export function NotificationList({
  notifications,
  selectedId,
  onSelect,
  filter,
  archived,
  unreadOnly,
  onUnreadOnlyChange,
  onMarkAllRead,
  search,
  onSearch,
  senderLabel,
  taskStatus,
}: NotificationListProps) {
  const heading = archived ? 'Archive' : (NOTIFICATION_FILTERS.find((entry) => entry.id === filter)?.label ?? 'All');

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex h-[52px] shrink-0 items-center gap-2 px-4">
        <h1 className="shrink-0 text-xl font-bold">{heading}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!archived && (
            <Tabs
              value={unreadOnly ? 'unread' : 'all'}
              onValueChange={(value) => onUnreadOnlyChange(value === 'unread')}
            >
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="unread">Unread</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {!archived && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onMarkAllRead?.()}
              disabled={!onMarkAllRead}
            >
              <CheckIcon />
              Mark all read
            </Button>
          )}
        </div>
      </div>

      <Separator />

      <div className="shrink-0 p-4">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search" className="pl-8" />
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {notifications.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 pb-10">
            <NotificationListEmpty
              filter={filter}
              archived={archived}
              search={search}
              onSearch={onSearch}
              unreadOnly={unreadOnly}
              onUnreadOnlyChange={onUnreadOnlyChange}
            />
          </div>
        ) : (
          // Radix sets `display: table` inline on the viewport's inner wrapper, so
          // it grows to the widest row instead of the pane and every `truncate`
          // below measures against that. Only `!important` beats an inline style.
          <ScrollArea className="h-full [&>[data-slot=scroll-area-viewport]>div]:block!">
            <div className="flex flex-col gap-2 px-4 pb-4">
              {notifications.map((notification) => {
                const unread = notification.readAt == null && !archived;
                const selected = notification.id === selectedId;
                const status = taskStatus(notification);
                const KindIcon = NOTIFICATION_KIND_ICON[notification.kind];
                return (
                  <button
                    key={notification.id}
                    type="button"
                    onClick={() => onSelect(notification.id)}
                    className={cn(
                      'flex w-full min-w-0 flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm transition-all hover:bg-accent',
                      selected && 'bg-muted',
                    )}
                  >
                    <div className="flex w-full min-w-0 flex-col gap-1">
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <span className={cn('min-w-0 truncate', unread ? 'font-semibold' : 'font-medium')}>
                          {senderLabel(notification)}
                        </span>
                        {unread && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-primary" />}
                        <span
                          className={cn(
                            'ml-auto shrink-0 text-xs',
                            selected ? 'text-foreground' : 'text-muted-foreground',
                          )}
                        >
                          {relativeTime(notification.createdAt)}
                        </span>
                      </div>
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-xs font-medium">
                          {notification.title || '(No title)'}
                        </span>
                        {status && <StatusBadge kind="task" status={status} className="ml-auto shrink-0" />}
                      </div>
                    </div>
                    <div className="line-clamp-2 w-full text-xs text-muted-foreground">
                      {plainSnippet(notification.body)}
                    </div>
                    <Badge
                      variant={notification.kind === 'question' ? 'default' : 'secondary'}
                      className="max-w-full truncate font-normal"
                    >
                      <KindIcon aria-hidden="true" />
                      {NOTIFICATION_KIND_LABEL[notification.kind]}
                    </Badge>
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
