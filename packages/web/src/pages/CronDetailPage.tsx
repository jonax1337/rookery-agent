import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { MessagesSquareIcon, PencilIcon, PlayIcon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import {
  CRON_RUN_STATUS_LABEL,
  CRON_RUN_STATUS_VARIANT,
  CRON_TRIGGER_LABEL,
  formatDateTime,
} from '@/lib/cron';
import { formatDuration, relativeTime } from '@/lib/format';
import type { CronJobDetail, CronRun } from '@/lib/types';
import type { CronState } from '@/hooks/useCron';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

/**
 * One schedule: what it does, when it fires next, and every run so far. The
 * detail is fetched once and refetched whenever the socket reports a change
 * to this job, so a run's result appears as soon as it is in.
 */
export function CronDetailPage({ cron }: { cron: CronState }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<CronJobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!id) return;
    try {
      setDetail(await api.cronJob(id));
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // The hook's copy of this job changes identity on every broadcast about it.
  const live = cron.jobById(id);
  const running = id ? cron.running.has(id) : false;
  useEffect(() => {
    void load();
  }, [live, running, load]);

  const runNow = async (): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await api.runCronJob(id);
      toast('Zeitplan gestartet');
    } catch (caught) {
      toast.error('Start fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (enabled: boolean): Promise<void> => {
    if (!id) return;
    setBusy(true);
    try {
      await api.updateCronJob(id, { enabled });
      toast(enabled ? 'Zeitplan aktiviert' : 'Zeitplan pausiert');
    } catch (caught) {
      toast.error('Änderung fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!id) return;
    try {
      await api.deleteCronJob(id);
      toast('Zeitplan gelöscht');
      navigate('/cron');
    } catch (caught) {
      toast.error('Löschen fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  if (error) return <div className="p-6 text-sm text-destructive">{error}</div>;
  if (!detail) return <div className="p-6 text-sm text-muted-foreground">Wird geladen …</div>;

  const { job, runs, agent, project, session, next, description } = detail;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{job.name}</h1>
              <Badge variant="outline">{agent ? agent.name + ' · ' + agent.title : 'Assistent'}</Badge>
              {job.once && <Badge variant="outline">einmalig</Badge>}
              {running && <Badge variant={CRON_RUN_STATUS_VARIANT.running}>{CRON_RUN_STATUS_LABEL.running}</Badge>}
              {!job.enabled && <Badge variant="secondary">Pausiert</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {description} · <code className="rounded bg-muted px-1 py-0.5">{job.schedule}</code>
              {project ? ' · Projekt ' + project.name : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={job.enabled} disabled={busy} onCheckedChange={(checked) => void toggle(checked)} />
              Aktiv
            </label>
            <Button type="button" variant="outline" size="sm" disabled={running || busy} onClick={() => void runNow()}>
              <PlayIcon />
              Jetzt ausführen
            </Button>
            <Button type="button" variant="outline" size="sm" asChild>
              <NavLink to={'/cron/' + job.id + '/edit'}>
                <PencilIcon />
                Bearbeiten
              </NavLink>
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => void remove()}>
              <Trash2Icon />
              Löschen
            </Button>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-[2fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Anweisung</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm">{job.prompt}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Nächste Läufe</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {job.enabled && next.length ? (
                <ul className="space-y-1">
                  {next.map((at) => (
                    <li key={at}>{formatDateTime(at)}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">Pausiert.</p>
              )}
              {session && (
                <Button type="button" variant="outline" size="sm" className="w-full" asChild>
                  <NavLink to={'/c/' + session.id}>
                    <MessagesSquareIcon />
                    Gespräch öffnen
                  </NavLink>
                </Button>
              )}
              <p className="text-xs text-muted-foreground">
                {job.runCount} {job.runCount === 1 ? 'Lauf' : 'Läufe'} bisher
                {job.lastRunAt ? ', zuletzt ' + relativeTime(job.lastRunAt) : ''}.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Läufe</CardTitle>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch nicht gelaufen.</p>
            ) : (
              <ul className="divide-y">
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: CronRun }) {
  const [open, setOpen] = useState(false);
  const text = run.error ?? run.result ?? '';
  const long = text.length > 400;
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={CRON_RUN_STATUS_VARIANT[run.status]} className="h-5 font-normal">
          {CRON_RUN_STATUS_LABEL[run.status]}
        </Badge>
        <span>{formatDateTime(run.startedAt)}</span>
        <span className="text-muted-foreground">{CRON_TRIGGER_LABEL[run.trigger]}</span>
        {run.durationMs !== undefined && <span className="text-muted-foreground">{formatDuration(run.durationMs)}</span>}
        {run.assignmentId && (
          <NavLink to={'/assignments/' + run.assignmentId} className="text-xs underline-offset-2 hover:underline">
            Auftrag ansehen
          </NavLink>
        )}
        {run.sessionId && (
          <NavLink to={'/c/' + run.sessionId} className="text-xs underline-offset-2 hover:underline">
            Gespräch ansehen
          </NavLink>
        )}
      </div>
      {text && (
        <div className="space-y-1">
          <p className={'whitespace-pre-wrap text-sm ' + (run.error ? 'text-destructive' : 'text-muted-foreground')}>
            {open || !long ? text : text.slice(0, 400) + ' …'}
          </p>
          {long && (
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(!open)}>
              {open ? 'Weniger' : 'Alles anzeigen'}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
