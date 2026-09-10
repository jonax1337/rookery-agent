import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { CRON_PRESETS, CUSTOM_SCHEDULE, formatDateTime } from '@/lib/cron';
import type { CronPreview } from '@/lib/types';
import type { CronState } from '@/hooks/useCron';
import type { OrgState } from '@/hooks/useOrg';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/** Radix selects have no empty value, so "the assistant" and "no project" need sentinels. */
const ASSISTANT = '__assistant__';
const NO_PROJECT = '__none__';

const PROMPT_PLACEHOLDER =
  'Was bei jedem Lauf zu tun ist, so dass es ohne Rückfragen geht. Etwa: „Sieh dir die offenen Aufgaben ' +
  'und die Aufträge der letzten 24 Stunden an und fasse in fünf Sätzen zusammen, was passiert ist und was ' +
  'heute ansteht.“';

/** Create or edit one schedule: name, timetable with a live preview, who runs it, the prompt. */
export function CronFormPage({ cron, org }: { cron: CronState; org: OrgState }) {
  const { id: existing } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const editing = Boolean(existing);

  const [name, setName] = useState('');
  const [preset, setPreset] = useState<string>(CRON_PRESETS[0]!.schedule);
  const [schedule, setSchedule] = useState(CRON_PRESETS[0]!.schedule);
  const [runner, setRunner] = useState<string>(ASSISTANT);
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [prompt, setPrompt] = useState('');
  const [once, setOnce] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [preview, setPreview] = useState<CronPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    if (!existing) return;
    api
      .cronJob(existing)
      .then(({ job }) => {
        setName(job.name);
        setSchedule(job.schedule);
        setPreset(CRON_PRESETS.some((entry) => entry.schedule === job.schedule) ? job.schedule : CUSTOM_SCHEDULE);
        setRunner(job.kind === 'agent' && job.agentId ? job.agentId : ASSISTANT);
        setProjectId(job.projectId ?? NO_PROJECT);
        setPrompt(job.prompt);
        setOnce(job.once);
        setEnabled(job.enabled);
      })
      .catch((caught: Error) => toast.error('Zeitplan konnte nicht geladen werden', { description: caught.message }))
      .finally(() => setLoaded(true));
  }, [existing]);

  // The server owns the parser; the form only shows what it would do with
  // the expression, debounced so typing does not fire a request per key.
  useEffect(() => {
    const wanted = schedule.trim();
    if (!wanted) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      void api
        .cronPreview(wanted)
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 250);
    return () => clearTimeout(timer);
  }, [schedule]);

  const choosePreset = (value: string): void => {
    setPreset(value);
    if (value !== CUSTOM_SCHEDULE) setSchedule(value);
  };

  const save = async (): Promise<void> => {
    if (!name.trim() || !schedule.trim() || !prompt.trim()) {
      toast.error('Name, Zeitplan und Anweisung sind Pflicht');
      return;
    }
    if (preview && !preview.ok) {
      toast.error('Der Zeitplan ist ungültig', { description: preview.error });
      return;
    }
    setBusy(true);
    const agentId = runner === ASSISTANT ? null : runner;
    try {
      let savedId: string;
      if (existing) {
        const saved = await api.updateCronJob(existing, {
          name: name.trim(),
          schedule: schedule.trim(),
          prompt: prompt.trim(),
          agentId,
          projectId: projectId === NO_PROJECT ? null : projectId,
          once,
          enabled,
        });
        savedId = saved.id;
        toast('Zeitplan gespeichert');
      } else {
        const saved = await api.createCronJob({
          name: name.trim(),
          schedule: schedule.trim(),
          prompt: prompt.trim(),
          ...(agentId ? { agentId } : {}),
          ...(projectId !== NO_PROJECT ? { projectId } : {}),
          once,
          enabled,
        });
        savedId = saved.id;
        toast('Zeitplan angelegt', { description: preview?.description });
      }
      void cron.refresh();
      navigate('/cron/' + savedId, { replace: true });
    } catch (caught) {
      toast.error('Speichern fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!existing) return;
    try {
      await api.deleteCronJob(existing);
      toast('Zeitplan gelöscht');
      navigate('/cron');
    } catch (caught) {
      toast.error('Löschen fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  if (!loaded) return <div className="p-6 text-sm text-muted-foreground">Wird geladen …</div>;

  const agents = org.agents.filter((agent) => !agent.archived);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {editing ? 'Zeitplan bearbeiten' : 'Zeitplan anlegen'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Zeiten gelten in der Zeitzone des Rechners, auf dem der Server läuft.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Zeitplan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cron-name" className="text-[12px] text-muted-foreground">
                Name
              </Label>
              <Input
                id="cron-name"
                value={name}
                placeholder="z. B. Morgenbriefing"
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cron-preset" className="text-[12px] text-muted-foreground">
                  Wann
                </Label>
                <Select value={preset} onValueChange={choosePreset}>
                  <SelectTrigger id="cron-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CRON_PRESETS.map((entry) => (
                      <SelectItem key={entry.schedule} value={entry.schedule}>
                        {entry.label}
                      </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_SCHEDULE}>Eigener Cron-Ausdruck</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cron-schedule" className="text-[12px] text-muted-foreground">
                  Cron-Ausdruck
                </Label>
                <Input
                  id="cron-schedule"
                  value={schedule}
                  className="font-mono"
                  placeholder="Minute Stunde Tag Monat Wochentag"
                  onChange={(event) => {
                    setSchedule(event.target.value);
                    setPreset(CUSTOM_SCHEDULE);
                  }}
                />
                <p className="text-[10.5px] text-muted-foreground/80">
                  Fünf Felder: Minute, Stunde, Tag, Monat, Wochentag. „0 8 * * 1-5“ ist werktags um 08:00.
                </p>
              </div>
            </div>

            {preview && (
              <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                {preview.ok ? (
                  <>
                    <p className="font-medium">{preview.description}</p>
                    <p className="text-xs text-muted-foreground">
                      Nächste Läufe: {preview.next.slice(0, 3).map((at) => formatDateTime(at)).join(' · ')}
                    </p>
                  </>
                ) : (
                  <p className="text-destructive">{preview.error}</p>
                )}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cron-runner" className="text-[12px] text-muted-foreground">
                  Wer führt aus
                </Label>
                <Select value={runner} onValueChange={setRunner}>
                  <SelectTrigger id="cron-runner" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ASSISTANT}>Der Assistent selbst</SelectItem>
                    {agents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name} · {agent.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10.5px] text-muted-foreground/80">
                  Der Assistent arbeitet in einem eigenen Gespräch mit all seinen Werkzeugen; ein Agent bekommt
                  einen Auftrag im Projektverzeichnis.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cron-project" className="text-[12px] text-muted-foreground">
                  Projekt
                </Label>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="cron-project" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROJECT}>Kein Projekt</SelectItem>
                    {org.projects
                      .filter((project) => !project.archived)
                      .map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cron-prompt" className="text-[12px] text-muted-foreground">
                Anweisung
              </Label>
              <Textarea
                id="cron-prompt"
                rows={8}
                value={prompt}
                placeholder={PROMPT_PLACEHOLDER}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={once} onCheckedChange={setOnce} />
                Einmalig, danach abschalten
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={enabled} onCheckedChange={setEnabled} />
                Aktiv
              </label>
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              {editing && (
                <Button variant="ghost" className="me-auto" onClick={() => void remove()}>
                  <Trash2Icon />
                  Löschen
                </Button>
              )}
              <Button variant="ghost" onClick={() => navigate(existing ? '/cron/' + existing : '/cron')}>
                Abbrechen
              </Button>
              <Button onClick={() => void save()} disabled={busy}>
                Speichern
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
