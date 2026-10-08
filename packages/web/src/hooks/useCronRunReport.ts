import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import type { CronJobDetail, CronRun } from '@/lib/types';

const RUN_PARAM = 'run';

/**
 * The run whose report is open in the drawer.
 *
 * `?run=<id>` opens that run's report - the deep link a schedule notification
 * uses. The parameter is consumed as soon as the detail is there, so a reload
 * does not reopen a drawer the user closed.
 */
export function useCronRunReport(detail: CronJobDetail | null): {
  report: CronRun | null;
  setReport(run: CronRun | null): void;
} {
  const [report, setReport] = useState<CronRun | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const runParam = searchParams.get(RUN_PARAM);

  useEffect(() => {
    if (!runParam || !detail) return;
    const run = detail.runs.find((entry) => entry.id === runParam);
    if (run) setReport(run);
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete(RUN_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [runParam, detail, setSearchParams]);

  return { report, setReport };
}
