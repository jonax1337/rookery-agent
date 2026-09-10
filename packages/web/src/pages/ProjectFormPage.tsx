import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { OrgState } from '@/hooks/useOrg';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/** Create or edit a project. Its path decides where assignments run. */
export function ProjectFormPage({ org }: { org: OrgState }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const existing = org.projects.find((project) => project.id === id);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState('');
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setDescription(existing.description ?? '');
    setPath(existing.path ?? '');
    setArchived(existing.archived);
  }, [existing]);

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      toast.error('Ein Name ist Pflicht');
      return;
    }
    setSaving(true);
    try {
      if (editing && id) {
        await api.updateProject(id, {
          name: name.trim(),
          description: description.trim() || null,
          path: path.trim() || null,
          archived,
        });
        toast('Projekt gespeichert');
      } else {
        await api.createProject({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(path.trim() ? { path: path.trim() } : {}),
        });
        toast('Projekt angelegt');
      }
      await org.refresh();
      void navigate('/org');
    } catch (error) {
      toast.error('Speichern fehlgeschlagen', { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!id) return;
    try {
      await api.deleteProject(id);
      await org.refresh();
      toast('Projekt entfernt');
      void navigate('/org');
    } catch (error) {
      toast.error('Löschen fehlgeschlagen', { description: (error as Error).message });
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {editing ? 'Projekt bearbeiten' : 'Projekt anlegen'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Ein Projekt bündelt Aufträge. Mit Verzeichnis arbeiten Agenten dort, ohne im
            Arbeitsraum.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Projekt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="project-name" className="text-[12px] text-muted-foreground">
                Name
              </Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-description" className="text-[12px] text-muted-foreground">
                Beschreibung
              </Label>
              <Textarea
                id="project-description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="project-path" className="text-[12px] text-muted-foreground">
                Verzeichnis
              </Label>
              <Input
                id="project-path"
                placeholder="optional, z. B. E:\\DEV\\mein-projekt"
                className="font-mono"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
              <p className="text-[10.5px] text-muted-foreground/80">
                Leer heißt: Aufträge laufen im Arbeitsraum von Rookery.
              </p>
            </div>
            {editing && (
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="project-archived" className="text-[12px] text-muted-foreground">
                  Archiviert
                </Label>
                <Switch id="project-archived" checked={archived} onCheckedChange={setArchived} />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          {editing && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              onClick={() => void remove()}
            >
              Projekt entfernen
            </Button>
          )}
          <Button variant="ghost" onClick={() => void navigate('/org')}>
            Abbrechen
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            Speichern
          </Button>
        </div>
      </div>
    </div>
  );
}
