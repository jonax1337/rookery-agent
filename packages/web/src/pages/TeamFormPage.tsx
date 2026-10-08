import { useCallback, useEffect, useId, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';

import { toast } from 'sonner';
import { z } from 'zod';

import { api, type TeamInput, type TeamPatch } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Team } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox } from '@/components/forms/entity-combobox';
import {
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
} from '@/components/forms/form-kit';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { EmptyUsersRoundIcon, MenuTrash2Icon } from './teams/teamIcons';
import { TeamMembersField, activeMembersOf, agentOption } from './teams/TeamMembersField';

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

const TEAMS_PATH = '/org/teams';

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

function disbandDescription(teamName: string, memberCount: number): string {
  if (memberCount === 0) return 'The team “' + teamName + '” is empty and will disappear completely.';
  const agents = memberCount === 1 ? ' agent will lose' : ' agents will lose';
  return memberCount + agents + ' their association with “' + teamName + '”. The agents themselves will remain.';
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

  useEffect(() => {
    if (!team) return;
    hydrate(team.id, () => draftOf(team));
  }, [hydrate, team]);

  const leadOptions = useMemo(
    () => org.agents.filter((agent) => !agent.archived).map(agentOption),
    [org.agents],
  );

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    if (editing && id) await api.updateTeam(id, patch);
    else await api.createTeam(toInput(patch));
    markSaved();
    await org.refresh();
    toast(editing ? 'Team saved' : 'Team created');
    void navigate(TEAMS_PATH);
  });

  const dissolve = useCallback(async (): Promise<void> => {
    if (!id || !team) return;
    const memberCount = activeMembersOf(org.agents, id).length;
    const ok = await confirm({
      title: 'Disband team?',
      description: disbandDescription(team.name, memberCount),
      confirmLabel: 'Disband',
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteTeam(id);
      await org.refresh();
      toast('Team disbanded', { description: team.name });
      void navigate(TEAMS_PATH);
    } catch (caught) {
      reportFailure('Disband', caught);
    }
  }, [confirm, id, navigate, org, team]);

  const leaf = editing ? (team?.name ?? 'Edit team') : 'Create team';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Organization', to: TEAMS_PATH },
        { label: 'Teams', to: TEAMS_PATH },
        { label: leaf },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo={TEAMS_PATH}
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

  if (editing && !team && !org.loading) {
    return (
      <PageBody width="2xl">
        <Fade>
          <EmptyState
            icon={EmptyUsersRoundIcon}
            title="This team no longer exists"
            description="It was disbanded or never existed."
            actionLabel="View teams"
            actionTo={TEAMS_PATH}
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

        {team ? (
          <>
            <FieldSeparator />
            <Fade delay={100}>
              <FieldSet>
                <TeamMembersField teamId={team.id} teamName={team.name} />
              </FieldSet>
            </Fade>
          </>
        ) : null}
      </FormPage>
    </PageBody>
  );
}
