import { useCallback, type ReactElement } from 'react';
import { toast } from 'sonner';

import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { RotateCcwIcon } from '@/components/icons';
import { reportFailure } from '@/lib/errors';
import { NO_PROJECT, UNTITLED_SESSION } from '@/lib/format';
import type { Session } from '@/lib/types';
import {
  useAllSessionsState,
  useChatSession,
  useSessionsState,
} from '@/providers/rookery-provider';

interface OpenThreadEffect {
  /** The conversation is gone: the hub must leave it. */
  dropped?: boolean;
  /** The transcript was emptied: the hub must forget the messages it holds. */
  cleared?: boolean;
}

export interface ConversationActions {
  assignProject(session: Session, projectId: string): void;
  setArchived(session: Session, archived: boolean): void;
  rename(id: string, title: string): Promise<Session>;
  confirmReset(session: Session): Promise<void>;
  confirmDelete(session: Session): Promise<void>;
  deleteSelected(rows: Session[], clearSelection: () => void): Promise<void>;
  /** Both confirmation dialogs; render them once in the owning component. */
  confirmDialog: ReactElement;
  bulkDialog: ReactElement;
}

/**
 * Everything a person can do to a conversation row, with the confirmations
 * and toasts that go with it.
 *
 * `onDeleted` lets the caller drop whatever it shows for that conversation
 * (an open drawer, say) once the server has really let go of it.
 */
export function useConversationActions(onDeleted: (id: string) => void): ConversationActions {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { run: runBulk, dialog: bulkDialog } = useBulkAction();
  const { chat } = useChatSession();
  const { update, reset, remove } = useAllSessionsState();
  // The chat hub holds its own slice and its own active thread. A row mutated
  // here is very possibly the conversation that is open behind this page, so
  // it has to be told - the `changed` broadcast both routes send reaches the
  // shared list, not the hub's own slice.
  const openThread = useSessionsState();

  /**
   * Keep the open conversation in step with a row this page just changed.
   *
   * The `changed` broadcast these routes send only refetches the shared list -
   * the hub's slice and its active thread are still told by hand, here. So a
   * deletion here would leave the hub answering into a session the server no
   * longer has, and a rename would never reach its header.
   */
  const syncOpenThread = useCallback(
    (id: string, effect: OpenThreadEffect = {}) => {
      if (openThread.activeId === id) {
        if (effect.dropped) openThread.setActiveId(null);
        if (effect.dropped || effect.cleared) chat.reset();
      }
      void openThread.refresh();
    },
    [chat, openThread],
  );

  const assignProject = useCallback(
    (session: Session, projectId: string) => {
      void update(session.id, { projectId: projectId === NO_PROJECT ? null : projectId }).catch(
        (caught: unknown) => reportFailure('Set project', caught),
      );
    },
    [update],
  );

  const setArchived = useCallback(
    (session: Session, archived: boolean) => {
      void update(session.id, { archived })
        .then(() => toast(archived ? 'Conversation archived' : 'Conversation restored'))
        .catch((caught: unknown) => reportFailure(archived ? 'Archive' : 'Restore', caught));
    },
    [update],
  );

  const rename = useCallback(
    async (id: string, title: string): Promise<Session> => {
      const renamed = await update(id, { title });
      syncOpenThread(id);
      return renamed;
    },
    [update, syncOpenThread],
  );

  const confirmReset = useCallback(
    async (session: Session) => {
      const ok = await confirm({
        title: 'Reset conversation?',
        description:
          'All messages in this conversation will be removed. The title, project, and counterpart will remain.',
        confirmLabel: 'Reset',
        destructive: true,
        icon: RotateCcwIcon,
      });
      if (!ok) return;
      try {
        await reset(session.id);
        syncOpenThread(session.id, { cleared: true });
        toast('Conversation reset');
      } catch (caught) {
        reportFailure('Reset', caught);
      }
    },
    [confirm, reset, syncOpenThread],
  );

  const confirmDelete = useCallback(
    async (session: Session) => {
      const ok = await confirm({
        title: 'Delete conversation?',
        description: 'This conversation and all its messages will be deleted.',
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
      try {
        await remove(session.id);
        onDeleted(session.id);
        syncOpenThread(session.id, { dropped: true });
        toast('Conversation deleted');
      } catch (caught) {
        reportFailure('Delete', caught);
      }
    },
    [confirm, remove, onDeleted, syncOpenThread],
  );

  const deleteSelected = useCallback(
    async (rows: Session[], clearSelection: () => void) => {
      await runBulk({
        rows,
        noun: { singular: 'Conversation', plural: 'Conversations' },
        nameOf: (session) => session.title || UNTITLED_SESSION,
        verb: 'delete',
        done: 'deleted',
        confirmLabel: 'Delete',
        description: 'The selected conversations and all their messages will be deleted.',
        run: async (session) => {
          await remove(session.id);
          syncOpenThread(session.id, { dropped: true });
        },
        clear: clearSelection,
      });
    },
    [runBulk, remove, syncOpenThread],
  );

  return {
    assignProject,
    setArchived,
    rename,
    confirmReset,
    confirmDelete,
    deleteSelected,
    confirmDialog,
    bulkDialog,
  };
}
