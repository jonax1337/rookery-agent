import { ResultMarkdown } from '@/components/result-markdown';
import { EmptyState } from '@/components/common/empty-state';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime } from '@/lib/format';
import { useConfig, useOrgState } from '@/providers/rookery-provider';
import {
  ActivityIcon,
  BanIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  ClipboardCheckIcon,
  CornerUpLeftIcon,
  FileTextIcon,
  PlayIcon,
  PlusIcon,
  ServerCrashIcon,
  type IconComponent,
} from '@/components/icons';
import type { TaskEvent, TaskEventActor, TaskEventKind } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * A task's activity, oldest first - the card's own protocol.
 *
 * It replaces the mail thread a task used to be negotiated in, and keeps the
 * two looks that thread had on purpose. What somebody said - the brief, a
 * question, an answer, a note - is a message with a sender. Bookkeeping - a
 * run starting or ending, the card changing state - is a single line on the
 * timeline, with a run's result folded away underneath, so it marks where the
 * work stands without reading like one more letter.
 */

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

interface Look {
  label: string;
  icon: IconComponent;
  className: string;
}

/** The message kinds: what they are called beside the sender. */
const MESSAGE_LOOK: Partial<Record<TaskEventKind, Look>> = {
  created: { label: 'created the task', icon: PlusIcon, className: 'text-muted-foreground' },
  question: { label: 'asked', icon: CircleHelpIcon, className: 'text-amber-500' },
  answer: { label: 'answered', icon: CornerUpLeftIcon, className: 'text-primary' },
  note: { label: 'noted', icon: FileTextIcon, className: 'text-muted-foreground' },
};

/** A status line's look, read off the fixed wording `statusNote` writes in core. */
function statusLook(text: string): Look {
  if (/ is done\b/.test(text)) return { label: 'Task done', icon: CircleCheckIcon, className: 'text-primary' };
  if (/ was cancelled\b/.test(text)) return { label: 'Task cancelled', icon: BanIcon, className: 'text-muted-foreground' };
  if (/waiting for an answer/.test(text))
    return { label: 'Waiting for an answer', icon: CircleHelpIcon, className: 'text-amber-500' };
  if (/ failed\b/.test(text)) return { label: 'Task failed', icon: ServerCrashIcon, className: 'text-destructive' };
  return { label: 'Status changed', icon: ActivityIcon, className: 'text-muted-foreground' };
}

/** A line's headline and what folds away under it: split at the first blank line. */
function splitText(text: string): { headline: string; detail: string } {
  const body = text.trim();
  const breakAt = body.indexOf('\n\n');
  if (breakAt < 0) return { headline: body, detail: '' };
  return { headline: body.slice(0, breakAt).trim(), detail: body.slice(breakAt + 2).trim() };
}

export interface TaskActivityProps {
  /** `null` while loading. */
  events: TaskEvent[] | null;
  /** The open question's id, when the card waits on one - it is marked. */
  highlightId?: string | undefined;
  className?: string;
}

export function TaskActivity({ events, highlightId, className }: TaskActivityProps) {
  const org = useOrgState();
  const { assistantName } = useConfig();

  const nameOf = (kind: TaskEventActor, id?: string): string => {
    if (kind === 'user') return 'You';
    if (kind === 'assistant') return assistantName;
    if (kind === 'system') return 'Rookery';
    return id ? (org.agentById(id)?.name ?? 'Former agent') : 'Former agent';
  };

  const roleOf = (kind: TaskEventActor, id?: string): string | null =>
    kind === 'agent' && id ? (org.agentById(id)?.title?.trim() || null) : null;

  if (events === null) {
    return (
      <div className={cn('flex flex-col gap-3', className)}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <EmptyState
        icon={ActivityIcon}
        title="No activity yet"
        description="Runs, questions, answers and status changes of this task show up here."
        variant="plain"
        size="sm"
      />
    );
  }

  return (
    <ol className={cn('flex flex-col gap-4', className)}>
      {events.map((event) => {
        const message = MESSAGE_LOOK[event.kind];
        const actor = nameOf(event.actorKind, event.actorAgentId);

        if (!message) {
          const look =
            event.kind === 'status'
              ? statusLook(event.text)
              : event.kind === 'run-started'
                ? { label: '', icon: PlayIcon, className: 'text-muted-foreground' }
                : { label: '', icon: ClipboardCheckIcon, className: 'text-muted-foreground' };
          const { headline, detail } = splitText(event.text);
          // A status line keeps its short label; a run line says what happened in its own words.
          const label = event.kind === 'status' ? look.label : headline;
          return (
            <li key={event.id} id={'event-' + event.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
                <look.icon className={cn('size-3.5 shrink-0', look.className)} aria-hidden="true" />
                <span className="max-w-[70%] truncate font-medium text-foreground" title={label}>
                  {label}
                </span>
                <span className="shrink-0">{formatDateTime(event.at)}</span>
                <span className="h-px flex-1 bg-border" aria-hidden="true" />
              </div>
              {detail ? (
                <details className="group mx-auto w-full max-w-prose text-sm">
                  <summary className="cursor-pointer list-none text-center text-xs text-muted-foreground hover:text-foreground">
                    <span className="group-open:hidden">Show result</span>
                    <span className="hidden group-open:inline">Hide result</span>
                  </summary>
                  <div className="mt-2 rounded-lg border bg-muted/30 p-3">
                    <ResultMarkdown text={detail} />
                  </div>
                </details>
              ) : null}
            </li>
          );
        }

        const role = roleOf(event.actorKind, event.actorAgentId);
        const highlighted = event.id === highlightId;
        return (
          <li
            key={event.id}
            id={'event-' + event.id}
            className={cn(
              'flex gap-3 rounded-lg border p-3',
              highlighted && 'border-amber-500/50 bg-amber-500/5',
            )}
          >
            <Avatar className="size-8 shrink-0">
              <AvatarFallback className="text-xs">{initials(actor)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-semibold">{actor}</span>
                {role ? <span className="text-xs text-muted-foreground">{role}</span> : null}
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <message.icon className={cn('size-3.5 self-center', message.className)} aria-hidden="true" />
                  {message.label}
                </span>
                <span className="ms-auto text-xs text-muted-foreground">{formatDateTime(event.at)}</span>
              </div>
              <ResultMarkdown text={event.text} className="mt-2" />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
