import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Trash2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ToolServerAudience } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TEMPLATE = `## Wann
Wenn der Nutzer ... möchte.

## Schritte
1. ...
2. ...

## Woran man merkt, dass es fertig ist
- ...
`;

/** Create or edit one skill: name, one-line description, audience, the instructions. */
export function SkillFormPage() {
  const { name: existing } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const editing = Boolean(existing);

  const [name, setName] = useState(existing ?? '');
  const [description, setDescription] = useState('');
  const [audience, setAudience] = useState<ToolServerAudience>('both');
  const [body, setBody] = useState(TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(!editing);

  useEffect(() => {
    if (!existing) return;
    api
      .skill(existing)
      .then((skill) => {
        setName(skill.name);
        setDescription(skill.description);
        setAudience(skill.audience);
        setBody(skill.body);
      })
      .catch((caught: Error) => toast.error('Skill konnte nicht geladen werden', { description: caught.message }))
      .finally(() => setLoaded(true));
  }, [existing]);

  const save = async (): Promise<void> => {
    if (!name.trim() || !description.trim()) {
      toast.error('Name und Beschreibung sind Pflicht');
      return;
    }
    setBusy(true);
    try {
      const saved = await api.saveSkill(name.trim(), { description: description.trim(), audience, body });
      toast(editing ? 'Skill gespeichert' : 'Skill angelegt');
      navigate('/skills/' + saved.name + '/edit', { replace: true });
    } catch (caught) {
      toast.error('Speichern fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!existing) return;
    try {
      await api.deleteSkill(existing);
      toast('Skill gelöscht');
      navigate('/skills');
    } catch (caught) {
      toast.error('Löschen fehlgeschlagen', { description: (caught as Error).message });
    }
  };

  if (!loaded) return <div className="p-6 text-sm text-muted-foreground">Wird geladen …</div>;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{editing ? 'Skill bearbeiten' : 'Skill anlegen'}</h1>
          <p className="text-sm text-muted-foreground">
            Die Beschreibung entscheidet, wann der Skill geöffnet wird: ein Satz, der die Aufgabe trifft.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Skill</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="skill-name" className="text-[12px] text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="skill-name"
                  value={name}
                  disabled={editing}
                  placeholder="z. B. wochenbericht"
                  onChange={(event) => setName(event.target.value)}
                />
                <p className="text-[10.5px] text-muted-foreground/80">Kleinbuchstaben, Ziffern, Bindestriche. Wird zum Ordnernamen.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="skill-audience" className="text-[12px] text-muted-foreground">
                  Für wen
                </Label>
                <Select value={audience} onValueChange={(value) => setAudience(value as ToolServerAudience)}>
                  <SelectTrigger id="skill-audience" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="both">Assistent und Agenten</SelectItem>
                    <SelectItem value="assistant">Nur der Assistent</SelectItem>
                    <SelectItem value="agents">Nur die Agenten</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-description" className="text-[12px] text-muted-foreground">
                Beschreibung
              </Label>
              <Input
                id="skill-description"
                value={description}
                placeholder="Wann dieser Skill gilt, in einem Satz."
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="skill-body" className="text-[12px] text-muted-foreground">
                Anleitung (Markdown)
              </Label>
              <Textarea
                id="skill-body"
                rows={18}
                className="font-mono text-[13px]"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {editing && (
                <Button variant="ghost" className="me-auto" onClick={() => void remove()}>
                  <Trash2Icon />
                  Löschen
                </Button>
              )}
              <Button variant="ghost" onClick={() => navigate('/skills')}>
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
