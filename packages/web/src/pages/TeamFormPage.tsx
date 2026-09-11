import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Trash2Icon, UserMinusIcon, UsersRoundIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, type TeamInput, type TeamPatch } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Team } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import {
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
} from '@/components/forms/form-kit';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Textarea } from '@/components/ui/textarea';

/**
 * A team: who is in it, what it is for, and who leads it.
 *
 * The members block is the new part. Until now the only way to put an agent
 * into a team was to open that agent and pick the team there, which is the
 * wrong direction for the one question a team page raises - "who is in this
 * team?". Membership is a column on the agent, so each change is its own
 * `updateAgent` call and lands immediately; it is not part of the draft and
 * therefore not gated behind "Speichern".
 */

interface TeamDraft {
  name: string;
  purpose: string;
  leadId: string | null;
}

const EMPTY: TeamDraft = { name: '', purpose: '', leadId: null };

const schema = z.object({
  name: z.string().trim().min(1, 'Ein Name ist Pflicht.'),
});

function draftOf(team: Team): TeamDraft {
  return { name: team.name, purpose: team.purpose ?? '', leadId: team.leadId ?? null };
}

function buildPatch(draft: TeamDraft): TeamPatch {
  return {
    name: draft.name.trim(),
    purpose: draft.purpose.trim() || null,
    leadId: draft.leadId,
  };
}

function toInput(patch: TeamPatch): TeamInput {
  return {
    name: patch.name ?? '',
    ...(patch.purpose ? { purpose: patch.purpose } : {}),
    ...(patch.leadId ? { leadId: patch.leadId } : {}),
  };
}

