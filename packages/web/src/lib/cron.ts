import type { CronRun, CronRunStatus, CronTrigger, CronTriggerMode } from './types';

/** Labels and presets for the schedule pages. */

/**
 * What a run has to say for itself: its error, else its result.
 *
 * The list and the detail page both open a report dialog from a row, and both
 * had to answer this question the same way.
 */
export function cronRunReport(run: CronRun): string {
  return run.error ?? run.result ?? '';
}

export const CRON_RUN_STATUS_LABEL: Record<CronRunStatus, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
};

export const CRON_RUN_STATUS_VARIANT: Record<CronRunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  done: 'secondary',
  failed: 'destructive',
};

export const CRON_TRIGGER_LABEL: Record<CronTrigger, string> = {
  schedule: 'scheduled',
  manual: 'manual',
  event: 'event',
};

/**
 * What fired a run, in one line.
 *
 * An event run without its source reads exactly like a clock run, which is
 * the one thing a run history must not do once both exist - so the source
 * comes along wherever the trigger is printed.
 */
export function cronRunTrigger(run: CronRun): string {
  const label = CRON_TRIGGER_LABEL[run.trigger];
  return run.trigger === 'event' && run.source ? label + ' · ' + run.source : label;
}

/**
 * The trigger-mode radio cards. Typed structurally rather than as
 * `ChoiceOption<…>` for the same reason `PERMISSION_CHOICES` is: the shape
 * matches, and `lib/` has no business importing from `components/`.
 */
export const CRON_TRIGGER_MODE_CHOICES: {
  value: CronTriggerMode;
  label: string;
  description: string;
}[] = [
  {
    value: 'schedule',
    label: 'On a timetable',
    description: 'The clock fires it. An event can still fire it in between.',
  },
  {
    value: 'event',
    label: 'Only on an event',
    description: 'No timetable: it runs when a webhook is called or a listener sees something.',
  },
];

/**
 * The rest after an event-driven run, when the job names none of its own.
 * Mirrors `DEFAULT_EVENT_COOLDOWN_MS` in core - the form shows it as the
 * value a new schedule starts with.
 */
export const DEFAULT_EVENT_COOLDOWN_MS = 60_000;

/** Common timetables, so nobody has to know cron syntax for the usual cases. */
export const CRON_PRESETS: { label: string; schedule: string }[] = [
  { label: 'Daily at 08:00', schedule: '0 8 * * *' },
  { label: 'Monday to Friday at 08:00', schedule: '0 8 * * 1-5' },
  { label: 'Daily at 18:00', schedule: '0 18 * * *' },
  { label: 'Every Monday at 09:00', schedule: '0 9 * * 1' },
  { label: 'Every Friday at 17:00', schedule: '0 17 * * 5' },
  { label: 'On the first of every month at 09:00', schedule: '0 9 1 * *' },
  { label: 'Hourly', schedule: '0 * * * *' },
  { label: 'Every 15 minutes', schedule: '*/15 * * * *' },
];

export const CUSTOM_SCHEDULE = '__custom__';

/**
 * Moved to `lib/format.ts` (and implemented once in `lib/stats.ts`) when the
 * dashboard pages started needing it too. Re-exported here so the schedule
 * pages' existing imports keep working.
 */
export { formatDateTime } from './format';
