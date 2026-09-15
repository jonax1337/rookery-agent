import { forwardRef, useCallback, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  PencilIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { PERMISSION_LABEL } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Agent, Team } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { Trash2Icon as AnimatedTrash2Icon } from '@/components/animate-ui/icons/trash-2';
import { UserRoundIcon as AnimatedUserRoundIcon } from '@/components/animate-ui/icons/user-round';
import { UsersIcon as AnimatedUsersIcon } from '@/components/animate-ui/icons/users';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { RelatedItem } from '@/components/common/related-item';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemGroup } from '@/components/ui/item';

/**
 * The teams, and how full they are.
 *
 * A team is the lightest structure this app has: a name, a purpose, a lead.
 * The only number worth a column is how many people are in it, and that is
 * also the one thing the old list could not tell - so the count is a button
 * that takes the reader to exactly those agents, filtered.
 *
 * Dissolving a team is a real DELETE (`deleteTeam`), and the agents in it are
 * not deleted with it - they keep their row and lose their `teamId`. The
 * confirmation names the number, because that is the part a reader cannot see
 * from the row.
 */

const column = createRookeryColumnHelper<Team>();

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  purpose: 'Purpose',
  lead: 'Lead',
  members: 'Members',
  actions: 'Actions',
};

/**
 * The empty-state icons as animate-ui versions. `EmptyState` takes a
 * `LucideIcon` and renders it without props, so each animated icon sits in a
 * forwardRef shell that carries its `animateOnView` trigger along.
 */
const EmptyUsersIcon = forwardRef<SVGSVGElement>(function EmptyUsersIcon() {
  return <AnimatedUsersIcon animateOnView />;
});

const EmptyUserRoundIcon = forwardRef<SVGSVGElement>(function EmptyUserRoundIcon() {
  return <AnimatedUserRoundIcon animateOnView />;
});

