import * as React from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  AudioLinesIcon,
  BadgeAlertIcon as TriangleAlertIcon,
  DeleteIcon as Trash2Icon,
  MessageSquareIcon as MessagesSquareIcon,
  PenToolIcon as PencilIcon,
  RotateCcwIcon,
  TerminalIcon,
} from "@/components/icons";
import { toast } from 'sonner';

import { useChatMode, useQuestionFeed, useRejoinedTurn, useRemoteSessionChanges, type ChatMode } from '@/hooks/useChatThread';
import { api } from '@/lib/api';
import { failureMessage, reportFailure } from '@/lib/errors';
import { greeting, NO_PROJECT, UNTITLED_SESSION } from '@/lib/format';
import { SESSION_TITLE_MAX, sessionTitleSchema } from '@/lib/session';
import { FILLED_TOGGLE_ITEM_CLASS } from '@/lib/toggle-styles';
import type { Project } from '@/lib/types';
import {
  useAllSessionsState,
  useChatSession,
  useConfig,
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
import { RunTerminal } from '@/components/common/run-terminal';
import { LiveRunList } from '@/components/common/live-run-list';
import { QuestionCard } from '@/components/common/question-card';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { collectErrors, FormField } from '@/components/forms/form-kit';

import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
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

  useRemoteSessionChanges(activeId);
  useQuestionFeed();
  useRejoinedTurn(activeId);
  const { mode, opening, openTerminal, backToChat } = useChatMode(activeId);

  // Without an open conversation there is nothing to rename, reset or delete,
  // so the menu is absent rather than disabled.
  usePageMeta(
    {
      breadcrumb: [{ label: 'Conversations', to: '/chats' }, { label: title }],
      actions: (
        <div className="flex items-center gap-2">
          <ChatModeSwitch
            mode={mode}
            disabled={opening}
            onOpenTerminal={() => void openTerminal()}
            onBackToChat={() => void backToChat()}
          />
          {activeId ? (
            <ConversationMenu
              isVoice={session?.kind === 'voice'}
              projects={org.projects}
              projectId={turn.projectId}
              onChooseProject={turn.chooseProject}
              onRename={() => setRenameOpen(true)}
              onContinueInVoice={() => void navigate('/voice?session=' + activeId)}
              onReset={() => void confirmReset()}
              onDelete={() => void confirmDelete()}
            />
          ) : null}
        </div>
      ),
    },
    [
      mode,
      opening,
      openTerminal,
      backToChat,
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

  // Identity changes update the welcome; typing keeps the same component.
  const components = React.useMemo<ThreadComponents>(
    () => ({
      Welcome: () => (
        <Fade asChild>
          <EmptyState className="mx-auto mb-8 max-w-none gap-4">
            <Fade asChild>
              <div className="flex items-center gap-3 font-mono text-xs font-medium tracking-[0.16em] text-muted-foreground uppercase">
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

      {mode === 'terminal' && activeId ? (
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <RunTerminal
            key={activeId}
            assignmentId={'chat:' + activeId}
            showHeader={false}
            autoFocus
            className="min-h-0 flex-1"
            fallback={
              <ClosedTerminalCard
                title="The terminal is closed"
                description="It was closed or sat unused for an hour. Everything said in it is in this conversation."
                onReopen={() => void openTerminal()}
                onChat={() => void backToChat()}
                busy={opening}
              />
            }
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* Draws nothing itself: it registers who renders the memories a turn
              was given, which the transcript carries as a part of its own. */}
          <MemoryRecallToolUI />
          <Thread components={components} />
        </div>
      )}

      {activeId ? (
        <RenameDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          title={session?.title ?? ''}
          onRename={async (next) => {
            await sessions.rename(activeId, next);
            await allSessions.refresh();
          }}
        />
      ) : null}

      <span className="sr-only">Conversation with {assistantName}</span>
    </div>
  );
}

function ChatModeSwitch({
  mode,
  disabled,
  onOpenTerminal,
  onBackToChat,
}: {
  mode: ChatMode;
  disabled: boolean;
  onOpenTerminal(): void;
  onBackToChat(): void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={mode}
      disabled={disabled}
      onValueChange={(value) => {
        if (value === 'terminal' && mode !== 'terminal') onOpenTerminal();
        else if (value === 'chat' && mode !== 'chat') onBackToChat();
      }}
      aria-label="Conversation mode"
    >
      <ToggleGroupItem value="chat" aria-label="Chat" className={FILLED_TOGGLE_ITEM_CLASS}>
        <MessagesSquareIcon />
        Chat
      </ToggleGroupItem>
      <ToggleGroupItem value="terminal" aria-label="Claude Code terminal" className={FILLED_TOGGLE_ITEM_CLASS}>
        <TerminalIcon />
        Terminal
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

interface ConversationMenuProps {
  isVoice: boolean;
  projects: readonly Project[];
  projectId: string | undefined;
  onChooseProject(projectId: string | null): void;
  onRename(): void;
  onContinueInVoice(): void;
  onReset(): void;
  onDelete(): void;
}

function ConversationMenu({
  isVoice,
  projects,
  projectId,
  onChooseProject,
  onRename,
  onContinueInVoice,
  onReset,
  onDelete,
}: ConversationMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton tone="header" label="More actions" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onRename}>
          <PencilIcon />
          Rename
        </DropdownMenuItem>

        {/* Every open conversation can be carried on hands-free; a
            spoken one is simply going back to where it started. */}
        <DropdownMenuItem onSelect={onContinueInVoice}>
          <AudioLinesIcon />
          {isVoice ? 'Continue voice conversation' : 'Continue in voice mode'}
        </DropdownMenuItem>

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Assign project</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-52">
            {/* The same choice the composer's Project pill makes, through
                the same call - the two can never disagree. */}
            <DropdownMenuRadioGroup
              value={projectId ?? NO_PROJECT}
              onValueChange={(value) => onChooseProject(value === NO_PROJECT ? null : value)}
            >
              <DropdownMenuRadioItem value={NO_PROJECT}>No project</DropdownMenuRadioItem>
              {projects
                .filter((entry) => !entry.archived || entry.id === projectId)
                .map((entry) => (
                  <DropdownMenuRadioItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem onSelect={onReset}>
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
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2Icon />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface ClosedTerminalCardProps {
  title: string;
  description: string;
  onReopen(): void;
  onChat(): void;
  busy: boolean;
}

/** Where the terminal was, once it is gone: open it again, or carry on in chat. */
function ClosedTerminalCard({ title, description, onReopen, onChat, busy }: ClosedTerminalCardProps) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-3 text-center">
      <TerminalIcon className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onReopen}>
          Open terminal again
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onChat}>
          Back to chat
        </Button>
      </div>
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

          {/* FormField wires label, input and message together: without
              `aria-describedby`, someone who tabs back into the field after
              the rejection hears only its name. */}
          <FormField id="conversation-title" label="Title" error={error} className="py-4">
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
