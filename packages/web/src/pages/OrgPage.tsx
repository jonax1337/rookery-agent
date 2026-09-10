import { useEffect, useState } from 'react';
import { NavLink } from 'react-router';
import { ArrowRightIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { PROVIDER_LABEL } from '@/lib/format';
import type { Agent } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const NO_TEAM = '__none__';

/**
 * The company at a glance: who works here, in which team, on which projects.
 *
 * Everything that changes structure happens on its own page, so this one only
 * lists and links. The single exception is the company's own name and mission,
 * which are two fields and would be silly to send somewhere else for.
 */
export function OrgPage({ org }: { org: OrgState }) {
  const organization = org.snapshot?.organization ?? null;
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(organization?.name ?? '');
    setMission(organization?.mission ?? '');
  }, [organization?.id, organization?.name, organization?.mission]);

  if (org.loading && !organization) {
    return <Empty text="Firma wird geladen …" />;
  }
  if (!organization) {
    return <Empty text={org.error ?? 'Keine Firma gefunden.'} />;
  }

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      toast.error('Ein Name ist Pflicht');
      return;
    }
    setSaving(true);
    try {
      await api.updateOrganization(organization.id, {
        name: name.trim(),
        mission: mission.trim() || null,
      });
      await org.refresh();
      setEditing(false);
      toast('Firma gespeichert');
    } catch (error) {
      toast.error('Speichern fehlgeschlagen', { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const grouped: { key: string; label: string; purpose?: string; members: Agent[] }[] = [
    ...org.teams.map((team) => ({
      key: team.id,
      label: team.name,
      purpose: team.purpose,
      members: org.agents.filter((agent) => agent.teamId === team.id && !agent.archived),
    })),
    {
      key: NO_TEAM,
      label: 'Ohne Team',
      members: org.agents.filter((agent) => !agent.teamId && !agent.archived),
    },
  ].filter((group) => group.key !== NO_TEAM || group.members.length > 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
        {/* ------------------------------- header ------------------------------ */}
        {editing ? (
          <Card>
            <CardHeader>
              <CardTitle>Firma bearbeiten</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="org-name" className="text-[12px] text-muted-foreground">
                  Name
                </Label>
                <Input
                  id="org-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="org-mission" className="text-[12px] text-muted-foreground">
                  Mission
                </Label>
                <Textarea
                  id="org-mission"
                  rows={3}
                  placeholder="Wofür die Firma da ist, in ein bis zwei Sätzen."
                  value={mission}
                  onChange={(event) => setMission(event.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Abbrechen
                </Button>
                <Button onClick={() => void save()} disabled={saving}>
                  Speichern
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">{organization.name}</h1>
              <p className="text-sm text-muted-foreground">
                {organization.mission || 'Noch keine Mission hinterlegt.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={org.running.length > 0 ? 'default' : 'secondary'}>
                {org.running.length}{' '}
                {org.running.length === 1 ? 'laufender Auftrag' : 'laufende Aufträge'}
              </Badge>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <PencilIcon />
                Bearbeiten
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <NavLink to="/org/agents/new">
              <PlusIcon />
              Agent einstellen
            </NavLink>
          </Button>
          <Button asChild size="sm" variant="outline">
            <NavLink to="/org/teams/new">
              <PlusIcon />
              Team anlegen
            </NavLink>
          </Button>
          <Button asChild size="sm" variant="outline">
            <NavLink to="/org/projects/new">
              <PlusIcon />
              Projekt anlegen
            </NavLink>
          </Button>
          <Button asChild size="sm" variant="ghost" className="ml-auto">
            <NavLink to="/assignments">
              Aufträge ansehen
              <ArrowRightIcon />
            </NavLink>
          </Button>
        </div>

        {/* -------------------------------- teams ------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle>Teams</CardTitle>
            <CardDescription>
              {org.teams.length === 1 ? '1 Team' : org.teams.length + ' Teams'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {org.teams.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch keine Teams.</p>
            ) : (
              <ul className="divide-y">
                {org.teams.map((team) => {
                  const lead = org.agentById(team.leadId);
                  return (
                    <li
                      key={team.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{team.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {team.purpose || 'Kein Zweck hinterlegt.'}
                          {lead && ' · Leitung: ' + lead.name}
                        </div>
                      </div>
                      <Button asChild size="sm" variant="ghost">
                        <NavLink to={'/org/teams/' + team.id + '/edit'}>Bearbeiten</NavLink>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ------------------------------- agents ------------------------------ */}
        <Card>
          <CardHeader>
            <CardTitle>Agenten</CardTitle>
            <CardDescription>
              {org.agents.filter((agent) => !agent.archived).length === 1
                ? '1 Agent'
                : org.agents.filter((agent) => !agent.archived).length + ' Agenten'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {org.agents.filter((agent) => !agent.archived).length === 0 && (
              <p className="text-sm text-muted-foreground">
                Noch niemand eingestellt. Der Assistent arbeitet allein.
              </p>
            )}
            {grouped.map((group) => (
              <div key={group.key} className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-sm font-medium">{group.label}</h3>
                  <span className="text-xs text-muted-foreground">
                    {group.members.length === 1 ? '1 Agent' : group.members.length + ' Agenten'}
                  </span>
                </div>
                {group.members.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Noch niemand in diesem Team.</p>
                ) : (
                  <ul className="divide-y">
                    {group.members.map((agent) => (
                      <li key={agent.id}>
                        <NavLink
                          to={'/org/agents/' + agent.id}
                          className="-mx-2 flex flex-wrap items-center justify-between gap-3 rounded-md px-2 py-2.5 text-sm hover:bg-muted/60"
                        >
                          <span className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="font-medium">{agent.name}</span>
                            <span className="text-xs text-muted-foreground">{agent.title}</span>
                            <Badge
                              variant="outline"
                              className="h-4 px-1.5 font-mono text-[10px] font-normal"
                            >
                              {agent.slug}
                            </Badge>
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {agent.managerId
                              ? 'berichtet an ' + (org.agentById(agent.managerId)?.name ?? '—')
                              : 'berichtet an den Assistenten'}
                            {agent.provider && ' · ' + PROVIDER_LABEL[agent.provider]}
                          </span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ------------------------------ projects ----------------------------- */}
        <Card>
          <CardHeader>
            <CardTitle>Projekte</CardTitle>
            <CardDescription>
              Aufträge laufen im Projektverzeichnis, sonst im Arbeitsraum.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {org.projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch keine Projekte.</p>
            ) : (
              <ul className="divide-y">
                {org.projects.map((project) => (
                  <li
                    key={project.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        {project.name}
                        {project.archived && <Badge variant="secondary">archiviert</Badge>}
                      </div>
                      <div className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {project.path || 'kein Verzeichnis'}
                      </div>
                    </div>
                    <Button asChild size="sm" variant="ghost">
                      <NavLink to={'/org/projects/' + project.id + '/edit'}>Bearbeiten</NavLink>
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

function Empty({ text }: { text: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-6">
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
