import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useNotificationFeed } from '@/hooks/useNotificationFeed';
import type { NotificationFilter } from '@/lib/notifications';
import type { Notification, Task, TaskStatus } from '@/lib/types';
import { useConfig, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { usePageMeta } from '@/components/shell/page-meta';
import { ServerOffline } from '@/components/common/empty-state';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Skeleton } from '@/components/ui/skeleton';

import { NotificationDisplay } from '@/components/notifications/notification-display';
import { NotificationList } from '@/components/notifications/notification-list';
import { NotificationNav } from '@/components/notifications/notification-nav';

/**
 * Notifications - everything Rookery stores for the user.
 *
 * This route used to be company mail. Mail is gone (see
 * docs/concepts/mail-removal-notifications-and-task-activity.md); what reached
 * the user through it now arrives here as a notification: a schedule's result,
 * an agent's question about a card, a card the user asked for that ended, an
 * agent's report, what the board watcher found, the night's promotion, and
 * anything `notify` said. The same notifications go to Telegram.
 *
 * The three panes keep the mail program's shape: a collapsible rail with one
 * row per kind and the archive; a list of cards with search and an
 * All/Unread filter; and a reading pane with Markdown, links to the source
 * (task, schedule run, conversation) and, for a question, the answer box.
 *
 * `?id=<notification>` opens one - the toast's "Open" button and Telegram's
 * links use it.
 */
