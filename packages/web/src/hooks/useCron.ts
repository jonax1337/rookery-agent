import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { RookerySocket } from '../lib/socket';
import type { CronJob, CronRun } from '../lib/types';

/**
 * The schedules, kept fresh.
 *
 * One fetch for the list and the recent runs; after that the `cron` broadcast
 * carries every change - a job edited here, by the assistant in a turn, or a
 * run the clock started - so those are merged in memory by id.
 */

export interface CronState {
  jobs: CronJob[];
  /** Recent runs across every job, newest first. */
  runs: CronRun[];
  /** Ids of jobs with a run in flight. */
  running: Set<string>;
  loading: boolean;
  error: string | null;
  jobById(id: string | undefined): CronJob | undefined;
  refresh(): Promise<void>;
}

export function useCron(socket: RookerySocket): CronState {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const overview = await api.cron();
      setJobs(overview.jobs);
      setRuns(overview.runs);
      setRunning(new Set(overview.running));
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.offline) setError('No connection to the Rookery server.');
      else setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      socket.onCron((event) => {
        setJobs((current) => {
          const rest = current.filter((job) => job.id !== event.job.id);
          return event.deleted ? rest : [...rest, event.job].sort(byOrder);
        });
        if (event.deleted) {
          setRuns((current) => current.filter((run) => run.jobId !== event.job.id));
          setRunning((current) => without(current, event.job.id));
          return;
        }
        const run = event.run;
        if (!run) return;
        setRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)].slice(0, 100));
        setRunning((current) => (run.status === 'running' ? withId(current, run.jobId) : without(current, run.jobId)));
      }),
    [socket],
  );

  const jobById = useCallback((id: string | undefined) => jobs.find((job) => job.id === id), [jobs]);

  return useMemo(
    () => ({ jobs, runs, running, loading, error, jobById, refresh }),
    [jobs, runs, running, loading, error, jobById, refresh],
  );
}

/** Enabled first, then by next run, then by name - the same order the server lists them. */
function byOrder(a: CronJob, b: CronJob): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  const next = (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity);
  return next !== 0 ? next : a.name.localeCompare(b.name);
}

function withId(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set;
  const next = new Set(set);
  next.add(id);
  return next;
}

function without(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}
