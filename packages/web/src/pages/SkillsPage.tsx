import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { DownloadIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Skill, ToolServerAudience } from '@/lib/types';
import { relativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const AUDIENCE_LABEL: Record<ToolServerAudience, string> = {
  assistant: 'Assistent',
  agents: 'Agenten',
  both: 'Assistent und Agenten',
};

/** The skills folder: written procedures the assistant and agents open on demand. */
export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setSkills(await api.skills());
    } catch (caught) {
      toast.error('Skills konnten nicht geladen werden', { description: (caught as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Skills</h1>
            <p className="text-sm text-muted-foreground">
              Geschriebene Anleitungen für bestimmte Arten von Aufgaben. Der Assistent und die Agenten
              sehen die Liste in jedem Turn und öffnen den passenden Skill, bevor sie loslegen.
              Liegt als Ordner mit SKILL.md unter dem Rookery-Verzeichnis.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" asChild>
              <NavLink to="/skills/import">
                <DownloadIcon />
                Importieren
              </NavLink>
            </Button>
            <Button asChild>
              <NavLink to="/skills/new">
                <PlusIcon />
                Skill anlegen
              </NavLink>
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Wird geladen …</p>
        ) : skills.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Noch keine Skills. Leg einen an, etwa „Wochenbericht schreiben“ mit den Schritten, die immer gleich sind.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent>
              <ul className="divide-y">
                {skills.map((skill) => (
                  <li key={skill.name} className="flex flex-wrap items-center gap-3 py-3">
                    <NavLink to={'/skills/' + skill.name + '/edit'} className="font-medium hover:underline">
                      {skill.name}
                    </NavLink>
                    <Badge variant="outline" className="h-5 font-normal">
                      {AUDIENCE_LABEL[skill.audience]}
                    </Badge>
                    <span className="min-w-0 flex-1 text-sm text-muted-foreground">{skill.description}</span>
                    <span className="text-xs text-muted-foreground">{relativeTime(skill.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