export function InboxPage() {
  const org = useOrgState();
  const tasksState = useTasksState();
  const { assistantName } = useConfig();

  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [archived, setArchived] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Task statuses learned from an answer, ahead of the board's own broadcast. */
  const [answeredTasks, setAnsweredTasks] = useState<Record<string, TaskStatus>>({});

  const feed = useNotificationFeed({ filter, archived, unreadOnly });
  const { notifications, markRead, markUnread, archive, restore, clearList } = feed;

  usePageMeta({ breadcrumb: [{ label: 'Notifications' }] }, []);

  const senderLabel = useCallback(
    (notification: Notification): string => {
      if (notification.fromKind === 'assistant') return assistantName;
      if (notification.fromKind === 'agent') {
        const agent = notification.fromAgentId ? org.agentById(notification.fromAgentId) : undefined;
        return agent?.name ?? 'Former agent';
      }
      return 'Rookery';
    },
    [assistantName, org],
  );

  const taskStatusOf = useCallback(
    (notification: Notification): TaskStatus | null => {
      if (!notification.taskId) return null;
      return (
        answeredTasks[notification.taskId] ??
        tasksState.tasks.find((task) => task.id === notification.taskId)?.status ??
        null
      );
    },
    [tasksState.tasks, answeredTasks],
  );

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const list = notifications ?? [];
    if (!query) return list;
    return list.filter(
      (entry) =>
        entry.title.toLowerCase().includes(query) ||
        entry.body.toLowerCase().includes(query) ||
        senderLabel(entry).toLowerCase().includes(query),
    );
  }, [notifications, search, senderLabel]);

  const selected = useMemo(
    () => (notifications ?? []).find((entry) => entry.id === selectedId) ?? null,
    [notifications, selectedId],
  );

  const select = useCallback(
    (id: string): void => {
      setSelectedId(id);
      const notification = notifications?.find((entry) => entry.id === id);
      if (notification && notification.readAt == null && notification.archivedAt == null) markRead(notification);
    },
    [notifications, markRead],
  );

  const selectFilter = useCallback(
    (next: NotificationFilter, nextArchived: boolean): void => {
      setFilter(next);
      setArchived(nextArchived);
      setSelectedId(null);
      clearList();
    },
    [clearList],
  );

  const toggleRead = useCallback((): void => {
    if (!selected) return;
    if (selected.readAt == null) markRead(selected);
    else markUnread(selected);
  }, [selected, markRead, markUnread]);

  const toggleArchived = useCallback((): void => {
    if (!selected) return;
    setSelectedId(null);
    if (selected.archivedAt == null) archive(selected.id);
    else restore(selected.id);
  }, [selected, archive, restore]);

  const onAnswered = useCallback((task: Task): void => {
    setAnsweredTasks((current) => ({ ...current, [task.id]: task.status }));
  }, []);

  const widenView = useCallback(
    (toArchive: boolean): void => {
      setUnreadOnly(false);
      selectFilter('all', toArchive);
    },
    [selectFilter],
  );

  useNotificationDeepLink({ notifications, view: { filter, unreadOnly, archived }, select, widenView });

  if (feed.offline) {
    return (
      <Fade asChild>
        <div className="p-4 lg:p-6">
          <ServerOffline onRetry={() => void feed.load()} />
        </div>
      </Fade>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* `flex`: through this wrapper the rail keeps stretching to full height. */}
      <Fade className="flex shrink-0">
        <NotificationNav
          filter={filter}
          archived={archived}
          onSelect={selectFilter}
          unread={feed.unreadCounts}
          collapsed={navCollapsed}
          onCollapsedChange={setNavCollapsed}
        />
      </Fade>

      {/* `min-w-0`: without it a long unwrapped line stretches the panel group
          past the window and defeats every `truncate`. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize="38" minSize="24">
            <Fade className="h-full min-h-0 w-full min-w-0" delay={50}>
              {notifications === null ? (
                <div className="flex flex-col gap-3 p-4">
                  <Skeleton className="h-24 w-full" />
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : (
                <NotificationList
                  notifications={visible}
                  selectedId={selected?.id ?? null}
                  onSelect={select}
                  filter={filter}
                  archived={archived}
                  unreadOnly={unreadOnly}
                  onUnreadOnlyChange={setUnreadOnly}
                  onMarkAllRead={feed.unreadInView.length > 0 ? feed.markAllRead : undefined}
                  search={search}
                  onSearch={setSearch}
                  senderLabel={senderLabel}
                  taskStatus={taskStatusOf}
                />
              )}
            </Fade>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize="62" minSize="30">
            <Fade className="h-full min-h-0 w-full min-w-0" delay={100}>
              <NotificationDisplay
                notification={selected}
                senderLabel={selected ? senderLabel(selected) : null}
                taskStatus={selected ? taskStatusOf(selected) : null}
                onToggleRead={toggleRead}
                onToggleArchived={toggleArchived}
                onAnswered={onAnswered}
              />
            </Fade>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

type DeepLinkStep = 'view' | 'all' | 'archive';

/**
 * `?id=<id>` opens one notification. When the open view does not hold it -
 * a filter, the Unread tab, or it was archived - the view widens once to
 * All, then to the archive, before giving up.
 */
function useNotificationDeepLink({
  notifications,
  view,
  select,
  widenView,
}: {
  notifications: Notification[] | null;
  view: { filter: NotificationFilter; unreadOnly: boolean; archived: boolean };
  select(id: string): void;
  /** Switches the list to All, or to the archive. */
  widenView(toArchive: boolean): void;
}): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const idParam = searchParams.get('id');
  const step = useRef<DeepLinkStep>('view');
  const { filter, unreadOnly, archived } = view;

  useEffect(() => {
    step.current = 'view';
  }, [idParam]);

  useEffect(() => {
    if (!idParam || notifications === null) return;
    const clearParam = (): void =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('id');
          return next;
        },
        { replace: true },
      );

    const found = notifications.find((entry) => entry.id === idParam);
    if (found) {
      select(found.id);
      clearParam();
    } else if (step.current === 'view' && (filter !== 'all' || unreadOnly || archived)) {
      step.current = 'all';
      widenView(false);
    } else if (step.current !== 'archive' && !archived) {
      step.current = 'archive';
      widenView(true);
    } else {
      clearParam();
    }
  }, [idParam, notifications, filter, unreadOnly, archived, select, widenView, setSearchParams]);
}
