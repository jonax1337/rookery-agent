import { useCallback, useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { ExternalLinkIcon, Loader2Icon, Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ToolServer, ToolServerAudience } from '@/lib/types';
import { AUDIENCE_LABEL, INSTALL_LABEL, toolStatus } from '@/lib/tools';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type ToolPatch = Parameters<typeof api.updateTool>[1];

/** One server: switch, audience, options, keys, preparation. Each change saves at once. */
export function ToolDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tool, setTool] = useState<ToolServer | null>(null);
  const [loading, setLoading] = useState(true);
  const [textDraft, setTextDraft] = useState<Record<string, string>>({});
  const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
  const [preparing, setPreparing] = useState(false);

  const load = useCallback(async () => {
    try {
      const all = await api.tools();
      setTool(all.find((entry) => entry.id === id) ?? null);
    } catch (caught) {
      toast.error('Werkzeug konnte nicht geladen werden', { description: (caught as Error).message });
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (change: ToolPatch): Promise<void> => {
    if (!tool) return;
    try {
      setTool(await api.updateTool(tool.id, change));
    } catch (caught) {
      toast.error('Änderung fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  const prepare = async (): Promise<void> => {
    if (!tool) return;
    setPreparing(true);
    try {
      const result = await api.prepareTool(tool.id);
      if (result.ok) toast('Vorbereitung abgeschlossen');
      else toast.error('Vorbereitung fehlgeschlagen', { description: result.output.slice(-300) });
      await load();
    } catch (caught) {
      toast.error('Vorbereitung fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setPreparing(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!tool) return;
    try {
      await api.deleteTool(tool.id);
      toast(tool.install === 'custom' ? 'Server entfernt' : 'Auf Standard zurückgesetzt');
      if (tool.install === 'custom') navigate('/tools');
      else await load();
    } catch (caught) {
      toast.error('Entfernen fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  if (loading) return <Shell>Wird geladen …</Shell>;
  if (!tool) return <Shell>Diesen Server gibt es nicht.</Shell>;

  const status = toolStatus(tool);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{tool.name}</h1>
              <Badge variant={status.tone === 'on' ? 'default' : 'secondary'} className="h-5">
                {status.label}
              </Badge>
              <Badge variant="outline" className="h-5 font-normal">
                {INSTALL_LABEL[tool.install]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{tool.description}</p>
          </div>
          <div className="flex items-center gap-3">
            <Label htmlFor="tool-enabled" className="text-sm">
              {tool.enabled ? 'An' : 'Aus'}
            </Label>
            <Switch
              id="tool-enabled"
              checked={tool.enabled}
              disabled={!tool.installed}
              onCheckedChange={(on) => void patch({ enabled: on })}
            />
          </div>
        </div>

        {tool.missingEnv.length > 0 && (
          <p className="rounded-lg border border-amber-500/40 p-3 text-sm">
            Bleibt aus, bis {tool.missingEnv.join(', ')} eingetragen ist.
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Einstellungen</CardTitle>
            <CardDescription>Jede Änderung wird sofort gespeichert und gilt ab dem nächsten Turn.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tool-audience" className="text-[12px] text-muted-foreground">
                Für wen
              </Label>
              <Select value={tool.audience} onValueChange={(value) => void patch({ audience: value as ToolServerAudience })}>
                <SelectTrigger id="tool-audience" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(AUDIENCE_LABEL) as ToolServerAudience[]).map((value) => (
                    <SelectItem key={value} value={value}>
                      {AUDIENCE_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {tool.optionDefs.map((option) => (
              <div key={option.key} className="space-y-1.5">
                <Label htmlFor={'opt-' + option.key} className="text-[12px] text-muted-foreground">
                  {option.label}
                </Label>
                {option.type === 'select' ? (
                  <Select
                    value={tool.options[option.key] ?? option.default}
                    onValueChange={(value) => void patch({ options: { [option.key]: value } })}
                  >
                    <SelectTrigger id={'opt-' + option.key} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(option.choices ?? []).map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id={'opt-' + option.key}
                    value={textDraft[option.key] ?? tool.options[option.key] ?? ''}
                    onChange={(event) => setTextDraft({ ...textDraft, [option.key]: event.target.value })}
                    onBlur={() => {
                      const value = textDraft[option.key];
                      if (value !== undefined && value !== tool.options[option.key]) {
                        void patch({ options: { [option.key]: value } });
                      }
                    }}
                  />
                )}
                {option.hint && <p className="text-[10.5px] text-muted-foreground/80">{option.hint}</p>}
              </div>
            ))}
          </CardContent>
        </Card>

        {tool.envDefs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Schlüssel</CardTitle>
              <CardDescription>Werden in der Rookery-Config gespeichert und nur dem Server-Prozess übergeben.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {tool.envDefs.map((item) => (
                <div key={item.name} className="space-y-1.5">
                  <Label htmlFor={'env-' + item.name} className="text-[12px] text-muted-foreground">
                    {item.label}
                    {item.required ? '' : ' (optional)'}
                  </Label>
                  <Input
                    id={'env-' + item.name}
                    type={item.secret ? 'password' : 'text'}
                    placeholder={tool.envSet[item.name] ? 'gesetzt, zum Ändern neu eingeben' : 'nicht gesetzt'}
                    value={envDraft[item.name] ?? ''}
                    onChange={(event) => setEnvDraft({ ...envDraft, [item.name]: event.target.value })}
                    onBlur={() => {
                      const value = envDraft[item.name];
                      if (value) {
                        void patch({ env: { [item.name]: value } }).then(() =>
                          setEnvDraft((current) => ({ ...current, [item.name]: '' })),
                        );
                      }
                    }}
                  />
                  {item.hint && <p className="text-[10.5px] text-muted-foreground/80">{item.hint}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {tool.custom && (
          <Card>
            <CardHeader>
              <CardTitle>Befehl</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="rounded-lg bg-muted/60 p-3 font-mono text-[12px]">
                {tool.custom.command} {tool.custom.args.join(' ')}
              </p>
              {tool.custom.hint && <p className="text-sm text-muted-foreground">{tool.custom.hint}</p>}
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {tool.prepare && (
            <Button variant="outline" disabled={preparing} onClick={() => void prepare()}>
              {preparing ? <Loader2Icon className="animate-spin" /> : null}
              {tool.prepare.label}
            </Button>
          )}
          {tool.homepage && (
            <Button variant="ghost" asChild>
              <a href={tool.homepage} target="_blank" rel="noreferrer">
                Projektseite
                <ExternalLinkIcon />
              </a>
            </Button>
          )}
          <Button variant="ghost" className="ms-auto" onClick={() => void remove()}>
            <Trash2Icon />
            {tool.install === 'custom' ? 'Entfernen' : 'Zurücksetzen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: string }) {
  return (
    <div className="p-6 text-sm text-muted-foreground">
      {children}{' '}
      <NavLink to="/tools" className="underline underline-offset-2">
        Zurück zu den Werkzeugen
      </NavLink>
    </div>
  );
}
