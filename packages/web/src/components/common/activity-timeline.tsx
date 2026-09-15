import * as React from 'react';
import { ActivityIcon, BrainIcon, SparklesIcon, UsersIcon, WrenchIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { ActivityIcon as AnimatedActivityIcon } from '@/components/animate-ui/icons/activity';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { prettyToolName } from '@/hooks/useChat';
import { relativeTime } from '@/lib/format';
import type { ActivityItem, AssignmentView } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One vertical feed for "what is happening right now" - the rendering half of
 * the live activity rail described on `ActivityItem` (`lib/types.ts`).
 *
 * Two very different sources feed the same list:
 * - a turn's own `ChatState.activity`, built event-by-event in `useChat` as
 *   its own stream arrives (tool calls, status lines, delegated assignments,
 *   memory recalls) - pass it straight through as `items`.
 * - a fellow agent's run, watched from outside: the org-wide `assignment`
 *   broadcast only ever carries the *single* most recent tool call
 *   (`AssignmentView.lastActivity`), not a list, so `useAssignmentActivityHistory`
 *   below accumulates one client-side, keyed by assignment id, and hands back
 *   the same `ActivityItem[]` shape this component already knows how to draw.
 *
 * Unifying the two at the type level was not worth it: one is a rich event
 * log with start/end pairing, the other a single ticking field. Converging on
 * `ActivityItem[]` as the *rendering* contract is enough.
 */

const ACTIVITY_ICON: Record<ActivityItem['kind'], LucideIcon> = {
  tool: WrenchIcon,
  status: ActivityIcon,
  assignment: UsersIcon,
  memory: BrainIcon,
  thinking: SparklesIcon,
};

export interface ActivityTimelineProps {
  items: readonly ActivityItem[];
  /** `plain` drops the card frame for a caller that already has one. */
  variant?: 'card' | 'plain';
  title?: string;
  /** Shown instead of the list when `items` is empty. */
  emptyLabel?: string;
  /** Keeps only the newest N rows. Unset renders everything passed in. */
  limit?: number;
  className?: string;
}

/**
 * Renders newest-first: the point of a live rail is to answer "what is it
 * doing right now" without scrolling, so the freshest line belongs on top.
 */
export function ActivityTimeline({
  items,
  variant = 'card',
  title = 'Activity',
  emptyLabel = 'No activity yet.',
  limit,
  className,
}: ActivityTimelineProps) {
  const rows = React.useMemo(() => {
    const ordered = [...items].sort((a, b) => b.at - a.at);
    return limit ? ordered.slice(0, limit) : ordered;
  }, [items, limit]);

  const body =
    rows.length === 0 ? (
      <Fade>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <AnimatedActivityIcon animateOnView className="size-4" />
          {emptyLabel}
        </p>
      </Fade>
    ) : (
      <ItemGroup className="gap-1.5">
        {rows.map((item) => {
          const Icon = ACTIVITY_ICON[item.kind];
          return (
            <Item key={item.id + ':' + item.at} variant="muted" size="sm">
              <ItemMedia variant="icon">
                <Icon className={cn('text-muted-foreground', item.done === false && 'animate-pulse')} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="flex flex-wrap items-baseline gap-x-2 font-normal">
                  <span>{item.label}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {relativeTime(item.at)}
                  </span>
                </ItemTitle>
                {item.detail && <ItemDescription className="line-clamp-1">{item.detail}</ItemDescription>}
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    );

  if (variant === 'plain')
    return (
      <Fade asChild>
        <div className={className}>{body}</div>
      </Fade>
    );

  return (
    <Fade asChild>
      <Card className={cn('py-3', className)}>
        <CardHeader className="border-b px-3!">
          <CardTitle className="text-sm">{title}</CardTitle>
        </CardHeader>
        <CardContent className="px-3!">{body}</CardContent>
      </Card>
    </Fade>
  );
}

/** Rolling per-assignment history kept for `useAssignmentActivityHistory`. */
const DEFAULT_HISTORY_CAP = 20;

/**
 * Watches one assignment's `lastActivity` as `useOrg().live` updates it, and
 * accumulates a short rolling history for it - the broadcast only ever
 * carries the single newest entry, so remembering earlier ones is this
 * hook's job, not the server's.
 *
 * Keyed by assignment id: switching to a different (or newly started)
 * assignment starts its history fresh rather than carrying the previous
 * run's tool calls into the new one.
 */
export function useAssignmentActivityHistory(
  assignmentId: string | undefined,
  live: Record<string, AssignmentView>,
  cap: number = DEFAULT_HISTORY_CAP,
): ActivityItem[] {
  const [history, setHistory] = React.useState<Record<string, ActivityItem[]>>({});
  const activity = assignmentId ? live[assignmentId]?.lastActivity : undefined;

  React.useEffect(() => {
    if (!assignmentId || !activity) return;
    setHistory((current) => {
      const existing = current[assignmentId] ?? [];
      if (existing.length > 0 && existing[existing.length - 1]?.at === activity.at) return current;
      const entry: ActivityItem = {
        id: assignmentId + ':' + activity.at,
        kind: activity.kind,
        label: activity.kind === 'tool' ? prettyToolName(activity.label) : activity.label,
        at: activity.at,
      };
      return { ...current, [assignmentId]: [...existing, entry].slice(-cap) };
    });
    // Only the timestamp identifies a genuinely new event; re-running this
    // for every unrelated `live[assignmentId]` change (chars, preview) would
    // do nothing but is worth avoiding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId, activity?.at, cap]);

  return assignmentId ? (history[assignmentId] ?? []) : [];
}
