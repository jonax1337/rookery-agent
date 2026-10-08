import { NavLink } from 'react-router';

import {
  ArchiveIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  PenToolIcon as PencilIcon,
} from '@/components/icons';

import { PERMISSION_LABEL } from '@/lib/format';
import type { Agent, OrgPerformanceEntry } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { actionsColumn, selectionColumn } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { ProviderCell } from '@/components/common/provider-cell';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { StageCell } from './StageCell';

const column = createRookeryColumnHelper<Agent>();

export const AGENT_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  title: 'Title',
  slug: 'Slug',
  team: 'Team',
  manager: 'Manager',
  provider: 'Provider',
  permission: 'Permission',
  stage: 'Performance',
  actions: 'Actions',
};

interface AgentColumnOptions {
  org: OrgState;
  /** The escalation stage per agent id; agents without an entry count as healthy. */
  standings: ReadonlyMap<string, OrgPerformanceEntry>;
  onOpen(agent: Agent): void;
  onOpenPage(agent: Agent): void;
  onArchive(agent: Agent): void;
}

export function agentColumns({ org, standings, onOpen, onOpenPage, onArchive }: AgentColumnOptions) {
  const stageOf = (agent: Agent) => standings.get(agent.id)?.performance.stage ?? 0;
  const teamNameOf = (agent: Agent) => org.teams.find((team) => team.id === agent.teamId)?.name;

  return column.columns([
    selectionColumn<Agent>({ rowLabel: (agent) => agent.name + ' selected' }),

    column.accessor('name', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
      cell: ({ row }) => (
        <DetailDrawerTrigger className="font-medium" onClick={() => onOpen(row.original)}>
          {row.original.name}
        </DetailDrawerTrigger>
      ),
      enableHiding: false,
    }),

    column.accessor('title', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Title" />,
      cell: ({ row }) => (
        <span className="line-clamp-1 text-muted-foreground">{row.original.title}</span>
      ),
    }),

    column.accessor('slug', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Slug" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-mono font-normal">
          {row.original.slug}
        </Badge>
      ),
    }),

    // Sorted by the team's name, not its id, so the column groups the way it reads.
    column.accessor((agent) => teamNameOf(agent) ?? '', {
      id: 'team',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Team" />,
      cell: ({ row }) => {
        const team = org.teams.find((candidate) => candidate.id === row.original.teamId);
        if (!team) return <span className="text-muted-foreground">No team</span>;
        return (
          <NavLink to={'/org/agents?team=' + team.id} className="hover:underline">
            {team.name}
          </NavLink>
        );
      },
    }),

    column.accessor((agent) => org.agentById(agent.managerId)?.name ?? '', {
      id: 'manager',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Manager" />,
      cell: ({ row }) => {
        const manager = org.agentById(row.original.managerId);
        if (!manager) return <span className="text-muted-foreground">The assistant</span>;
        return (
          <NavLink to={'/org/agents/' + manager.id} className="hover:underline">
            {manager.name}
          </NavLink>
        );
      },
    }),

    column.accessor((agent) => agent.provider ?? '', {
      id: 'provider',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Provider" />,
      cell: ({ row }) => (
        <ProviderCell
          fallback="Default"
          provider={row.original.provider}
          model={row.original.model}
        />
      ),
    }),

    column.accessor((agent) => agent.permission ?? '', {
      id: 'permission',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Permission" />,
      cell: ({ row }) =>
        row.original.permission ? (
          <Badge variant="outline" className="font-normal">
            {PERMISSION_LABEL[row.original.permission]}
          </Badge>
        ) : (
          <span className="text-muted-foreground">Default</span>
        ),
    }),

    column.accessor(stageOf, {
      id: 'stage',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Performance" />,
      cell: ({ row }) => <StageCell stage={stageOf(row.original)} />,
    }),

    actionsColumn<Agent>((agent) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton label={'Actions for ' + agent.name} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => onOpenPage(agent)}>
            <SquareArrowOutUpRightIcon />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <NavLink to={'/org/agents/' + agent.id + '/edit'}>
              <PencilIcon />
              Edit
            </NavLink>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onArchive(agent)}>
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
  ]);
}
