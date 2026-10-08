import { useMemo } from 'react';
import { NavLink } from 'react-router';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { EmptyState } from '@/components/common/empty-state';
import { ProviderCell } from '@/components/common/provider-cell';
import { UsersIcon } from '@/components/icons';
import { PERMISSION_LABEL } from '@/lib/format';
import type { Agent, Team } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

function buildReportColumns(teams: Team[]) {
  const column = createRookeryColumnHelper<Agent>();
  const teamOf = (agent: Agent) => teams.find((team) => team.id === agent.teamId);

  return column.columns([
    column.accessor('name', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
      cell: ({ row }) => (
        <NavLink to={'/org/agents/' + row.original.id} className="font-medium hover:underline">
          {row.original.name}
        </NavLink>
      ),
      enableHiding: false,
    }),
    column.accessor('title', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Role" />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.title}</span>,
    }),
    column.accessor((row) => teamOf(row)?.name ?? '', {
      id: 'team',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Team" />,
      cell: ({ row }) => {
        const team = teamOf(row.original);
        return team ? (
          <NavLink to="/org/teams" className="hover:underline">
            {team.name}
          </NavLink>
        ) : (
          <span className="text-muted-foreground">No team</span>
        );
      },
    }),
    column.accessor((row) => row.provider ?? '', {
      id: 'provider',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Model" />,
      cell: ({ row }) => (
        <ProviderCell
          {...(row.original.provider ? { provider: row.original.provider } : {})}
          {...(row.original.model ? { model: row.original.model } : {})}
        />
      ),
    }),
    column.accessor((row) => row.permission ?? '', {
      id: 'permission',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Permission" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.permission ? PERMISSION_LABEL[row.original.permission] : 'Default'}
        </span>
      ),
    }),
  ]);
}

/** The agents that report to this one. */
export function ReportsTab({ agent, reports }: { agent: Agent; reports: Agent[] }) {
  const { teams } = useOrgState();
  const columns = useMemo(() => buildReportColumns(teams), [teams]);

  return (
    <DataTable
      flush
      idPrefix="agent-reports"
      data={reports}
      columns={columns}
      paginate={false}
      showColumnMenu={false}
      rowLabel={{ singular: 'Agent', plural: 'Agents' }}
      empty={
        <EmptyState
          icon={UsersIcon}
          title={'No one reports to ' + agent.name}
          description="Assign a manager in an agent’s profile to make that agent a direct report."
          actionLabel="Hire agent"
          actionTo="/org/agents/new"
          variant="plain"
          size="sm"
        />
      }
    />
  );
}
