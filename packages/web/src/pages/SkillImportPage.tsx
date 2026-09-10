import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { DownloadIcon, Loader2Icon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { SkillSourceEntry } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Import a skill from GitHub: the public shelf, or any owner/repo/path. */
export function SkillImportPage() {
  const navigate = useNavigate();
  const [shelf, setShelf] = useState<SkillSourceEntry[]>([]);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<string[]>([]);

  useEffect(() => {
    void api.skillCatalog().then(setShelf).catch(() => setShelf([]));
  }, []);

  const importFrom = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setBusy(trimmed);
    setCandidates([]);
    try {
      const result = await api.importSkill(trimmed);
      if ('skill' in result) {
        toast('Skill „' + result.skill.name + '“ importiert');
        navigate('/skills/' + result.skill.name + '/edit');
      } else {
        setCandidates(result.candidates);
        toast('Das ist eine Sammlung. Bitte einen Skill daraus wählen.');
      }
    } catch (caught) {
      toast.error('Import fehlgeschlagen', { description: (caught as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Skill importieren</h1>
          <p className="text-sm text-muted-foreground">
            Skills sind ein offenes Format: ein Ordner mit SKILL.md. Alles, was auf GitHub in diesem Format
            liegt, lässt sich hier holen, ob aus Anthropics Sammlung, von skills.sh oder aus einem eigenen Repo.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Aus GitHub</CardTitle>
            <CardDescription>
              owner/repo, owner/repo/pfad/zum/skill oder die GitHub-URL. Bei einer Sammlung erscheint die Auswahl.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="skill-source" className="text-[12px] text-muted-foreground">
                Quelle
              </Label>
              <div className="flex gap-2">
                <Input
                  id="skill-source"
                  value={source}
                  placeholder="anthropics/skills/skills/pdf"
                  onChange={(event) => setSource(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void importFrom(source);
                  }}
                />
                <Button onClick={() => void importFrom(source)} disabled={busy !== null || !source.trim()}>
                  {busy === source.trim() ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
                  Importieren
                </Button>
              </div>
            </div>
            {candidates.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Enthaltene Skills:</p>
                <ul className="divide-y rounded-lg border">
                  {candidates.map((candidate) => (
                    <li key={candidate} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate font-mono text-[12px]">{candidate}</span>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void importFrom(candidate)}>
                        {busy === candidate ? <Loader2Icon className="animate-spin" /> : null}
                        Importieren
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Anthropics Sammlung</CardTitle>
            <CardDescription>
              Öffentliche Skills von Anthropic. Skills mit Skripten brauchen Python oder Node und eine Shell,
              also Agenten mit Berechtigung „voll“; der Assistent selbst führt keine Skripte aus.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {shelf.length === 0 ? (
              <p className="text-sm text-muted-foreground">Wird geladen …</p>
            ) : (
              <ul className="divide-y">
                {shelf.map((entry) => (
                  <li key={entry.source} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{entry.name}</span>
                        {entry.needsShell && (
                          <Badge variant="outline" className="h-5 font-normal">
                            Skripte
                          </Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">{entry.description}</div>
                    </div>
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void importFrom(entry.source)}>
                      {busy === entry.source ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
                      Importieren
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
