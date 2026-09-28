import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { NavLink } from 'react-router';

import {
  ArchiveIcon,
  CornerUpLeftIcon as ReplyIcon,
  CornerUpRightIcon,
  GripVerticalIcon as MoreVerticalIcon,
  MailCheckIcon as MailOpenIcon,
  SendIcon,
  UndoIcon as ReplyAllIcon,
} from "@/components/icons";

import type { Mail, TaskStatus } from '@/lib/types';
import { baseSubject } from '@/lib/mail';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/common/empty-state';
import { MailThreadView } from '@/components/common/mail-thread';
import { StatusBadge } from '@/components/common/status-badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The reading pane: an action bar, the open mail's whole thread, and a reply
 * box. The thread, not the single mail, because a reply without what it
 * answers is half a conversation - and a task thread's status notes only make
 * sense between the messages they sit between.
 *
 * The action bar is shadcn's, with one archive of our own: the thread is the
 * unit that gets filed away, because what a thread *is* is what the folders
 * route on. What is left of shadcn's bar is what the company can actually
 * do: answer the sender, answer everyone, pass a mail on, and put one back on
 * the unread pile.
 *
 * When the mail's thread is an assignment with a task on the board, a chip
 * under the subject links to it - mail and board are two views of the same
 * work, and this is the hop between them.
 *
 * Reply keeps the inline box this pane always had - it is the fast path and
 * needs no dialog, so the bar's Reply button only puts the cursor in it. Reply
 * all and Forward change who the mail goes to, so they hand off to Compose
 * with recipients and quote filled in, where both can still be corrected.
 *
 * Every mailbox but the user's own is read-only: same pane, no bar.
 */

interface ReplyBoxProps {
  replyTargetName: string;
  onReply(body: string): Promise<void>;
  sending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * The inline reply box.
 *
 * Its own component so `MailDisplay` can key it by mail id: a half-written
 * answer to one mail must not follow the reader into the next one.
 */
function ReplyBox({ replyTargetName, onReply, sending, inputRef }: ReplyBoxProps) {
  const [draft, setDraft] = useState('');

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    await onReply(text);
    setDraft('');
  };

  return (
    <div className="shrink-0 p-4">
      <div className="grid gap-3">
        <Textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={'Reply ' + replyTargetName + '…'}
          className="min-h-20 resize-none p-4"
        />
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-xs text-muted-foreground">Goes to {replyTargetName}.</span>
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            onClick={() => void submit()}
            disabled={sending || !draft.trim()}
          >
            <SendIcon />
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}

interface MailDisplayProps {
  mail: Mail | null;
  /** Whose mailbox the thread is read as. */
  mailboxId: string;
  /** Changes when the thread may have grown, so the pane refetches it. */
  reloadKey?: unknown;
  /** The board status of the thread's task, when it has one. */
  taskStatus?: TaskStatus | null;
  /** Only the "You" mailbox may write. */
  interactive: boolean;
  replyTargetName: string | null;
  onReply(body: string): Promise<void>;
  /** Opens Compose with the sender and every other recipient in To and Cc. */
  onReplyAll(): void;
  /** Opens Compose with the quoted mail and an empty To. */
  onForward(): void;
  /** False when the mail has nobody to answer beyond the one Reply covers. */
  canReplyAll: boolean;
  /** Puts the open mail back on the unread pile. Absent when it is already unread. */
  onMarkUnread?: (() => void) | undefined;
  /** Files the whole thread away. Absent when there is nothing to do. */
  onArchiveThread?: (() => void) | undefined;
  sending: boolean;
}

export function MailDisplay({
  mail,
  mailboxId,
  reloadKey,
  taskStatus,
  interactive,
  replyTargetName,
  onReply,
  onReplyAll,
  onForward,
  canReplyAll,
  onMarkUnread,
  onArchiveThread,
  sending,
}: MailDisplayProps) {
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  const canReply = interactive && mail !== null && replyTargetName !== null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {interactive && (
        <>
          {/* `delayDuration={0}`: an icon-only bar has no label but its tooltip. */}
          <TooltipProvider delayDuration={0}>
            <div className="flex h-[52px] shrink-0 items-center gap-2 px-2">
              <div className="ml-auto flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={!canReply}
                      onClick={() => replyRef.current?.focus()}
                    >
                      <ReplyIcon />
                      <span className="sr-only">Reply</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reply</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={!mail || !canReplyAll}
                      onClick={onReplyAll}
                    >
                      <ReplyAllIcon />
                      <span className="sr-only">Reply all</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reply all</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" disabled={!mail} onClick={onForward}>
                      <CornerUpRightIcon />
                      <span className="sr-only">Forward</span>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Forward</TooltipContent>
                </Tooltip>
              </div>
              <Separator orientation="vertical" className="mx-1 h-6" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" disabled={!mail}>
                    <MoreVerticalIcon />
                    <span className="sr-only">More</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={!onMarkUnread} onSelect={() => onMarkUnread?.()}>
                    Mark as unread
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!onArchiveThread || mail?.threadArchivedAt != null}
                    onSelect={() => onArchiveThread?.()}
                  >
                    <ArchiveIcon />
                    Archive thread
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </TooltipProvider>
          <Separator />
        </>
      )}

      {mail === null ? (
        <EmptyState
          icon={MailOpenIcon}
          title="No mail selected"
          description="Pick one from the list to read it here."
          className="m-auto"
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 shrink-0 flex-col gap-2 p-4">
            <h2 className="line-clamp-2 text-base font-semibold">
              {baseSubject(mail.subject) || '(No subject)'}
            </h2>
            {mail.taskId && (
              <div className="flex min-w-0 items-center gap-2">
                {taskStatus && <StatusBadge kind="task" status={taskStatus} className="shrink-0" />}
                <NavLink
                  to={'/tasks/' + mail.taskId}
                  className="min-w-0 max-w-full truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {/* The heading already says the title when the two agree. */}
                  {mail.taskTitle && mail.taskTitle !== baseSubject(mail.subject) ? mail.taskTitle : 'Open on the board'}
                </NavLink>
              </div>
            )}
          </div>

          <Separator />

          {/* `block!` for the same reason as the list: radix's inline
              `display: table` lets a long code line widen every card past
              the pane. */}
          <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
            <MailThreadView
              threadId={mail.threadId}
              mailbox={mailboxId}
              highlightId={mail.id}
              reloadKey={reloadKey}
              className="p-4"
            />
          </ScrollArea>

          {canReply && replyTargetName && (
            <>
              <Separator />
              <ReplyBox
                key={mail.id}
                replyTargetName={replyTargetName}
                onReply={onReply}
                sending={sending}
                inputRef={replyRef}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
