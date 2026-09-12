import type { CronRun, CronRunStatus, CronTrigger } from './types';

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
};

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