export function OrgTeamsPage() {
  const org = useOrgState();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  /** Members per team, counted once instead of per rendered cell. */
  const membersByTeam = useMemo(() => {
    const map = new Map<string, Agent[]>();
    for (const agent of org.agents) {
      if (!agent.teamId) continue;
      const list = map.get(agent.teamId);
      if (list) list.push(agent);
      else map.set(agent.teamId, [agent]);
    }
    return map;
  }, [org.agents]);

  const showMembers = useCallback(
    (team: Team) => void navigate('/org/agents?team=' + team.id),
    [navigate],
  );

  /* -------------------------------- actions ------------------------------- */

  const dissolve = useCallback(
    async (team: Team): Promise<void> => {
      const members = membersByTeam.get(team.id)?.length ?? 0;
      const ok = await confirm({
        title: team.name + ' disband?',
        description:
          members === 0
            ? 'The team has no members and will be removed completely.'
            : formatNumber(members) +
              (members === 1 ? ' agent remains' : ' agents remain') +
              ' but will no longer belong to a team. Assignments and memories ' +
              'will remain untouched.',
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
    [confirm, membersByTeam, org],
  );

  /**
   * How many agents lose their team, for the bulk question. The single-row
   * question counts the same thing; only here it is a sum.
   */
  const affectedBy = useCallback(
    (teams: readonly Team[]): number =>
      teams.reduce((sum, team) => sum + (membersByTeam.get(team.id)?.length ?? 0), 0),
    [membersByTeam],
  );

  /* -------------------------------- columns ------------------------------- */

  const columns = useMemo(
    () =>
      column.columns([
        selectionColumn<Team>({ rowLabel: (team) => team.name + ' selected' }),

        column.accessor('name', {
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
          cell: ({ row }) => (
            <DetailDrawerTrigger
              className="font-medium"
              onClick={() => setDrawerId(row.original.id)}
            >
              {row.original.name}
            </DetailDrawerTrigger>
          ),
          enableHiding: false,
        }),

        column.accessor((team) => team.purpose ?? '', {
          id: 'purpose',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Purpose" />,
          cell: ({ row }) =>
            row.original.purpose ? (
              <span className="line-clamp-1 max-w-[28rem] text-muted-foreground">
                {row.original.purpose}
              </span>
            ) : (
              emptyCell()
            ),
        }),

        column.accessor(
          (team) => org.agents.find((agent) => agent.id === team.leadId)?.name ?? '',
          {
            id: 'lead',
            header: ({ column: head }) => <DataTableColumnHeader column={head} title="Lead" />,
            cell: ({ row }) => {
              const lead = org.agentById(row.original.leadId);
              if (!lead) return <span className="text-muted-foreground">No lead</span>;
              return (
                <NavLink to={'/org/agents/' + lead.id} className="hover:underline">
                  {lead.name}
                </NavLink>
              );
            },
          },
        ),

        column.accessor((team) => membersByTeam.get(team.id)?.length ?? 0, {
          id: 'members',
          header: ({ column: head }) => (
            <DataTableColumnHeader column={head} title="Members" align="end" />
          ),
          cell: ({ row }) => {
            const count = membersByTeam.get(row.original.id)?.length ?? 0;
            if (count === 0) {
              return (
                <span className="block text-right tabular-nums text-muted-foreground">0</span>
              );
            }
            return (
              <div className="text-right">
                <Button
                  variant="link"
                  className="h-auto p-0 tabular-nums"
                  onClick={() => showMembers(row.original)}
                >
                  {formatNumber(count)}
                </Button>
              </div>
            );
          },
        }),

        actionsColumn<Team>((team) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + team.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setDrawerId(team.id)}>
                <SquareArrowOutUpRightIcon />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to={'/org/teams/' + team.id + '/edit'}>
                  <PencilIcon />
                  Edit
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => showMembers(team)}>
                <UsersIcon />
                View members
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void dissolve(team)}>
                <Trash2Icon />
                Disband
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [dissolve, membersByTeam, org, showMembers],
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
          columnLabels={COLUMN_LABELS}
          initialSorting={[{ id: 'name', desc: false }]}
          rowLabel={{ singular: 'Team', plural: 'Teams' }}
          loading={org.loading && org.teams.length === 0}
          error={org.error ? <ServerOffline onRetry={() => void org.refresh()} /> : undefined}
          bulkActions={(selected, clear) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const affected = affectedBy(selected);
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
              <AnimatedTrash2Icon data-icon="inline-start" animateOnView />
              Disband
            </Button>
          )}
          empty={
            <EmptyState
              icon={EmptyUsersIcon}
              title="No teams yet"
              description="A team groups agents under a lead. Reporting relationships are configured separately for each agent."
              actionLabel="Create team"
              actionTo="/org/teams/new"
              variant="plain"
            />
          }
          filteredEmpty={
            <NoResults
              {...(search.trim() ? { query: search.trim() } : {})}
              onReset={() => setSearch('')}
            />
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

/* --------------------------------- drawer --------------------------------- */

interface TeamDrawerProps {
  team: Team | null;
  members: readonly Agent[];
  leadName: string | null;
  onOpenChange(open: boolean): void;
}

function TeamDrawer({ team, members, leadName, onOpenChange }: TeamDrawerProps) {
  return (
    <DetailDrawer
      open={team !== null}
      onOpenChange={onOpenChange}
      title={team?.name ?? 'Team'}
      description={team?.purpose || 'No purpose provided.'}
      footer={
        team ? (
          <Button asChild>
            <NavLink to={'/org/teams/' + team.id + '/edit'}>Edit</NavLink>
          </Button>
        ) : null
      }
    >
      {team ? (
        <>
          <Fade>
            <MetaList
              columns={1}
              items={[
                {
                  label: 'Lead',
                  value: leadName ?? 'No lead',
                  icon: UserRoundIcon,
                  ...(team.leadId ? { to: '/org/agents/' + team.leadId } : {}),
                },
                {
                  label: 'Members',
                  value: <CountingNumber number={members.length} />,
                  icon: UsersIcon,
                  to: '/org/agents?team=' + team.id,
                },
                { label: 'Created', value: formatDateTime(team.createdAt) },
                { label: 'Last updated', value: formatDateTime(team.updatedAt) },
              ]}
            />
          </Fade>

          <Fade delay={50}>
            <div>
              <h3 className="mb-2 text-sm font-medium">Who works here</h3>
              {members.length === 0 ? (
                <EmptyState
                  icon={EmptyUserRoundIcon}
                  title="No members in this team yet"
                  description="Assign the team in an agent’s profile to add that agent."
                  actionLabel="Hire agent"
                  actionTo="/org/agents/new"
                  variant="plain"
                  size="sm"
                />
              ) : (
                <ItemGroup className="gap-2">
                  {members.map((agent) => (
                    <RelatedItem
                      key={agent.id}
                      to={'/org/agents/' + agent.id}
                      title={agent.name}
                      description={agent.title + (agent.id === team.leadId ? ' · Lead' : '')}
                      trailing={
                        <span className="text-xs text-muted-foreground">
                          {agent.permission ? PERMISSION_LABEL[agent.permission] : 'Default'}
                        </span>
                      }
                    />
                  ))}
                </ItemGroup>
              )}
            </div>
          </Fade>
        </>
      ) : null}
    </DetailDrawer>
  );
}
