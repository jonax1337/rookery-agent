import { useCallback, useMemo, useState } from 'react';

import { toast } from 'sonner';

import { UserRoundCogIcon as UserMinusIcon } from '@/components/icons';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { Agent } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

import { EmptyUsersRoundIcon } from './teamIcons';

/** The agents that belong to a team and are still active. */
export function activeMembersOf(agents: readonly Agent[], teamId: string | undefined): Agent[] {
  return agents.filter((agent) => agent.teamId === teamId && !agent.archived);
}

/** An agent as a combobox choice: name first, title as the hint. */
export function agentOption(agent: Agent): EntityOption {
  return { value: agent.id, label: agent.name, hint: agent.title };
}

/** Moves one agent into or out of a team. Membership is a column on the agent. */
function useAgentTeamChange() {
  const org = useOrgState();
  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);

  const changeTeam = useCallback(
    async (agentId: string, teamId: string | null, confirmation: string): Promise<void> => {
      setMovingAgentId(agentId);
      try {
        await api.updateAgent(agentId, { teamId });
        await org.refresh();
        toast(confirmation);
      } catch (caught) {
        reportFailure('Update', caught);
      } finally {
        setMovingAgentId(null);
      }
    },
    [org],
  );

  return { movingAgentId, changeTeam };
}

interface TeamMembersFieldProps {
  teamId: string;
  teamName: string;
}

/** Lists a team's members and adds or removes them; each change is saved on its own, at once. */
export function TeamMembersField({ teamId, teamName }: TeamMembersFieldProps) {
  const { agents } = useOrgState();
  const { movingAgentId, changeTeam } = useAgentTeamChange();

  const members = useMemo(() => activeMembersOf(agents, teamId), [agents, teamId]);
  const candidates = useMemo(
    () => agents.filter((agent) => !agent.archived && agent.teamId !== teamId).map(agentOption),
    [agents, teamId],
  );

  const addMember = (agentId: string | null): void => {
    if (!agentId) return;
    const agent = agents.find((entry) => entry.id === agentId);
    void changeTeam(agentId, teamId, (agent?.name ?? 'Agent') + ' now belongs to ' + teamName);
  };

  return (
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
                  disabled={movingAgentId === agent.id}
                  onClick={() => void changeTeam(agent.id, null, agent.name + ' is now without a team')}
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
        onChange={addMember}
        placeholder="Add agent"
        emptyLabel="All agents are already here"
      />
      <FieldDescription>
        Membership changes are saved immediately, independently of the fields above.
      </FieldDescription>
    </Field>
  );
}
