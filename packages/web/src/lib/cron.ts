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
  running: 'Läuft',
  done: 'Erledigt',
  failed: 'Fehlgeschlagen',
};

export const CRON_RUN_STATUS_VARIANT: Record<CronRunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  done: 'secondary',
  failed: 'destructive',
};

export const CRON_TRIGGER_LABEL: Record<CronTrigger, string> = {
  schedule: 'nach Plan',
  manual: 'von Hand',
};

/** Common timetables, so nobody has to know cron syntax for the usual cases. */
export const CRON_PRESETS: { label: string; schedule: string }[] = [
  { label: 'Täglich um 08:00', schedule: '0 8 * * *' },
  { label: 'Montags bis freitags um 08:00', schedule: '0 8 * * 1-5' },
  { label: 'Täglich um 18:00', schedule: '0 18 * * *' },
  { label: 'Jeden Montag um 09:00', schedule: '0 9 * * 1' },
  { label: 'Jeden Freitag um 17:00', schedule: '0 17 * * 5' },
  { label: 'Am 1. jedes Monats um 09:00', schedule: '0 9 1 * *' },
  { label: 'Stündlich', schedule: '0 * * * *' },
  { label: 'Alle 15 Minuten', schedule: '*/15 * * * *' },
];

export const CUSTOM_SCHEDULE = '__custom__';

/**
 * Moved to `lib/format.ts` (and implemented once in `lib/stats.ts`) when the
 * dashboard pages started needing it too. Re-exported here so the schedule
 * pages' existing imports keep working.
 */
export { formatDateTime } from './format';
