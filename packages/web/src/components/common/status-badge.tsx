import {
  BanIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  LoaderIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  ASSIGNMENT_STATUS_LABEL,
  ASSIGNMENT_STATUS_VARIANT,
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_VARIANT,
  TASK_STATUS_LABEL,
  TASK_STATUS_VARIANT,
} from '@/lib/format';
import { CRON_RUN_STATUS_LABEL, CRON_RUN_STATUS_VARIANT } from '@/lib/cron';
import { formatNumber } from '@/lib/stats';
import type {
  AssignmentStatus,
  CronRunStatus,
  SleepStatus,
  TaskPriority,
  TaskStatus,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * One badge for every state this app knows.
 *
 * The labels and the variants already exist as complete `Record`s in
 * `lib/format.ts` and `lib/cron.ts`; what was missing was a component that
 * uses them, so five pages each wrote their own `<Badge className="h-4
 * px-1.5 text-[10px]">` and they drifted in size and colour. Nothing here
 * invents a state: the maps are keyed by the union types, so a new status on
 * the server fails the typecheck instead of rendering blank.
 *
 * The spinning loader and the filled check come from the block's own status
 * cell - a failure should read as one before the word is read.
 */

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline';

type StatusKindProps =
  | { kind: 'assignment'; status: AssignmentStatus }
  | { kind: 'task'; status: TaskStatus }
  | { kind: 'priority'; status: TaskPriority }
  | { kind: 'cronRun'; status: CronRunStatus }
  // A night runs, finishes or fails exactly like a scheduled run does, so it
  // reuses those labels - but it says `sleepRun` at the call site, because a
  // table of nights that claimed to show cron runs would mislead the next
  // reader of the code.
  | { kind: 'sleepRun'; status: SleepStatus };

export type StatusBadgeProps = StatusKindProps & {
  /** Off where the row already carries its own glyph. */
  icon?: boolean;
  className?: string;
};

interface Resolved {
  label: string;
  variant: BadgeVariant;
  icon: LucideIcon | null;
  /** Only the states that are genuinely in motion animate. */
  spin?: boolean;
}

const ASSIGNMENT_ICON: Record<AssignmentStatus, LucideIcon> = {
  pending: CircleDashedIcon,
  running: LoaderIcon,
  done: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: BanIcon,
};

const TASK_ICON: Record<TaskStatus, LucideIcon> = {
  open: CircleDashedIcon,
  planned: CircleDotIcon,
  running: LoaderIcon,
  done: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: BanIcon,
};

const CRON_RUN_ICON: Record<CronRunStatus, LucideIcon> = {
  running: LoaderIcon,
  done: CircleCheckIcon,
  failed: CircleXIcon,
};

function resolve(props: StatusKindProps): Resolved {
  switch (props.kind) {
    case 'assignment':
      return {
        label: ASSIGNMENT_STATUS_LABEL[props.status],
        variant: ASSIGNMENT_STATUS_VARIANT[props.status],
        icon: ASSIGNMENT_ICON[props.status],
        spin: props.status === 'running',
      };
    case 'task':
      return {
        label: TASK_STATUS_LABEL[props.status],
        variant: TASK_STATUS_VARIANT[props.status],
        icon: TASK_ICON[props.status],
        spin: props.status === 'running',
      };
    case 'cronRun':
    case 'sleepRun':
      return {
        label: CRON_RUN_STATUS_LABEL[props.status],
        variant: CRON_RUN_STATUS_VARIANT[props.status],
        icon: CRON_RUN_ICON[props.status],
        spin: props.status === 'running',
      };
    // Priority is not a state something is in, so it gets no glyph - a badge
    // that reads "Hoch" next to one that reads "Läuft" would be confusing.
    case 'priority':
      return {
        label: TASK_PRIORITY_LABEL[props.status],
        variant: TASK_PRIORITY_VARIANT[props.status],
        icon: null,
      };
  }
}

export function StatusBadge(props: StatusBadgeProps) {
  const { icon = true, className } = props;
  const { label, variant, icon: Icon, spin } = resolve(props);

  return (
    <Badge variant={variant} className={cn('gap-1', className)}>
      {icon && Icon && <Icon className={cn(spin && 'animate-spin')} aria-hidden="true" />}
      {label}
    </Badge>
  );
}

/**
 * "Etwas läuft gerade", in the one wording the whole app uses.
 *
 * The same fact was worded five ways and painted two colours: "in Arbeit" and
 * "aktiv" as a default badge, "läuft"/"laufen" and "N laufen" as a secondary
 * one. The jump was visible in two clicks - the dashboard tile said "2 laufen"
 * and the tasks page called the same number "aktiv".
 *
 * `secondary` wins because it is the majority and because a running count sits
 * next to a headline number, where a filled badge would outshout it. The verb
 * wins over the adjective: a run is something that happens, not a property.
 *
 * Nothing at zero - a badge that says "0 laufen" is noise.
 */
export function RunningBadge({
  count,
  className,
}: {
  count: number;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <Badge variant="secondary" className={cn('animate-pulse tabular-nums', className)}>
      {formatNumber(count)} running
    </Badge>
  );
}
