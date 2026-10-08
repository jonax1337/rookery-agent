import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { ArchiveIcon, BellIcon, ExternalLinkIcon, MailCheckIcon, UndoIcon } from '@/components/icons';

import type { Notification, Task, TaskStatus } from '@/lib/types';
import { formatDateTime } from '@/lib/format';
import { isAnswerable, notificationSources } from '@/lib/notifications';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';
import { StatusBadge } from '@/components/common/status-badge';
import { TaskAnswerBox } from '@/components/common/task-answer-box';
import { ResultMarkdown } from '@/components/result-markdown';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { NotificationKindBadge } from './notification-nav';

/**
 * The reading pane: an action bar, the open notification rendered as
 * Markdown, links to where it came from, and - for a question about a card -
 * the answer box that runs the card on.
 *
 * The links are the notification's whole point beyond its text: a schedule
 * result opens its run, a finished card opens the card, anything that came out
 * of a conversation opens that conversation, where a reply continues it.
 */

interface NotificationDisplayProps {
  notification: Notification | null;
  senderLabel: string | null;
  /** The board status of the card it is about, when known. */
  taskStatus: TaskStatus | null;
  onToggleRead(): void;
  onToggleArchived(): void;
  onAnswered(task: Task): void;
}

export function NotificationDisplay({
  notification,
  senderLabel,
  taskStatus,
  onToggleRead,
  onToggleArchived,
  onAnswered,
}: NotificationDisplayProps) {
  const read = notification?.readAt != null;
  const archived = notification?.archivedAt != null;
  const sources = notification ? notificationSources(notification) : [];
  // A question can be answered while its card waits. The status may not be
  // loaded yet; then the box shows and the server decides.
  const answerable =
    notification !== null && isAnswerable(notification) && (taskStatus === null || taskStatus === 'blocked');

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      {/* `delayDuration={0}`: an icon-only bar has no label but its tooltip. */}
      <TooltipProvider delayDuration={0}>
        <div className="flex h-[52px] shrink-0 items-center gap-1 px-2">
          <div className="ml-auto flex items-center gap-1">
            <BarButton label={read ? 'Mark as unread' : 'Mark as read'} disabled={!notification} onClick={onToggleRead}>
              {read ? <UndoIcon /> : <MailCheckIcon />}
            </BarButton>
            <BarButton
              label={archived ? 'Move back to notifications' : 'Archive'}
              disabled={!notification}
              onClick={onToggleArchived}
            >
              <ArchiveIcon />
            </BarButton>
          </div>
        </div>
      </TooltipProvider>
      <Separator />

      {notification === null ? (
        <EmptyState
          icon={BellIcon}
          title="No notification selected"
          description="Pick one from the list to read it here."
          className="m-auto"
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 shrink-0 flex-col gap-2 p-4">
            <h2 className="line-clamp-2 text-base font-semibold">{notification.title || '(No title)'}</h2>
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <NotificationKindBadge kind={notification.kind} />
              {senderLabel && <span className="font-medium text-foreground">{senderLabel}</span>}
              <span>{formatDateTime(notification.createdAt)}</span>
            </div>
            {sources.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {notification.taskId && taskStatus && <StatusBadge kind="task" status={taskStatus} className="shrink-0" />}
                {sources.map((source) => (
                  <NavLink
                    key={source.to}
                    to={source.to}
                    className="inline-flex min-w-0 max-w-full items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-3"
                  >
                    <ExternalLinkIcon aria-hidden="true" />
                    {source.label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* `block!`: radix's inline `display: table` would let a long code
              line widen the pane past the window. */}
          <ScrollArea className="min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
            <div className="p-4">
              {notification.body.trim() ? (
                <ResultMarkdown text={notification.body} />
              ) : (
                <p className="text-sm text-muted-foreground">No further text.</p>
              )}
            </div>
          </ScrollArea>

          {isAnswerable(notification) && notification.taskId && (
            <>
              <Separator />
              <div className="shrink-0 p-4">
                {answerable ? (
                  <TaskAnswerBox
                    key={notification.id}
                    taskId={notification.taskId}
                    askedBy={senderLabel ?? undefined}
                    onAnswered={onAnswered}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    This task is no longer waiting for an answer.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface BarButtonProps {
  label: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}

/** An icon-only action: the label is both the tooltip and the accessible name. */
function BarButton({ label, disabled, onClick, children }: BarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" disabled={disabled} onClick={onClick}>
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
