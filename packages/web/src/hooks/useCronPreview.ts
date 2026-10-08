import { useEffect, useState } from 'react';

import { api } from '@/lib/api';
import type { CronPreview, CronTriggerMode } from '@/lib/types';

const PREVIEW_DEBOUNCE_MS = 250;

/**
 * The server's reading of a cron expression.
 *
 * Debounced, because the endpoint is cheap but one request per keystroke is
 * not, and the answer for a half-typed expression is noise either way.
 */
export function useCronPreview(
  schedule: string,
  triggerMode: CronTriggerMode,
): { preview: CronPreview | null; checking: boolean } {
  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const wanted = schedule.trim();
    // Nothing to preview without a clock, and nothing that may block the save
    // either: an event-only schedule is allowed to carry a stale expression.
    if (!wanted || triggerMode === 'event') {
      setPreview(null);
      setChecking(false);
      return;
    }
    setChecking(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .cronPreview(wanted)
        .then((next) => {
          if (!cancelled) setPreview(next);
        })
        // A failed request is not an invalid expression: leave the last
        // answer standing rather than claiming the timetable is broken.
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [schedule, triggerMode]);

  return { preview, checking };
}
