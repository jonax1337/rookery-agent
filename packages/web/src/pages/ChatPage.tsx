import * as React from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  AudioLinesIcon,
  BadgeAlertIcon as TriangleAlertIcon,
  DeleteIcon as Trash2Icon,
  MessageSquareIcon as MessagesSquareIcon,
  PenToolIcon as PencilIcon,
  RotateCcwIcon,
} from "@/components/icons";
import { toast } from 'sonner';

import { fetchOpenQuestions } from '@/hooks/useChat';
import { api, ApiError } from '@/lib/api';
import { failureMessage, reportFailure } from '@/lib/errors';
import { greeting, NO_PROJECT, UNTITLED_SESSION } from '@/lib/format';
import { SESSION_TITLE_MAX, sessionTitleSchema } from '@/lib/session';
import {
  useAllSessionsState,
  useChatSession,
  useConfig,
  useConnection,
  useOrgState,
  useSessionsState,
} from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';

import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, EmptyStateGreeting } from '@/components/assistant-ui/elements/empty-state';
import { MemoryRecallToolUI } from '@/components/assistant-ui/elements/memory-call';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { AssignmentTerminal } from '@/components/common/assignment-terminal';
import { LiveRunList } from '@/components/common/live-run-list';
import { QuestionCard } from '@/components/common/question-card';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { collectErrors, FormField } from '@/components/forms/form-kit';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';

/**
 * The chat hub.
 *
 * The thread itself is stock assistant-ui and stays that way: what is written
 * and how it is sent are the composer's business, and the four turn controls
 * (Project, Permission, Model, Effort) live inside it because they are
 * parameters of the *next* message. This file only frames it.
 *
 * What the frame adds is everything a conversation needs that is not a
 * message: the header says which conversation is open and carries its
 * actions, the empty thread says hello with a way to start, the assignments a
 * turn hands out sit above the transcript, and a failed turn says so instead
 * of leaving the composer looking idle.
 */

