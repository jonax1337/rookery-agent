import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ToolServerAudience } from '@/lib/types';
import { AUDIENCE_LABEL } from '@/lib/tools';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** A server of the user's own: any stdio MCP command. */
export function ToolFormPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [hint, setHint] = useState('');
  const [audience, setAudience] = useState<ToolServerAudience>('assistant');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name.trim() || !command.trim()) {
      toast.error('Name und Befehl sind Pflicht');
      return;
    }
    setBusy(true);
    try {
      const created = await api.addCustomTool({
        name: name.trim(),
        command: command.trim(),
        args: args.split(/\s+/).filter(Boolean),
        hint: hint.trim(),
        audience,
      });
      toast('Server hinzugefügt');
      navigate('/tools/' + created.id);
    } catch (caught) {
      toast.error('Hinzufügen fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Eigener MCP-Server</h1>
          <p className="text-sm text-muted-foreground">
            Jeder stdio-MCP-Server geht. Umgebungsvariablen wie API-Keys lassen sich danach auf der Seite des Servers eintragen.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Server</CardTitle>
            <CardDescription>Der Hinweis sagt dem Assistenten, wofür die Werkzeuge gut sind und wann er sie nimmt.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="custom-name" className="text-[12px] text-muted-foreground">
                Name
              </Label>
              <Input id="custom-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="z. B. Notion" />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="custom-command" className="text-[12px] text-muted-foreground">
                  Befehl
                </Label>
                <Input id="custom-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="custom-args" className="text-[12px] text-muted-foreground">
                  Argumente
                </Label>
                <Input id="custom-args" value={args} onChange={(event) => setArgs(event.target.value)} placeholder="-y @notionhq/notion-mcp-server" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-audience" className="text-[12px] text-muted-foreground">
                Für wen
              </Label>
              <Select value={audience} onValueChange={(value) => setAudience(value as ToolServerAudience)}>
                <SelectTrigger id="custom-audience" className="w-full">
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
            <div className="space-y-1.5">
              <Label htmlFor="custom-hint" className="text-[12px] text-muted-foreground">
                Hinweis für den Assistenten
              </Label>
              <Textarea
                id="custom-hint"
                rows={3}
                value={hint}
                onChange={(event) => setHint(event.target.value)}
                placeholder="Wofür diese Werkzeuge gut sind und wann er sie nehmen soll."
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => navigate('/tools')}>
                Abbrechen
              </Button>
              <Button onClick={() => void submit()} disabled={busy}>
                Hinzufügen
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
