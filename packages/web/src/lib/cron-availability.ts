import type { CronJob } from './types';

/**
 * Whether a schedule may not be switched on or started by hand.
 *
 * A script schedule runs code on this machine, so it waits for a person to
 * review it (permission `full`) first. A schedule with a finite number of
 * runs may have used them all.
 */
export function isRunBlocked(job: Pick<CronJob, 'kind' | 'permission' | 'remainingRuns'>): boolean {
  const awaitsScriptReview = job.kind === 'script' && job.permission !== 'full';
  const hasNoRunsLeft = job.remainingRuns === 0;
  return awaitsScriptReview || hasNoRunsLeft;
}
