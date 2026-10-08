import { useMemo } from 'react';

import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { ChoiceField } from '@/components/forms/form-kit';
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field';
import { PERMISSION_CHOICES } from '@/lib/format';
import { useOrgState } from '@/providers/rookery-provider';

import type { AgentFieldsProps } from './agentDraft';

interface AgentOrganizationFieldsProps extends AgentFieldsProps {
  /** The agent being edited; `undefined` while hiring. */
  agentId: string | undefined;
}

/** Where the agent sits in the company: team, manager and permission. */
export function AgentOrganizationFields({ draft, set, agentId }: AgentOrganizationFieldsProps) {
  const org = useOrgState();

  const teamOptions = useMemo<EntityOption[]>(
    () => org.teams.map((team) => ({ value: team.id, label: team.name })),
    [org.teams],
  );

  // An agent cannot report to itself, and an archived one cannot lead.
  const managerOptions = useMemo<EntityOption[]>(
    () =>
      org.agents
        .filter((entry) => entry.id !== agentId && !entry.archived)
        .map((entry) => ({ value: entry.id, label: entry.name, hint: entry.title })),
    [agentId, org.agents],
  );

  return (
    <FieldSet>
      <Field>
        <FieldLabel htmlFor="agent-team">Team</FieldLabel>
        <EntityCombobox
          id="agent-team"
          options={teamOptions}
          value={draft.teamId}
          onChange={(teamId) => set({ teamId })}
          placeholder="No team"
          emptyLabel="No team found"
        />
        <FieldDescription>
          Without a team, the agent works independently. You can also change the assignment
          from the team page.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-manager">Manager</FieldLabel>
        <EntityCombobox
          id="agent-manager"
          options={managerOptions}
          value={draft.managerId}
          onChange={(managerId) => set({ managerId })}
          placeholder="The assistant"
          emptyLabel="No agent found"
        />
        <FieldDescription>
          Without a manager, the agent reports to the assistant.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-permission-standard">Permission</FieldLabel>
        <ChoiceField
          id="agent-permission"
          options={PERMISSION_CHOICES}
          value={draft.permission}
          onChange={(permission) => set({ permission })}
        />
      </Field>
    </FieldSet>
  );
}
