import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { DeleteIcon as Trash2Icon, UsersIcon } from '@/components/icons';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { groupBy } from '@/lib/group-by';
import { formatNumber } from '@/lib/stats';
import type { Team } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';

import { TeamDrawer } from './org/TeamDrawer';
import { TEAM_COLUMN_LABELS, teamColumns } from './org/team-columns';

/**
 * The teams, and how full they are.
 *
 * A team is the lightest structure this app has: a name, a purpose, a lead.
 * The only number worth a column is how many people are in it, so the count is
 * a button that takes the reader to exactly those agents, filtered.
 *
 * Dissolving a team is a real DELETE (`deleteTeam`), and the agents in it are
 * not deleted with it - they keep their row and lose their `teamId`. The
 * confirmation names the number, because that is the part a reader cannot see
 * from the row.
 */
export function OrgTeamsPage() {
  const org = useOrgState();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  const membersByTeam = useMemo(() => groupBy(org.agents, (agent) => agent.teamId), [org.agents]);

  /** How many agents lose their team when these teams are disbanded. */
  const membersOf = useCallback(
    (teams: readonly Team[]): number =>
      teams.reduce((sum, team) => sum + (membersByTeam.get(team.id)?.length ?? 0), 0),
    [membersByTeam],
  );

  const disband = useCallback(
    async (team: Team): Promise<void> => {
      const ok = await confirm({
        title: 'Disband ' + team.name + '?',
        description: disbandDescription(membersOf([team])),
        confirmLabel: 'Disband',
        destructive: true,
      });
      if (!ok) return;

      try {
        await api.deleteTeam(team.id);
        await org.refresh();
        toast(team.name + ' disbanded');
      } catch (caught) {
        reportFailure('Disband', caught);
      }
    },
    [confirm, membersOf, org],
  );

  const columns = useMemo(
    () =>
      teamColumns({
        org,
        membersByTeam,
        onOpen: (team) => setDrawerId(team.id),
        onShowMembers: (team) => void navigate('/org/agents?team=' + team.id),
        onDisband: (team) => void disband(team),
      }),
    [disband, membersByTeam, navigate, org],
  );

  const drawerTeam = org.teams.find((team) => team.id === drawerId) ?? null;

  return (
    <>
      {dialog}
      {bulk.dialog}

      <Fade>
        <DataTable
          data={org.teams}
          columns={columns}
          getRowId={(team) => team.id}
          idPrefix="teams"
          onRowClick={(team) => setDrawerId(team.id)}
          rowClickIgnoreColumns={['select', 'name', 'members', 'actions']}
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search teams"
          searchText={(team) => team.name + ' ' + (team.purpose ?? '')}
          columnLabels={TEAM_COLUMN_LABELS}
          initialSorting={[{ id: 'name', desc: false }]}
          rowLabel={{ singular: 'Team', plural: 'Teams' }}
          loading={org.loading && org.teams.length === 0}
          error={org.error ? <ServerOffline onRetry={() => void org.refresh()} /> : undefined}
          bulkActions={(selected, clear) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const affected = membersOf(selected);
                void bulk.run({
                  rows: selected,
                  noun: { singular: 'Team', plural: 'Teams' },
                  nameOf: (team) => team.name,
                  verb: 'disband',
                  done: 'disbanded',
                  confirmLabel: 'Disband',
                  description:
                    affected === 0
                      ? 'None of these teams has members.'
                      : formatNumber(affected) +
                        (affected === 1 ? ' agent will be' : ' agents will be') +
                        ' without a team afterward.',
                  run: (team) => api.deleteTeam(team.id),
                  after: org.refresh,
                  clear,
                });
              }}
            >
              <Trash2Icon data-icon="inline-start" />
              Disband
            </Button>
          )}
          empty={
            <EmptyState
              icon={UsersIcon}
              title="No teams yet"
              description="A team groups agents under a lead. Reporting relationships are configured separately for each agent."
              actionLabel="Create team"
              actionTo="/org/teams/new"
              variant="plain"
            />
          }
          filteredEmpty={
            <NoResults query={search.trim() || undefined} onReset={() => setSearch('')} />
          }
        />
      </Fade>

      <TeamDrawer
        team={drawerTeam}
        members={drawerTeam ? (membersByTeam.get(drawerTeam.id) ?? []) : []}
        leadName={org.agentById(drawerTeam?.leadId)?.name ?? null}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
      />
    </>
  );
}

function disbandDescription(members: number): string {
  if (members === 0) return 'The team has no members and will be removed completely.';
  return (
    formatNumber(members) +
    (members === 1 ? ' agent remains' : ' agents remain') +
    ' but will no longer belong to a team. Assignments and memories will remain untouched.'
  );
}
