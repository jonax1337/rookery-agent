import { useState } from 'react';
import { NavLink } from 'react-router';
import { CalendarClockIcon, PlayIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CRON_RUN_STATUS_LABEL, CRON_RUN_STATUS_VARIANT, formatDateTime } from '@/lib/cron';
import { relativeTime } from '@/lib/format';
import type { CronJob } from '@/lib/types';
import type { CronState } from '@/hooks/useCron';
import type { OrgState } from '@/hooks/useOrg';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

/**
 * The schedules: standing orders that fire while the server runs. The list
 * comes from the cron hook and follows the socket, so a run the clock starts
 * shows up here the moment it does.
 */
export function CronPage({ cron, org }: { cron: CronState; org: OrgState }) {
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (job: CronJob, enabled: boolean): Promise<void> => {
    setBusy(job.id);
    try {
      await api.updateCronJob(job.id, { enabled });
      toast(enabled ? 'Zeitplan aktiviert' : 'Zeitplan pausiert');
    } catch (caught) {
      toast.error('Änderung fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (job: CronJob): Promise<void> => {
    setBusy(job.id);
    try {
      await api.runCronJob(job.id);
      toast('Zeitplan gestartet', { description: job.name });
    } catch (caught) {
      toast.error('Start fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Zeitpläne</h1>
            <p className="text-sm text-muted-foreground">
              Aufträge, die von selbst zu einer festen Zeit laufen, solange der Server läuft. Der Assistent
              erledigt sie in einem eigenen Gespräch, oder ein Agent übernimmt sie als Auftrag. Das Ergebnis
              landet im Posteingang des Assistenten. Auch im Chat anlegbar: „Jeden Morgen um 8 …“.
            </p>
          </div>
          <Button asChild>
            <NavLink to="/cron/new">
              <PlusIcon />
              Zeitplan anlegen
            </NavLink>
          </Button>
        </div>

        {cron.error && <p className="text-sm text-destructive">{cron.error}</p>}

        {cron.loading ? (
          <p className="text-sm text-muted-foreground">Wird geladen …</p>
        ) : cron.jobs.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Noch keine Zeitpläne. Leg einen an, etwa ein Morgenbriefing um 08:00 oder eine Erinnerung für
              morgen Nachmittag.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent>
              <ul className="divide-y">
                {cron.jobs.map((job) => {
                  const running = cron.running.has(job.id);
                  const agent = job.kind === 'agent' ? org.agentById(job.agentId) : undefined;
                  return (
                    <li key={job.id} className="flex flex-wrap items-center gap-3 py-3">
                      <CalendarClockIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <NavLink to={'/cron/' + job.id} className="font-medium hover:underline">
                            {job.name}
                          </NavLink>
                          <Badge variant="outline" className="h-5 font-normal">
                            {agent ? agent.name : 'Assistent'}
                          </Badge>
                          {job.once && (
                            <Badge variant="outline" className="h-5 font-normal">
                              einmalig
                            </Badge>
                          )}
                          {running ? (
                            <Badge variant={CRON_RUN_STATUS_VARIANT.running} className="h-5 font-normal">
                              {CRON_RUN_STATUS_LABEL.running}
                            </Badge>
                          ) : job.lastStatus ? (
                            <Badge variant={CRON_RUN_STATUS_VARIANT[job.lastStatus]} className="h-5 font-normal">
                              {CRON_RUN_STATUS_LABEL[job.lastStatus]}
                              {job.lastRunAt ? ' · ' + relativeTime(job.lastRunAt) : ''}
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          <code className="rounded bg-muted px-1 py-0.5">{job.schedule}</code>
                          {' · '}
                          {job.enabled
                            ? 'Nächster Lauf ' + formatDateTime(job.nextRunAt)
                            : 'Pausiert'}
                          {job.runCount > 0 ? ' · ' + job.runCount + (job.runCount === 1 ? ' Lauf' : ' Läufe') : ''}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={running || busy === job.id}
                        onClick={() => void runNow(job)}
                      >
                        <PlayIcon />
                        Jetzt ausführen
                      </Button>
                      <Switch
                        checked={job.enabled}
                        disabled={busy === job.id}
                        aria-label={job.enabled ? 'Zeitplan pausieren' : 'Zeitplan aktivieren'}
                        onCheckedChange={(checked) => void toggle(job, checked)}
                      />
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
