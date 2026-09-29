import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { NotificationFilter } from '@/lib/notifications';
import type { Notification, Task, TaskStatus } from '@/lib/types';
import {
  useConfig,
  useConnection,
  useNotificationState,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
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
  const { socket } = useConnection();
  const badge = useNotificationState();

  const [searchParams, setSearchParams] = useSearchParams();
  const idParam = searchParams.get('id');

  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [archived, setArchived] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [unreadList, setUnreadList] = useState<Notification[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Task statuses learned from an answer, ahead of the board's own broadcast. */
  const [answeredTasks, setAnsweredTasks] = useState<Record<string, TaskStatus>>({});

  usePageMeta({ breadcrumb: [{ label: 'Notifications' }] }, []);

  /* --------------------------------- load ---------------------------------- */

  // Sequence guard: switching the kind starts a new load while the old one
  // may still be out; only the newest run may write state.
  const loadSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current;
    try {
      const [list, unread] = await Promise.all([
        api.notifications({
          ...(filter === 'all' ? {} : { kind: filter }),
          ...(archived ? { archived: true } : {}),
          ...(unreadOnly && !archived ? { unread: true } : {}),
          limit: 200,
        }),
        api.notifications({ unread: true, limit: 500 }),
      ]);
      if (seq !== loadSeq.current) return;
      setNotifications(list);
      setUnreadList(unread);
      setOffline(false);
    } catch {
      if (seq !== loadSeq.current) return;
      setOffline(true);
    }
  }, [filter, archived, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => socket.onNotification(() => void load()), [socket, load]);

  // Read state changed elsewhere - the "Read" button under a Telegram push.
  useEffect(
    () =>
      socket.onChanged((change) => {
        if (change.kind === 'notifications') void load();
      }),
    [socket, load],
  );

  /** Unread per kind, and in total under `all`, for the rail. */
  const unreadCounts = useMemo(() => {
    if (!unreadList) return null;
    const counts: Partial<Record<NotificationFilter, number>> = { all: unreadList.length };
    for (const entry of unreadList) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
    return counts;
  }, [unreadList]);

  /* -------------------------------- naming --------------------------------- */

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

  /* -------------------------------- filter --------------------------------- */

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

  /* -------------------------------- actions -------------------------------- */

  /** Writes one read mark into both loaded lists, ahead of the server. */
  const patchRead = useCallback((notification: Notification, read: boolean): void => {
    const { readAt: _readAt, ...rest } = notification;
    const next: Notification = read ? { ...rest, readAt: Date.now() } : rest;
    setNotifications((current) => current?.map((entry) => (entry.id === next.id ? next : entry)) ?? null);
    setUnreadList((current) => {
      if (!current) return current;
      const others = current.filter((entry) => entry.id !== next.id);
      return read ? others : [...others, next];
    });
  }, []);

  const setRead = useCallback(
    (notification: Notification, read: boolean): void => {
      patchRead(notification, read);
      void api
        .markNotificationsRead({ ids: [notification.id], read })
        .then(() => void badge.refresh())
        .catch((caught: unknown) => reportFailure(read ? 'Mark as read' : 'Mark as unread', caught));
    },
    [patchRead, badge],
  );

  const select = useCallback(
    (id: string): void => {
      setSelectedId(id);
      const notification = notifications?.find((entry) => entry.id === id);
      if (notification && notification.readAt == null && notification.archivedAt == null) setRead(notification, true);
    },
    [notifications, setRead],
  );

  const selectFilter = useCallback((next: NotificationFilter, nextArchived: boolean): void => {
    setFilter(next);
    setArchived(nextArchived);
    setSelectedId(null);
    setNotifications(null);
  }, []);

  const toggleRead = useCallback((): void => {
    if (selected) setRead(selected, selected.readAt == null);
  }, [selected, setRead]);

  /** Archiving files it away (and reads it); from the archive it moves back. */
  const toggleArchived = useCallback((): void => {
    if (!selected) return;
    const archive = selected.archivedAt == null;
    const id = selected.id;
    setNotifications((current) => current?.filter((entry) => entry.id !== id) ?? null);
    setUnreadList((current) => current?.filter((entry) => entry.id !== id) ?? null);
    setSelectedId(null);
    void api
      .archiveNotification(id, archive)
      .then(() => {
        toast(archive ? 'Notification archived' : 'Moved back to notifications');
        void badge.refresh();
      })
      .catch((caught: unknown) => {
        reportFailure(archive ? 'Archive' : 'Restore', caught);
        void load();
      });
  }, [selected, badge, load]);

  const unreadInView = useMemo(
    () => (unreadList ?? []).filter((entry) => filter === 'all' || entry.kind === filter),
    [unreadList, filter],
  );

  const markAllRead = useCallback((): void => {
    const ids = unreadInView.map((entry) => entry.id);
    if (ids.length === 0) return;
    const now = Date.now();
    const idSet = new Set(ids);
    setNotifications(
      (current) => current?.map((entry) => (idSet.has(entry.id) ? { ...entry, readAt: now } : entry)) ?? null,
    );
    setUnreadList((current) => current?.filter((entry) => !idSet.has(entry.id)) ?? null);
    void api
      .markNotificationsRead(filter === 'all' ? { all: true } : { ids })
      .then(() => void badge.refresh())
      .catch((caught: unknown) => {
        reportFailure('Mark all read', caught);
        void load();
      });
  }, [unreadInView, filter, badge, load]);

  const onAnswered = useCallback((task: Task): void => {
    setAnsweredTasks((current) => ({ ...current, [task.id]: task.status }));
  }, []);

  /* ------------------------------- deep link ------------------------------- */

  // `?id=<id>` opens one notification. When the open view does not hold it -
  // a filter, the Unread tab, or it was archived - the view widens once to
  // All, then to the archive, before giving up.
  const deepLinkStep = useRef<'view' | 'all' | 'archive'>('view');
  useEffect(() => {
    deepLinkStep.current = 'view';
  }, [idParam]);

  useEffect(() => {
    if (!idParam || notifications === null) return;
    const found = notifications.find((entry) => entry.id === idParam);
    const clear = (): void =>
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('id');
          return next;
        },
        { replace: true },
      );
    if (found) {
      select(found.id);
      clear();
      return;
    }
    if (deepLinkStep.current === 'view' && (filter !== 'all' || unreadOnly || archived)) {
      deepLinkStep.current = 'all';
      setUnreadOnly(false);
      selectFilter('all', false);
      return;
    }
    if (deepLinkStep.current !== 'archive' && !archived) {
      deepLinkStep.current = 'archive';
      selectFilter('all', true);
      return;
    }
    clear();
  }, [idParam, notifications, filter, unreadOnly, archived, select, selectFilter, setSearchParams]);

  /* --------------------------------- render -------------------------------- */

  if (offline) {
    return (
      <Fade asChild>
        <div className="p-4 lg:p-6">
          <ServerOffline onRetry={() => void load()} />
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
          unread={unreadCounts}
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
                  onMarkAllRead={unreadInView.length > 0 ? markAllRead : undefined}
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
