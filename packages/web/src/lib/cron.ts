import type { CronRunStatus, CronTrigger } from './types';

/** Labels and presets for the schedule pages. */

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

export function formatDateTime(timestamp: number | undefined): string {
  if (!timestamp) return '–';
  return new Date(timestamp).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}
