import { toast } from 'sonner';

import { ApiError } from './api';

/**
 * What a failed call is allowed to say out loud.
 *
 * `toast.error('<Tat> fehlgeschlagen', { description: (caught as Error).message })`
 * stood fifty-five times in the pages. Folding it does not save lines - one
 * line stays one line - it fixes what the line said: `ApiError` carries an
 * `offline` flag (set in `api.ts` when `fetch` itself rejects) and not a single
 * call site read it. A stopped backend reached the reader as the browser's raw
 * "Failed to fetch".
 */

/** What the reader is told when the server is not answering at all. */
export const OFFLINE_MESSAGE =
  'The Rookery server is not responding. Is it still running?';

/**
 * One sentence for any thrown thing.
 *
 * Every call in `lib/api.ts` throws `ApiError` and nothing else, so the last
 * branch is a guard against future callers, not against today's.
 */
export function failureMessage(caught: unknown): string {
  if (caught instanceof ApiError) {
    if (caught.offline) return OFFLINE_MESSAGE;
    return caught.message || 'Unknown error';
  }
  if (caught instanceof Error && caught.message) return caught.message;
  return 'Unknown error';
}

/**
 * The failure toast, said the same way everywhere.
 *
 * `action` is the deed that did not happen, as a noun: "Löschen",
 * "Archivieren", "Speichern". The headline reads "<Tat> fehlgeschlagen".
 *
 * ```ts
 * try { await remove(skill.name); } catch (caught) { reportFailure('Löschen', caught); }
 * ```
 */
export function reportFailure(action: string, caught: unknown): void {
  toast.error(action + ' failed', { description: failureMessage(caught) });
}
