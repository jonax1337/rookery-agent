import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { PERMISSION_LABEL, PROVIDER_LABEL } from '@/lib/format';
import type { PermissionLevel, ProviderId } from '@/lib/types';
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

/** Radix Select has no empty value, so "nothing chosen" needs a sentinel. */
const NONE = '__none__';
const DEFAULT = '__default__';

interface Draft {
  name: string;
  title: string;
  slug: string;
  instructions: string;
  teamId: string;
  managerId: string;
  provider: string;
  model: string;
  permission: string;
}

const EMPTY: Draft = {
  name: '',
  title: '',
  slug: '',
  instructions: '',
  teamId: NONE,
  managerId: NONE,
  provider: DEFAULT,
  model: '',
  permission: DEFAULT,
};

/**
 * Hiring and re-briefing, as a page.
 *
 * The same form serves both, because the fields are identical: an edit only
 * differs in what it starts from and where it sends the result.
 */
export function AgentFormPage({ org }: { org: OrgState }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const editing = Boolean(id);
  const existing = org.agents.find((agent) => agent.id === id);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!existing) return;
    setDraft({
      name: existing.name,
      title: existing.title,
      slug: existing.slug,
      instructions: existing.instructions,
      teamId: existing.teamId ?? NONE,
      managerId: existing.managerId ?? NONE,
      provider: existing.provider ?? DEFAULT,
      model: existing.model ?? '',
      permission: existing.permission ?? DEFAULT,
    });
  }, [existing]);

  const set = (patch: Partial<Draft>): void => setDraft((current) => ({ ...current, ...patch }));

  const managers = org.agents.filter((agent) => agent.id !== id && !agent.archived);

  const save = async (): Promise<void> => {
    if (!draft.name.trim() || !draft.title.trim() || !draft.instructions.trim()) {
      toast.error('Name, Titel und Anweisungen sind Pflicht');
      return;
    }

    setSaving(true);
    try {
      if (editing && id) {
        await api.updateAgent(id, {
          name: draft.name.trim(),
          title: draft.title.trim(),
          instructions: draft.instructions.trim(),
          ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
          teamId: draft.teamId === NONE ? null : draft.teamId,
          managerId: draft.managerId === NONE ? null : draft.managerId,
          provider: draft.provider === DEFAULT ? null : (draft.provider as ProviderId),
          model: draft.model.trim() || null,
          permission:
            draft.permission === DEFAULT ? null : (draft.permission as PermissionLevel),
        });
        await org.refresh();
        toast('Agent gespeichert');
        void navigate('/org/agents/' + id);
        return;
      }

      const created = await api.createAgent({
        name: draft.name.trim(),
        title: draft.title.trim(),
        instructions: draft.instructions.trim(),
        ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
        ...(draft.teamId !== NONE ? { teamId: draft.teamId } : {}),
        ...(draft.managerId !== NONE ? { managerId: draft.managerId } : {}),
        ...(draft.provider !== DEFAULT ? { provider: draft.provider as ProviderId } : {}),
        ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
        ...(draft.permission !== DEFAULT
          ? { permission: draft.permission as PermissionLevel }
          : {}),
      });
      await org.refresh();
      toast(created.name + ' eingestellt');
      void navigate('/org/agents/' + created.id);
    } catch (error) {
      toast.error('Speichern fehlgeschlagen', { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  if (editing && !existing && !org.loading) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl p-6">
          <p className="text-sm text-muted-foreground">Dieser Agent existiert nicht mehr.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {editing ? 'Agent bearbeiten' : 'Agent einstellen'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Ein Agent ist fest angestellt: Rolle, Anweisungen und eigenes Gedächtnis bleiben
            bestehen. Jeder Auftrag startet trotzdem einen frischen Prozess.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Person</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field htmlFor="agent-name" label="Name">
              <Input
                id="agent-name"
                value={draft.name}
                onChange={(event) => set({ name: event.target.value })}
              />
            </Field>
            <Field htmlFor="agent-title" label="Titel">
              <Input
                id="agent-title"
                placeholder="z. B. Backend-Entwicklerin"
                value={draft.title}
                onChange={(event) => set({ title: event.target.value })}
              />
            </Field>
            <Field
              htmlFor="agent-slug"
              label="Kürzel"
              hint="Optional. Wird sonst aus dem Namen gebildet."
            >
              <Input
                id="agent-slug"
                placeholder="backend-dev"
                value={draft.slug}
                onChange={(event) => set({ slug: event.target.value })}
              />
            </Field>
            <Field
              htmlFor="agent-instructions"
              label="Anweisungen"
              hint="Die feste Rollenbeschreibung. Nie die Stimme des Assistenten."
            >
              <Textarea
                id="agent-instructions"
                rows={8}
                value={draft.instructions}
                onChange={(event) => set({ instructions: event.target.value })}
              />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Einordnung</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field htmlFor="agent-team" label="Team">
              <Select value={draft.teamId} onValueChange={(value) => set({ teamId: value })}>
                <SelectTrigger id="agent-team" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Ohne Team</SelectItem>
                  {org.teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field
              htmlFor="agent-manager"
              label="Vorgesetzter"
              hint="Ohne Vorgesetzten berichtet der Agent an den Assistenten."
            >
              <Select value={draft.managerId} onValueChange={(value) => set({ managerId: value })}>
                <SelectTrigger id="agent-manager" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Assistent</SelectItem>
                  {managers.map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name} · {agent.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Werkzeuge</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field htmlFor="agent-provider" label="Anbieter">
              <Select value={draft.provider} onValueChange={(value) => set({ provider: value })}>
                <SelectTrigger id="agent-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Standard</SelectItem>
                  <SelectItem value="claude">{PROVIDER_LABEL.claude}</SelectItem>
                  <SelectItem value="codex">{PROVIDER_LABEL.codex}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field htmlFor="agent-model" label="Modell" hint="Optional. Leer heißt Standardmodell.">
              <Input
                id="agent-model"
                placeholder="optional"
                value={draft.model}
                onChange={(event) => set({ model: event.target.value })}
              />
            </Field>
            <Field htmlFor="agent-permission" label="Berechtigung">
              <Select
                value={draft.permission}
                onValueChange={(value) => set({ permission: value })}
              >
                <SelectTrigger id="agent-permission" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT}>Standard</SelectItem>
                  {(Object.keys(PERMISSION_LABEL) as PermissionLevel[]).map((level) => (
                    <SelectItem key={level} value={level}>
                      {PERMISSION_LABEL[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => void navigate(-1)}>
            Abbrechen
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {editing ? 'Speichern' : 'Einstellen'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  htmlFor,
  label,
  hint,
  children,
}: {
  htmlFor?: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[10.5px] text-muted-foreground/80">{hint}</p>}
    </div>
  );
}
