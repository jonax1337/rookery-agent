import * as React from 'react';
import { NavLink, useNavigate } from 'react-router';
import { ThreadPrimitive } from '@assistant-ui/react';
import {
  AudioLinesIcon,
  BotIcon,
  FeatherIcon,
  MessagesSquareIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { failureMessage, reportFailure } from '@/lib/errors';
import { greeting, NO_PROJECT, UNTITLED_SESSION } from '@/lib/format';
import { SESSION_TITLE_MAX, sessionTitleSchema } from '@/lib/session';
import {
  useAllSessionsState,
  useChatSession,
  useConfig,
  useOrgState,
  useSessionsState,
} from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';

import { Thread, type ThreadComponents } from '@/components/assistant-ui/elements/thread.aui';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { LiveRunList } from '@/components/common/live-run-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { collectErrors, FormField } from '@/components/forms/form-kit';

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
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
 * (Projekt, Zugriff, Modell, Effort) live inside it because they are
 * parameters of the *next* message. This file only frames it.
 *
 * What the frame adds is everything a conversation needs that is not a
 * message: the header says which conversation is open and carries its
 * actions, the empty thread says hello with a way to start, the assignments a
 * turn hands out sit above the transcript, and a failed turn says so instead
 * of leaving the composer looking idle.
 */

interface Suggestion {
  title: string;
  label: string;
  prompt: string;
}

const ASSISTANT_SUGGESTIONS: Suggestion[] = [
  {
    title: 'Fass zusammen,',
    label: 'was du über mich weißt',
    prompt: 'Fass kurz zusammen, was du über mich weißt.',
  },
  {
    title: 'Plane meinen Tag',
    label: 'mit drei Prioritäten',
    prompt: 'Hilf mir, meinen Tag mit drei Prioritäten zu planen.',
  },
  {
    title: 'Erklär mir,',
    label: 'wie du arbeitest',
    prompt: 'Erklär mir kurz, wie du arbeitest und worauf du Zugriff hast.',
  },
];

const AGENT_SUGGESTIONS: Suggestion[] = [
  {
    title: 'Stell dich vor,',
    label: 'wofür bist du zuständig?',
    prompt: 'Stell dich kurz vor: wofür bist du zuständig und wie arbeitest du?',
  },
  {
    title: 'Woran arbeitest du',
    label: 'gerade?',
    prompt: 'Woran arbeitest du gerade, und was steht als Nächstes an?',
  },
  {
    title: 'Ich habe eine Frage',
    label: 'zu deinem Bereich',
    prompt: 'Ich habe eine Frage zu deinem Bereich: ',
  },
];

export function ChatPage() {
  const navigate = useNavigate();
  const { chat, counterpart, turn } = useChatSession();
  const { assistantName } = useConfig();
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
  const title = session?.title || (activeId ? 'Gespräch' : UNTITLED_SESSION);

  /* ------------------------------- actions ------------------------------- */

  const [renameOpen, setRenameOpen] = React.useState(false);

  const confirmReset = React.useCallback(async () => {
    if (!activeId) return;
    const ok = await confirm({
      title: 'Gespräch zurücksetzen?',
      description:
        'Alle Nachrichten dieses Gesprächs werden entfernt. Titel, Projekt und Gegenüber bleiben.',
      confirmLabel: 'Zurücksetzen',
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
      // `/chats` and the rail's badge read the shared list, and neither
      // `PATCH` nor `DELETE /api/sessions/:id` sends anything over the socket.
      void allSessions.refresh();
      toast('Gespräch zurückgesetzt');
    } catch (caught) {
      reportFailure('Zurücksetzen', caught);
    }
  }, [activeId, allSessions, chat, confirm, sessions]);

  const confirmDelete = React.useCallback(async () => {
    if (!activeId) return;
    const ok = await confirm({
      title: 'Gespräch löschen?',
      description: 'Dieses Gespräch und alle Nachrichten werden gelöscht.',
      confirmLabel: 'Löschen',
      destructive: true,
    });
    if (!ok) return;
    try {
      await sessions.remove(activeId);
      chat.reset();
      void allSessions.refresh();
      toast('Gespräch gelöscht');
      void navigate('/chats');
    } catch (caught) {
      reportFailure('Löschen', caught);
    }
  }, [activeId, allSessions, chat, confirm, navigate, sessions]);

  /* -------------------------------- meta --------------------------------- */

  // Without an open conversation there is nothing to rename, reset or delete,
  // so the menu is absent rather than disabled.
  usePageMeta(
    {
      breadcrumb: counterpart
        ? [
            { label: 'Gespräche', to: '/chats' },
            { label: counterpart.name, to: '/org/agents/' + counterpart.id },
            { label: title },
          ]
        : [{ label: 'Gespräche', to: '/chats' }, { label: title }],
      actions: activeId ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton tone="header" label="Weitere Aktionen" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
              <PencilIcon />
              Umbenennen
            </DropdownMenuItem>

            {/* Every open conversation can be carried on hands-free; a
                spoken one is simply going back to where it started. */}
            <DropdownMenuItem onSelect={() => void navigate('/voice?session=' + activeId)}>
              <AudioLinesIcon />
              {session?.kind === 'voice' ? 'Sprachgespräch fortsetzen' : 'Im Sprachmodus fortsetzen'}
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Projekt zuweisen</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-52">
                {/* The same choice the composer's Projekt pill makes, through
                    the same call - the two can never disagree. */}
                <DropdownMenuRadioGroup
                  value={turn.projectId ?? NO_PROJECT}
                  onValueChange={(value) =>
                    turn.chooseProject(value === NO_PROJECT ? null : value)
                  }
                >
                  <DropdownMenuRadioItem value={NO_PROJECT}>Kein Projekt</DropdownMenuRadioItem>
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
              Zurücksetzen
            </DropdownMenuItem>

            <DropdownMenuItem asChild>
              <NavLink to="/chats">
                <MessagesSquareIcon />
                Zu den Gesprächen
              </NavLink>
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => void confirmDelete()}>
              <Trash2Icon />
              Löschen
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

  // Rebuilt only when the counterpart changes, so an ordinary turn never
  // re-renders the thread through a fresh components object.
  const components = React.useMemo<ThreadComponents>(
    () => ({
      Welcome: () => (
        <EmptyState
          icon={counterpart ? BotIcon : FeatherIcon}
          title={counterpart ? 'Gespräch mit ' + counterpart.name : greeting()}
          description={
            counterpart
              ? counterpart.title + ' · antwortet mit eigenem Gedächtnis'
              : 'Womit kann ich helfen?'
          }
          variant="plain"
          className="px-2 sm:px-12"
          action={
            <ButtonGroup orientation="vertical" className="w-full">
              {(counterpart ? AGENT_SUGGESTIONS : ASSISTANT_SUGGESTIONS).map((suggestion) => (
                <ThreadPrimitive.Suggestion
                  key={suggestion.prompt}
                  prompt={suggestion.prompt}
                  send
                  asChild
                >
                  <Button
                    variant="outline"
                    className="h-auto justify-start py-2 text-left font-normal whitespace-normal"
                  >
                    <span>
                      <span className="font-medium">{suggestion.title}</span>{' '}
                      <span className="text-muted-foreground">{suggestion.label}</span>
                    </span>
                  </Button>
                </ThreadPrimitive.Suggestion>
              ))}
            </ButtonGroup>
          }
        />
      ),
    }),
    [counterpart],
  );

  /* -------------------------------- page --------------------------------- */

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {dialog}
      {cancelDialog}

      {chat.assignments.length > 0 && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-4">
          <LiveRunList
            assignments={chat.assignments}
            onCancel={(id) => void cancelAssignment(id)}
          />
        </div>
      )}

      {chat.error && (
        // The toast that `RookeryProvider` raises is gone in five seconds and
        // carries the way to try again; this stays until the next turn, so
        // the composer is never idle for a reason nobody can see any more.
        <div className="mx-auto w-full max-w-3xl px-4 pt-4">
          <Item variant="outline" size="sm" className="border-destructive/50 items-start">
            <ItemMedia>
              <TriangleAlertIcon className="text-destructive" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle className="text-destructive">Der Turn ist fehlgeschlagen</ItemTitle>
              <ItemDescription className="text-foreground">{chat.error}</ItemDescription>
            </ItemContent>
          </Item>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
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

      <span className="sr-only">Gespräch mit {counterpart?.name ?? assistantName}</span>
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
            <DialogTitle>Gespräch umbenennen</DialogTitle>
            <DialogDescription>
              Unter diesem Namen steht das Gespräch in der Liste und im Kopf.
            </DialogDescription>
          </DialogHeader>

          {/* FormField verdrahtet Label, Eingabe und Meldung: ohne
              `aria-describedby` hört jemand, der nach der Ablehnung zurück ins
              Feld tabbt, nur noch dessen Namen. */}
          <FormField id="gespraech-titel" label="Titel" error={error} className="py-4">
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
                Abbrechen
              </Button>
            </DialogClose>
            <Button type="submit" disabled={saving}>
              Speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