export function TeamFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const org = useOrgState();
  const { confirm, dialog } = useConfirm();

  const editing = Boolean(id);
  const team = org.teams.find((entry) => entry.id === id);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<TeamDraft>(EMPTY);
  const [moving, setMoving] = useState<string | null>(null);

  useEffect(() => {
    if (!team) return;
    hydrate(team.id, () => draftOf(team));
  }, [hydrate, team]);

  /* ------------------------------ Mitglieder ------------------------------ */

  const members = useMemo(
    () => org.agents.filter((agent) => agent.teamId === id && !agent.archived),
    [id, org.agents],
  );

  const candidates = useMemo<EntityOption[]>(
    () =>
      org.agents
        .filter((agent) => !agent.archived && agent.teamId !== id)
        .map((agent) => ({ value: agent.id, label: agent.name, hint: agent.title })),
    [id, org.agents],
  );

  const leadOptions = useMemo<EntityOption[]>(
    () =>
      org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name, hint: agent.title })),
    [org.agents],
  );

  const setTeamOf = useCallback(
    async (agentId: string, teamId: string | null, done: string): Promise<void> => {
      setMoving(agentId);
      try {
        await api.updateAgent(agentId, { teamId });
        await org.refresh();
        toast(done);
      } catch (caught) {
        reportFailure('Änderung', caught);
      } finally {
        setMoving(null);
      }
    },
    [org],
  );

  /* -------------------------------- Sichern ------------------------------- */

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    if (editing && id) await api.updateTeam(id, patch);
    else await api.createTeam(toInput(patch));
    markSaved();
    await org.refresh();
    toast(editing ? 'Team gespeichert' : 'Team angelegt');
    void navigate('/org/teams');
  });

  const dissolve = useCallback(async (): Promise<void> => {
    if (!id || !team) return;
    const ok = await confirm({
      title: 'Team auflösen?',
      description:
        members.length === 0
          ? 'Das Team „' + team.name + '“ ist leer und verschwindet vollständig.'
          : members.length +
            (members.length === 1 ? ' Agent verliert' : ' Agenten verlieren') +
            ' die Zuordnung zu „' +
            team.name +
            '“. Die Agenten selbst bleiben bestehen.',
      confirmLabel: 'Auflösen',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteTeam(id);
      await org.refresh();
      toast('Team aufgelöst', { description: team.name });
      void navigate('/org/teams');
    } catch (caught) {
      reportFailure('Auflösen', caught);
    }
  }, [confirm, id, members.length, navigate, org, team]);

  /* --------------------------------- Kopf --------------------------------- */

  const leaf = editing ? (team?.name ?? 'Team bearbeiten') : 'Team anlegen';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Firma', to: '/org/teams' },
        { label: 'Teams', to: '/org/teams' },
        { label: leaf },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo="/org/teams"
          submitting={saving}
          submitDisabled={!dirty || saving}
          menu={
            editing
              ? [
                  {
                    label: 'Team auflösen',
                    icon: Trash2Icon,
                    destructive: true,
                    onSelect: () => void dissolve(),
                  },
                ]
              : []
          }
        />
      ),
    },
    [dirty, dissolve, editing, formId, saving],
  );

  /* ------------------------------- Zustände ------------------------------- */

  if (editing && !team && !org.loading) {
    return (
      <PageBody width="2xl">
        <EmptyState
          icon={UsersRoundIcon}
          title="Dieses Team gibt es nicht mehr"
          description="Es wurde aufgelöst oder hat nie existiert."
          actionLabel="Zu den Teams"
          actionTo="/org/teams"
        />
      </PageBody>
    );
  }

  if (editing && !team) {
    return (
      <PageBody width="2xl">
        <FormFieldsSkeleton fields={3} />
      </PageBody>
    );
  }

  return (
    <PageBody width="2xl">
      {dialog}
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        description="Teams gruppieren Agenten und geben ihnen einen gemeinsamen Zweck."
      >
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="team-name">Name</FieldLabel>
            <Input
              id="team-name"
              value={draft.name}
              aria-invalid={Boolean(errors.name)}
              onChange={(event) => set({ name: event.target.value })}
            />
            <FieldError>{errors.name}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="team-purpose">Zweck</FieldLabel>
            <Textarea
              id="team-purpose"
              rows={3}
              placeholder="Wofür dieses Team zuständig ist."
              value={draft.purpose}
              onChange={(event) => set({ purpose: event.target.value })}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="team-lead">Leitung</FieldLabel>
            <EntityCombobox
              id="team-lead"
              options={leadOptions}
              value={draft.leadId}
              onChange={(leadId) => set({ leadId })}
              placeholder="Noch offen"
              emptyLabel="Kein Agent gefunden"
            />
            <FieldDescription>
              Die Leitung muss nicht im Team sein — sie ist die Ansprechpartnerin, nicht die
              Mitgliedschaft.
            </FieldDescription>
          </Field>
        </FieldSet>

        {editing && id ? (
          <>
            <FieldSeparator />
            <FieldSet>
              <Field>
                <FieldLabel htmlFor="team-add-member">Mitglieder</FieldLabel>
                {members.length ? (
                  <ItemGroup className="gap-2">
                    {members.map((agent) => (
                      <Item key={agent.id} variant="outline" size="sm">
                        <ItemContent>
                          <ItemTitle className="font-normal">{agent.name}</ItemTitle>
                          <ItemDescription className="text-xs">{agent.title}</ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={moving === agent.id}
                            onClick={() =>
                              void setTeamOf(agent.id, null, agent.name + ' ist jetzt ohne Team')
                            }
                          >
                            <UserMinusIcon data-icon="inline-start" />
                            Entfernen
                          </Button>
                        </ItemActions>
                      </Item>
                    ))}
                  </ItemGroup>
                ) : (
                  <EmptyState
                    icon={UsersRoundIcon}
                    title="Noch niemand im Team"
                    description="Über die Auswahl darunter kommt der erste Agent dazu."
                    variant="plain"
                    size="sm"
                  />
                )}
                <EntityCombobox
                  id="team-add-member"
                  options={candidates}
                  value={null}
                  clearable={false}
                  onChange={(agentId) => {
                    if (!agentId) return;
                    const agent = org.agents.find((entry) => entry.id === agentId);
                    void setTeamOf(
                      agentId,
                      id,
                      (agent?.name ?? 'Agent') + ' gehört jetzt zu ' + draft.name,
                    );
                  }}
                  placeholder="Agent hinzufügen"
                  emptyLabel="Alle Agenten sind schon hier"
                />
                <FieldDescription>
                  Mitgliedschaften werden sofort gespeichert, unabhängig von den Feldern oben.
                </FieldDescription>
              </Field>
            </FieldSet>
          </>
        ) : null}
      </FormPage>
    </PageBody>
  );
}
