import { CRON_TRIGGER_LABEL } from '@/lib/cron';
import { formatDuration } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { SleepRun } from '@/lib/types';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { MetaList } from '@/components/common/meta-list';
import { StatusBadge } from '@/components/common/status-badge';
import { Badge } from '@/components/ui/badge';

import { NIGHT_COUNTERS, counterValue, reportText } from './night-run';

/**
 * One drawer for the whole table instead of one per row: two hundred mounted
 * vaul instances would each bring their own portal and focus trap.
 */
export function NightReportDrawer({
  run,
  onClose,
}: {
  run: SleepRun | null;
  onClose(): void;
}) {
  return (
    <DetailDrawer
      open={run !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Night report"
      description={
        run ? formatDateTime(run.startedAt) + ' · ' + CRON_TRIGGER_LABEL[run.trigger] : undefined
      }
    >
      {run ? <NightReport run={run} /> : null}
    </DetailDrawer>
  );
}

function NightReport({ run }: { run: SleepRun }) {
  const text = reportText(run);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge kind="sleepRun" status={run.status} />
        {run.undoneAt ? <Badge variant="outline">undone</Badge> : null}
        {run.durationMs !== undefined ? (
          <span className="text-muted-foreground">{formatDuration(run.durationMs)}</span>
        ) : null}
      </div>

      <MetaList
        columns={2}
        items={[
          // Every counter is shown, absent dream counters as 0 and not as a
          // dropped row: a night that ran the dream stage and found nothing is a
          // result, and `MetaList` drops an `undefined` value, which would have
          // read as "the stage never ran".
          ...NIGHT_COUNTERS.map(({ key, label }) => ({
            label,
            value: formatNumber(counterValue(run, key)),
          })),
          {
            label: 'Conflicts',
            value:
              run.conflictCount === 0
                ? null
                : formatNumber(run.resolvedCount) +
                  ' of ' +
                  formatNumber(run.conflictCount) +
                  ' resolved',
          },
        ]}
      />

      {text ? (
        <pre
          className={
            'whitespace-pre-wrap break-words font-mono text-xs ' +
            (run.error ? 'text-destructive' : '')
          }
        >
          {text}
        </pre>
      ) : null}
    </>
  );
}
