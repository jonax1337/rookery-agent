import { useState } from 'react';
import { MoonIcon, PlayIcon, RotateCcwIcon, SquareIcon, TriangleAlertIcon } from 'lucide-react';
import type { SleepRun, SleepStatusView } from '../lib/types';
import { SLEEP_PHASE_DETAIL, SLEEP_PHASE_LABEL, relativeTime } from '../lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

interface SleepCardProps {
  status: SleepStatusView | null;
  runs: SleepRun[];
  /** The stage a running night is in, straight off the socket. */
  phase: string;
  /** Which cycle of the night that stage belongs to. */
  cycle: number;
  busy: boolean;
  onStart(): void;
  onCancel(): void;
  onUndo(id: string): Promise<unknown>;
}

/**
 * The night shift, for a person.
 *
 * Two jobs: say what is happening while it happens, and make every night
 * reversible afterwards. The undo button is not a nicety - a process that
 * rewrites memory unattended is only acceptable because it can be taken back.
 */
export function SleepCard({ status, runs, phase, cycle, busy, onStart, onCancel, onUndo }: SleepCardProps) {
  const [undoing, setUndoing] = useState<string | null>(null);
  const running = status?.running ?? false;
  const schedule = status?.schedule ?? null;

  const undo = async (id: string): Promise<void> => {
    setUndoing(id);
    try {
      await onUndo(id);
    } finally {
      setUndoing(null);
    }
  };

  return (
    <Card className="gap-3">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <MoonIcon className={'size-4 ' + (running ? 'animate-pulse text-primary' : 'text-muted-foreground')} />
          Schlaf
          {running ? (
            <>
              <Badge variant="secondary" className="h-4 px-1.5 text-[9.5px]">
                {SLEEP_PHASE_LABEL[phase] ?? 'arbeitet'}
                {cycle ? ' · Zyklus ' + cycle : ''}
              </Badge>
              <span className="text-[10.5px] font-normal text-muted-foreground">
                {SLEEP_PHASE_DETAIL[phase] ?? ''}
              </span>
            </>
          ) : null}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button size="sm" variant="outline" className="h-8" onClick={onCancel}>
              <SquareIcon className="size-3.5" />
              Aufwecken
            </Button>
          ) : (
            <Button size="sm" className="h-8" onClick={onStart} disabled={busy}>
              <PlayIcon className="size-3.5" />
              Jetzt schlafen
            </Button>
          )}

          <p className="text-[11px] text-muted-foreground">
            {schedule && schedule.enabled && schedule.nextRunAt
              ? 'Nächster Lauf ' +
                new Date(schedule.nextRunAt).toLocaleString('de-DE', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })
              : status?.config.enabled === false
                ? 'Der nächtliche Lauf ist abgeschaltet.'
                : 'Kein Zeitplan hinterlegt.'}
          </p>
        </div>

        {status ? (
          <p className="text-[10.5px] text-muted-foreground">
            Verdichten und Verknüpfen mit {status.config.model || 'Standardmodell'}, Einsichten mit{' '}
            {status.config.insightModel || status.config.model || 'Standardmodell'}. Höchstens{' '}
            {status.config.maxMergeCalls + 4} Modellaufrufe pro Nacht.
          </p>
        ) : null}

        {runs.length ? (
          <>
            <Separator />
            <ScrollArea className="max-h-64">
              <ul className="space-y-2 pr-3">
                {runs.map((run) => (
                  <li key={run.id} className="rounded-md border px-2.5 py-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs leading-snug">
                          {run.status === 'failed' ? (
                            <span className="inline-flex items-center gap-1 text-destructive">
                              <TriangleAlertIcon className="size-3" />
                              {run.error ?? 'Fehlgeschlagen'}
                            </span>
                          ) : (
                            run.report ?? '—'
                          )}
                        </p>
                        <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                          {relativeTime(run.startedAt)}
                          {run.durationMs ? ' · ' + Math.round(run.durationMs / 1000) + ' s' : ''}
                          {run.modelCalls ? ' · ' + run.modelCalls + ' Modellaufrufe' : ''}
                          {run.trigger === 'manual' ? ' · von Hand' : ' · nach Plan'}
                        </p>
                      </div>

                      {run.undoneAt ? (
                        <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[9.5px]">
                          zurückgenommen
                        </Badge>
                      ) : run.status === 'done' && (run.mergedCount || run.dormantCount || run.edgeCount) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 shrink-0 px-1.5 text-[10.5px]"
                          disabled={undoing === run.id}
                          onClick={() => void undo(run.id)}
                        >
                          <RotateCcwIcon className="size-3" />
                          Rückgängig
                        </Button>
                      ) : null}
                    </div>

                    {run.conflictCount > run.resolvedCount ? (
                      <p className="mt-1 text-[10.5px] text-destructive">
                        {run.conflictCount - run.resolvedCount === 1
                          ? 'Ein Widerspruch blieb offen'
                          : run.conflictCount - run.resolvedCount + ' Widersprüche blieben offen'}
                        {' '}— entweder stammen beide Seiten von dir, oder das Budget der Nacht war aufgebraucht.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Noch keine Nacht gelaufen. Leichtschlaf räumt auf, Tiefschlaf verdichtet und entscheidet
            Widersprüche, Traumschlaf verknüpft und zieht Schlüsse. Gelöscht wird dabei nichts, alles
            ist mit einem Klick zurückholbar.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