export function ChatPage() {
  const navigate = useNavigate();
  const { chat, turn } = useChatSession();
  const { assistantName, config } = useConfig();
  const org = useOrgState();
  const { socket } = useConnection();
  const sessions = useSessionsState();
  const allSessions = useAllSessionsState();
  const { confirm, dialog } = useConfirm();
  // The stop button of `LiveRunList` asks the same question on every page that
  // renders it; this is where the question lives.
  const { dialog: cancelDialog, cancelAssignment } = useCancelAssignment();

  const activeId = sessions.activeId;
  // The hub's own list holds only fifty rows of one counterpart and no spoken
  // conversation at all, so a thread opened by link would lose its name and
  // its kind-dependent actions. The shared list knows every conversation
  // there is; the hub's list is only the fresher of the two.
  const session =
    sessions.sessions.find((entry) => entry.id === activeId) ??
    allSessions.sessionById(activeId ?? undefined);
  const title = session?.title || (activeId ? 'Conversation' : UNTITLED_SESSION);

  /* ------------------------------- actions ------------------------------- */

  const [renameOpen, setRenameOpen] = React.useState(false);

  // The live terminal of one of this turn's runs. Kept only while the run is
  // actually going: the log is live-only, so once the run ends there is
  // nothing left to watch - the result arrives in the transcript.
  const [watchId, setWatchId] = React.useState<string | null>(null);
  const watched = chat.assignments.find(
    (entry) => entry.id === watchId && (entry.status === 'running' || entry.status === 'pending'),
  );

  const confirmReset = React.useCallback(async () => {
    if (!activeId) return;
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
      await api.resetSession(activeId);
      // The transcript on screen is the one this page is showing, so it has to
      // go with it - otherwise the thread keeps answering into a history the
      // server no longer has.
      chat.reset();
      void sessions.refresh();
      // `/chats` and the rail's badge read the shared list; a reset sends no
      // `changed` of its own, so they are told by hand.
      void allSessions.refresh();
      toast('Conversation reset');
    } catch (caught) {
      reportFailure('Reset', caught);
    }
  }, [activeId, allSessions, chat, confirm, sessions]);

  const confirmDelete = React.useCallback(async () => {
    if (!activeId) return;
    const ok = await confirm({
      title: 'Delete conversation?',
      description: 'This conversation and all its messages will be deleted.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await sessions.remove(activeId);
      chat.reset();
      void allSessions.refresh();
      toast('Conversation deleted');
      void navigate('/chats');
    } catch (caught) {
      reportFailure('Delete', caught);
    }
  }, [activeId, allSessions, chat, confirm, navigate, sessions]);

  /* ------------------------------ other tabs ------------------------------ */

  // A rename or a deletion in another tab arrives as the session's `changed`
  // broadcast. The shared list refetches on every `changed` by itself; the
  // open thread does not, so it is rechecked here. A rename refreshes the
  // hub's own slice, a deletion leaves for `/chats` the way this page's own
  // delete does, rather than keep answering into a session the server no
  // longer has.
  const refreshThreads = sessions.refresh;
  const dropActiveThread = sessions.setActiveId;
  const resetTranscript = chat.reset;
  React.useEffect(() => {
    if (!activeId) return;
    let disposed = false;
    const unsubscribe = socket.onChanged((change) => {
      if (change.kind !== 'session' || change.id !== activeId) return;
      void api
        .session(activeId)
        .then(() => {
          if (!disposed) void refreshThreads();
        })
        .catch((caught: unknown) => {
          // Anything but a definite "gone" is no reason to leave, and once
          // this page is gone there is nothing left to navigate.
          if (disposed) return;
          if (!(caught instanceof ApiError) || caught.status !== 404) return;
          dropActiveThread(null);
          resetTranscript();
          // Replace, not push: in the tab that deleted, this races its own
          // navigation to `/chats`, and a second entry for the same path
          // would dead-end the Back button.
          void navigate('/chats', { replace: true });
        });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [activeId, dropActiveThread, navigate, refreshThreads, resetTranscript, socket]);

  /* ------------------------------ questions ------------------------------- */

  // A question belongs to no one conversation. The turn waiting on it may
  // have been started in another window or on the phone, so it arrives as a
  // broadcast beside the turn's own stream, and answering it here is what
  // lets that turn carry on.
  //
  // A reload has missed every frame sent before it, which is what
  // `GET /api/questions` is for. It runs again on each reconnect: a socket
  // that was away may have missed the question outright, and one that was
  // never open has nothing to have missed.
  const openQuestion = chat.openQuestion;
  const closeQuestion = chat.closeQuestion;
  React.useEffect(() => {
    let disposed = false;
    const load = (): void => {
      void fetchOpenQuestions()
        .then((open) => {
          if (disposed) return;
          for (const question of open) openQuestion(question);
        })
        .catch(() => {
          // An unreachable server says so loudly enough elsewhere, and a
          // failed load means only that no card appears.
        });
    };
    // `onStatus` reports the current status straight away, so an open socket
    // loads at once and every later reconnect loads again.
    const stopStatus = socket.onStatus((status) => {
      if (status === 'open') load();
    });
    const stopQuestion = socket.onQuestion(openQuestion);
    const stopClosed = socket.onQuestionClosed((event) => closeQuestion(event.id));
    return () => {
      disposed = true;
      stopStatus();
      stopQuestion();
      stopClosed();
    };
  }, [closeQuestion, openQuestion, socket]);

  /* ------------------------------- rejoining ------------------------------- */

  // Whatever turn is already running in this conversation keeps running, and
  // a reload - or opening it in a second tab - joins it rather than staring
  // at an idle screen next to background work: the journal rebuilds what
  // already happened, the socket attach continues the stream from there. The
  // socket re-arms the attach itself on reconnect; leaving the conversation
  // stops the following, never the turn.
  const attach = chat.attach;
  React.useEffect(() => {
    if (!activeId) return;
    void attach(activeId);
    return () => socket.detachConversation(activeId);
  }, [activeId, attach, socket]);

  /* -------------------------------- meta --------------------------------- */

  // Without an open conversation there is nothing to rename, reset or delete,
  // so the menu is absent rather than disabled.
  usePageMeta(
    {
      breadcrumb: [{ label: 'Conversations', to: '/chats' }, { label: title }],
      actions: activeId ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton tone="header" label="More actions" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <PencilIcon />
              Rename
            </DropdownMenuItem>

            {/* Every open conversation can be carried on hands-free; a
                spoken one is simply going back to where it started. */}
            <DropdownMenuItem onSelect={() => void navigate('/voice?session=' + activeId)}>
              <AudioLinesIcon />
              {session?.kind === 'voice' ? 'Continue voice conversation' : 'Continue in voice mode'}
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Assign project</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {/* The same choice the composer's Project pill makes, through
                    the same call - the two can never disagree. */}
                <DropdownMenuRadioGroup
                  value={turn.projectId ?? NO_PROJECT}
                  onValueChange={(value) =>
                    turn.chooseProject(value === NO_PROJECT ? null : value)
                  }
                >
                  <DropdownMenuRadioItem value={NO_PROJECT}>No project</DropdownMenuRadioItem>
                  {org.projects
                    .filter((entry) => !entry.archived || entry.id === turn.projectId)
                    .map((entry) => (
                      <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                        {entry.name}
                      </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem onSelect={() => void confirmReset()}>
              <RotateCcwIcon />
              Reset
            </DropdownMenuItem>

            <DropdownMenuItem asChild>
              <NavLink to="/chats">
                <MessagesSquareIcon />
                View conversations
              </NavLink>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void confirmDelete()}>
              <Trash2Icon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
    [
      activeId,
      session?.kind,
      turn.projectId,
      turn.chooseProject,
      org.projects,
      confirmReset,
      confirmDelete,
      navigate,
    ],
  );

  /* ------------------------------- welcome ------------------------------- */

  // Identity changes update the welcome; typing keeps the same component.
  const components = React.useMemo<ThreadComponents>(
    () => ({
      Welcome: () => (
        <Fade asChild>
          <EmptyState className="mx-auto mb-8 max-w-none gap-4">
            <Fade asChild>
              <div className="flex items-center gap-3 text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
                <span aria-hidden="true" className="h-px w-6 bg-border" />
                {assistantName}
                <span aria-hidden="true" className="h-px w-6 bg-border" />
              </div>
            </Fade>
            {/* The greeting keeps its own CSS entrance, so the blur stays on
                a wrapper - no element animates twice. */}
            <Blur delay={50}>
              <EmptyStateGreeting className="font-heading text-4xl leading-[1.1] tracking-[-0.035em] text-balance sm:text-5xl">
                {greeting(new Date(), { honorific: config?.honorific, userName: config?.userName })}
              </EmptyStateGreeting>
            </Blur>
            <Fade asChild delay={100}>
              <p className="max-w-sm text-center text-sm leading-relaxed text-muted-foreground">
                A thought, a plan, or a fresh start. What’s on your mind?
              </p>
            </Fade>
          </EmptyState>
        </Fade>
      ),
    }),
    [assistantName, config?.honorific, config?.userName],
  );

  /* -------------------------------- page --------------------------------- */

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {dialog}
      {cancelDialog}

      {/* Inline, in the page's own band above the thread - never a modal.
          AGENTS.md wants real surfaces, and a dialog would lock the whole app
          for as long as a turn waits, which may be minutes. The band is the
          one place this page can put a surface that is always in view: the
          composer itself lives inside `thread.aui.tsx`, which has no slot
          above its input. */}
      {chat.questions.length > 0 && (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-4">
          {chat.questions.map((question) => (
            <QuestionCard
              key={question.id}
              question={question}
              onAnswer={(reply) => chat.answerQuestion(question.id, reply)}
              onExpire={() => chat.closeQuestion(question.id)}
            />
          ))}
        </div>
      )}

      {chat.assignments.length > 0 && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4">
          <Fade>
            <LiveRunList
              assignments={chat.assignments}
              onCancel={(id) => void cancelAssignment(id)}
              onWatch={setWatchId}
            />
          </Fade>
          {watched ? (
            <AssignmentTerminal assignmentId={watched.id} status={watched.status} className="mt-2" />
          ) : null}
        </div>
      )}

      {chat.error && (
        // The toast that `RookeryProvider` raises is gone in five seconds and
        // carries the way to try again; this stays until the next turn, so
        // the composer is never idle for a reason nobody can see any more.
        <div className="mx-auto w-full max-w-3xl px-4 pt-4">
          <Fade>
            <Item variant="outline" size="sm" className="border-destructive/50 items-start">
              <ItemMedia>
                <TriangleAlertIcon className="text-destructive" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="text-destructive">The turn failed</ItemTitle>
                <ItemDescription className="text-foreground">{chat.error}</ItemDescription>
              </ItemContent>
            </Item>
          </Fade>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        {/* Draws nothing itself: it registers who renders the memories a turn
            was given, which the transcript carries as a part of its own. */}
        <MemoryRecallToolUI />
        <Thread components={components} />
      </div>

      <RenameDialog
        open={renameOpen}
        onOpenChange={setRenameOpen}
        title={session?.title ?? ''}
        onRename={async (next) => {
          await sessions.rename(activeId ?? '', next);
          await allSessions.refresh();
        }}
      />

      <span className="sr-only">Conversation with {assistantName}</span>
    </div>
  );
}

/* ------------------------------ the renaming ------------------------------ */

interface RenameDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The stored title, which the field starts from each time it opens. */
  title: string;
  onRename(title: string): Promise<unknown>;
}

/**
 * Rename the open conversation.
 *
 * A dialog rather than an inline field because the title lives in the header,
 * and an input that appears inside a breadcrumb is a target nobody hits. The
 * rule - something, and not more than `SESSION_TITLE_MAX` characters - is the
 * client's own; the server only insists on "not empty". It is shared with the
 * conversations list so the same title is accepted in both places.
 */
function RenameDialog({ open, onOpenChange, title, onRename }: RenameDialogProps) {
  const [value, setValue] = React.useState(title);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Each opening starts from what is stored; a refetch while the dialog is
  // open must not pull the caret back.
  React.useEffect(() => {
    if (!open) return;
    setValue(title);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const parsed = sessionTitleSchema.safeParse({ title: value });
    if (!parsed.success) {
      setError(collectErrors(parsed.error).title ?? null);
      return;
    }
    setSaving(true);
    try {
      await onRename(parsed.data.title);
      onOpenChange(false);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
            <DialogDescription>
              This name appears in the conversation list and page header.
            </DialogDescription>
          </DialogHeader>

          {/* FormField verdrahtet Label, Eingabe und Meldung: ohne
              `aria-describedby` hört jemand, der nach der Ablehnung zurück ins
              Feld tabbt, nur noch dessen Namen. */}
          <FormField id="gespraech-titel" label="Title" error={error} className="py-4">
            {(control) => (
              <Input
                {...control}
                value={value}
                autoFocus
                maxLength={SESSION_TITLE_MAX}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
              />
            )}
          </FormField>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
