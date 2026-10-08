import { NavLink } from 'react-router';

import { isBoardWatch } from '@/lib/cron';
import { timeAgo } from '@/lib/format';
import type { RookerySocket } from '@/lib/socket';
import { useCron } from '@/hooks/useCron';

/**
 * That the board is being watched, said on the board.
 *
 * The watcher used to be a row in the schedules list, where it looked like
 * something the user had set up and could be switched off by accident. It
 * belongs here: it is a property of this page, not a standing order
 * (decision E5 of docs/concepts/work-as-one-surface.md). Nothing is claimed
 * when the job is missing - a line saying "not watched" would be noise on a
 * page whose job is to show work.
 */
export function BoardWatchLine({ socket }: { socket: RookerySocket }) {
  const cron = useCron(socket);
  const job = cron.jobs.find(isBoardWatch);
  if (!job) return null;
  const last = cron.runs.find((run) => run.jobId === job.id);
  return (
    <div className="px-4 text-sm text-muted-foreground lg:px-6">
      {job.enabled ? (
        <>
          Watching this board for failed and stuck work
          {last ? <> · last checked {timeAgo(last.startedAt)}</> : null} ·{' '}
          <NavLink to={'/cron/' + job.id} className="hover:underline">
            Settings
          </NavLink>
        </>
      ) : (
        <>
          Nobody is watching this board.{' '}
          <NavLink to={'/cron/' + job.id} className="text-foreground hover:underline">
            Turn the watcher back on
          </NavLink>
        </>
      )}
    </div>
  );
}
