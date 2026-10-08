import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { NotificationFilter } from '@/lib/notifications';
import type { Notification } from '@/lib/types';
import { useConnection, useNotificationState } from '@/providers/rookery-provider';

/** Notifications the open view lists. */
const VIEW_LIMIT = 200;
/** Unread ones feed the rail's counts and "mark all read", whatever the view. */
const UNREAD_LIMIT = 500;

export interface NotificationView {
  filter: NotificationFilter;
  archived: boolean;
  unreadOnly: boolean;
}

/**
 * The notifications of one view, and the unread ones behind it.
 *
 * Every change a person makes is written into both loaded lists first and
 * sent to the server after, so the list answers at once; a failed request
 * says so, and the archive and mark-all actions reload to undo their guess.
 */
export function useNotificationFeed({ filter, archived, unreadOnly }: NotificationView) {
  const { socket } = useConnection();
  const badge = useNotificationState();
  const [notifications, setNotifications] = useState<Notification[] | null>(null);
  const [unreadList, setUnreadList] = useState<Notification[] | null>(null);
  const [offline, setOffline] = useState(false);

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
          limit: VIEW_LIMIT,
        }),
        api.notifications({ unread: true, limit: UNREAD_LIMIT }),
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

  const unreadInView = useMemo(
    () => (unreadList ?? []).filter((entry) => filter === 'all' || entry.kind === filter),
    [unreadList, filter],
  );

  /** Drops the list, so the view shows its loading state until the next load lands. */
  const clearList = useCallback(() => setNotifications(null), []);

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

  const markRead = useCallback((notification: Notification): void => setRead(notification, true), [setRead]);
  const markUnread = useCallback((notification: Notification): void => setRead(notification, false), [setRead]);

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

  /** Moves one notification out of the open view and tells the server. */
  const moveOutOfView = useCallback(
    (id: string, intoArchive: boolean): void => {
      setNotifications((current) => current?.filter((entry) => entry.id !== id) ?? null);
      setUnreadList((current) => current?.filter((entry) => entry.id !== id) ?? null);
      void api
        .archiveNotification(id, intoArchive)
        .then(() => {
          toast(intoArchive ? 'Notification archived' : 'Moved back to notifications');
          void badge.refresh();
        })
        .catch((caught: unknown) => {
          reportFailure(intoArchive ? 'Archive' : 'Restore', caught);
          void load();
        });
    },
    [badge, load],
  );

  /** Files it away (and reads it). */
  const archive = useCallback((id: string): void => moveOutOfView(id, true), [moveOutOfView]);
  /** From the archive it moves back. */
  const restore = useCallback((id: string): void => moveOutOfView(id, false), [moveOutOfView]);

  return {
    notifications,
    offline,
    unreadCounts,
    unreadInView,
    load,
    clearList,
    markRead,
    markUnread,
    markAllRead,
    archive,
    restore,
  };
}
