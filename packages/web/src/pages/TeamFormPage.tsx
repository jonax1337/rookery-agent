import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { OrgState } from '@/hooks/useOrg';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

const NONE = '__none__';

/** Create or rename a team, and say who leads it. */
export function TeamFormPage({ org }: { org: OrgState }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const existing = org.teams.find((team) => team.id === id);

  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [leadId, setLeadId] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setName(existing.name);
    setPurpose(existing.purpose ?? '');
    setLeadId(existing.leadId ?? NONE);
  }, [existing]);

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      toast.error('Ein Name ist Pflicht');
      return;
    }
    setSaving(true);
    try {
      if (editing && id) {
        await api.updateTeam(id, {
          name: name.trim(),
          purpose: purpose.trim() || null,
          leadId: leadId === NONE ? null : leadId,
        });
        toast('Team gespeichert');
      } else {
        await api.createTeam({
          name: name.trim(),
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          ...(leadId !== NONE ? { leadId } : {}),
        });
        toast('Team angelegt');
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
      await api.deleteTeam(id);
      await org.refresh();
      toast('Team aufgelöst');
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
            {editing ? 'Team bearbeiten' : 'Team anlegen'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Teams gruppieren Agenten und geben ihnen einen gemeinsamen Zweck.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Team</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="team-name" className="text-[12px] text-muted-foreground">
                Name
              </Label>
              <Input
                id="team-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-purpose" className="text-[12px] text-muted-foreground">
                Zweck
              </Label>
              <Textarea
                id="team-purpose"
                rows={3}
                placeholder="Wofür dieses Team zuständig ist."
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="team-lead" className="text-[12px] text-muted-foreground">
                Teamleitung
              </Label>
              <Select value={leadId} onValueChange={setLeadId}>
                <SelectTrigger id="team-lead" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Keine Leitung</SelectItem>
                  {org.agents
                    .filter((agent) => !agent.archived)
                    .map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name} · {agent.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          {editing && (
            <Button variant="ghost" className="mr-auto text-destructive" onClick={() => void remove()}>
              Team auflösen
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
