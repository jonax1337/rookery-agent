import { forwardRef, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { UserMinusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api, type TeamInput, type TeamPatch } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Team } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { Trash2Icon as AnimatedTrash2Icon } from '@/components/animate-ui/icons/trash-2';
import { UsersRoundIcon as AnimatedUsersRoundIcon } from '@/components/animate-ui/icons/users-round';
import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
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
 * therefore not gated behind "Save".
 */

interface TeamDraft {
  name: string;
  purpose: string;
  leadId: string | null;
}

const EMPTY: TeamDraft = { name: '', purpose: '', leadId: null };

const schema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
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

/**
 * The empty-state and menu icons as animate-ui twins: same paths and stroke
 * as the lucide originals, wiggling once when they enter the viewport (the
 * menu item, whenever the menu opens). `EmptyState` and the form header
 * menu take a `LucideIcon` and render it without props, so each animated
 * icon sits in a forwardRef shell that carries its trigger along.
 */
const EmptyUsersRoundIcon = forwardRef<SVGSVGElement>(function EmptyUsersRoundIcon() {
  return <AnimatedUsersRoundIcon animateOnView />;
});

const MenuTrash2Icon = forwardRef<SVGSVGElement>(function MenuTrash2Icon() {
  return <AnimatedTrash2Icon animateOnView />;
});

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

  /* ------------------------------ Members ------------------------------ */

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
        reportFailure('Update', caught);
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
    toast(editing ? 'Team saved' : 'Team created');
    void navigate('/org/teams');
  });

  const dissolve = useCallback(async (): Promise<void> => {
    if (!id || !team) return;
    const ok = await confirm({
      title: 'Disband team?',
      description:
        members.length === 0
          ? 'The team “' + team.name + '” is empty and will disappear completely.'
          : members.length +
            (members.length === 1 ? ' agent will lose' : ' agents will lose') +
            ' their association with “' +
            team.name +
            '”. The agents themselves will remain.',
      confirmLabel: 'Disband',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteTeam(id);
      await org.refresh();
      toast('Team disbanded', { description: team.name });
      void navigate('/org/teams');
    } catch (caught) {
      reportFailure('Disband', caught);
    }
  }, [confirm, id, members.length, navigate, org, team]);

  /* --------------------------------- Kopf --------------------------------- */

  const leaf = editing ? (team?.name ?? 'Edit team') : 'Create team';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Organization', to: '/org/teams' },
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
                    label: 'Team disband',
                    icon: MenuTrash2Icon,
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
        <Fade>
          <EmptyState
            icon={EmptyUsersRoundIcon}
            title="This team no longer exists"
            description="It was disbanded or never existed."
            actionLabel="View teams"
            actionTo="/org/teams"
          />
        </Fade>
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
        description={<Blur>Teams group agents around a shared purpose.</Blur>}
      >
        <Fade delay={50}>
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
              <FieldLabel htmlFor="team-purpose">Purpose</FieldLabel>
              <Textarea
                id="team-purpose"
                rows={3}
                placeholder="What this team is responsible for."
                value={draft.purpose}
                onChange={(event) => set({ purpose: event.target.value })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="team-lead">Lead</FieldLabel>
              <EntityCombobox
                id="team-lead"
                options={leadOptions}
                value={draft.leadId}
                onChange={(leadId) => set({ leadId })}
                placeholder="Unassigned"
                emptyLabel="No agent found"
              />
              <FieldDescription>
                The lead need not belong to the team; this identifies its point of contact.
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>

        {editing && id ? (
          <>
            <FieldSeparator />
            <Fade delay={100}>
              <FieldSet>
                <Field>
                  <FieldLabel htmlFor="team-add-member">Members</FieldLabel>
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
                                void setTeamOf(agent.id, null, agent.name + ' is now without a team')
                              }
                            >
                              <UserMinusIcon data-icon="inline-start" />
                              Remove
                            </Button>
                          </ItemActions>
                        </Item>
                      ))}
                    </ItemGroup>
                  ) : (
                    <Fade>
                      <EmptyState
                        icon={EmptyUsersRoundIcon}
                        title="No team members yet"
                        description="Use the selection below to add the first agent."
                        variant="plain"
                        size="sm"
                      />
                    </Fade>
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
                        (agent?.name ?? 'Agent') + ' now belongs to ' + draft.name,
                      );
                    }}
                    placeholder="Add agent"
                    emptyLabel="All agents are already here"
                  />
                  <FieldDescription>
                    Membership changes are saved immediately, independently of the fields above.
                  </FieldDescription>
                </Field>
              </FieldSet>
            </Fade>
          </>
        ) : null}
      </FormPage>
    </PageBody>
  );
}
