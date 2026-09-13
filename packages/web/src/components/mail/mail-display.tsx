import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { CornerUpRightIcon, MailOpenIcon, MoreVerticalIcon, ReplyAllIcon, ReplyIcon, SendIcon } from 'lucide-react';

import type { Mail } from '@/lib/types';
import { formatDateTime } from '@/lib/format';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/common/empty-state';
import { ResultMarkdown } from '@/components/result-markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The reading pane: an action bar, one mail in full, and a reply box.
 *
 * The action bar is shadcn's, minus the buttons we would have had to fake.
 * Archive, junk, trash and snooze are not in it because they are not in the
 * data model - a mail here has recipients and a read mark, and that is all.
 * What is left is what the company can actually do: answer the sender, answer
 * everyone, pass a mail on, and put one back on the unread pile.
 *
 * Reply keeps the inline box this pane always had - it is the fast path and
 * needs no dialog, so the bar's Reply button only puts the cursor in it. Reply
 * all and Forward change who the mail goes to, so they hand off to Compose
 * with recipients and quote filled in, where both can still be corrected.
 *
 * Every mailbox but the user's own is read-only: same pane, no bar.
 */

/** Initials for the avatar, the way shadcn's mail example builds them. */
function initials(name: string): string {
  const chunks = name.trim().split(/\s+/).filter(Boolean);
  if (chunks.length === 0) return '?';
  return chunks
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? '')
    .join('');
}

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
  senderLabel(mail: Mail): string;
  /** The sender's job title, when the sender is an agent. */
  senderRole(mail: Mail): string | null;
  /** Full "To: …" line, and "Cc: …" when there is one. */
  toLine(mail: Mail): string;
  ccLine(mail: Mail): string | null;
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
  sending: boolean;
}

export function MailDisplay({
  mail,
  senderLabel,
  senderRole,
  toLine,
  ccLine,
  interactive,
  replyTargetName,
  onReply,
  onReplyAll,
  onForward,
  canReplyAll,
  onMarkUnread,
  sending,
}: MailDisplayProps) {
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  const canReply = interactive && mail !== null && replyTargetName !== null;
  const cc = mail ? ccLine(mail) : null;

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
          <div className="flex min-w-0 shrink-0 items-start gap-4 p-4">
            <Avatar>
              <AvatarFallback>{initials(senderLabel(mail))}</AvatarFallback>
            </Avatar>
            <div className="grid min-w-0 flex-1 gap-1 text-sm">
              {/* shadcn's header puts a "Reply-To" line under the name; ours
                  puts what a company actually needs to know about a sender. */}
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 truncate font-semibold">{senderLabel(mail)}</span>
                {senderRole(mail) && (
                  <span className="min-w-0 truncate text-xs text-muted-foreground">{senderRole(mail)}</span>
                )}
              </div>
              <div className="line-clamp-1 text-xs">{mail.subject || '(No subject)'}</div>
              <div className="line-clamp-1 text-xs text-muted-foreground">{toLine(mail)}</div>
              {cc && <div className="line-clamp-1 text-xs text-muted-foreground">{cc}</div>}
            </div>
            <div className="shrink-0 text-xs text-muted-foreground">{formatDateTime(mail.createdAt)}</div>
          </div>

          <Separator />

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4 text-sm">
              <ResultMarkdown text={mail.body} />
            </div>
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
