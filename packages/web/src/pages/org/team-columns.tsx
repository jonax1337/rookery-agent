import { NavLink } from 'react-router';

import {
  DeleteIcon as Trash2Icon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  PenToolIcon as PencilIcon,
  UsersIcon,
} from '@/components/icons';

import { formatNumber } from '@/lib/stats';
import type { Agent, Team } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const column = createRookeryColumnHelper<Team>();

export const TEAM_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  purpose: 'Purpose',
  lead: 'Lead',
  members: 'Members',
  actions: 'Actions',
};

interface TeamColumnOptions {
  org: OrgState;
  /** Members per team id, counted once instead of per rendered cell. */
  membersByTeam: ReadonlyMap<string, readonly Agent[]>;
  onOpen(team: Team): void;
  onShowMembers(team: Team): void;
  onDisband(team: Team): void;
}

export function teamColumns({
  org,
  membersByTeam,
  onOpen,
  onShowMembers,
  onDisband,
}: TeamColumnOptions) {
  const memberCount = (team: Team) => membersByTeam.get(team.id)?.length ?? 0;

  return column.columns([
    selectionColumn<Team>({ rowLabel: (team) => team.name + ' selected' }),

    column.accessor('name', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
      cell: ({ row }) => (
        <DetailDrawerTrigger className="font-medium" onClick={() => onOpen(row.original)}>
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

    column.accessor((team) => org.agentById(team.leadId)?.name ?? '', {
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
    }),

    column.accessor(memberCount, {
      id: 'members',
      header: ({ column: head }) => (
        <DataTableColumnHeader column={head} title="Members" align="end" />
      ),
      cell: ({ row }) => {
        const count = memberCount(row.original);
        if (count === 0) {
          return <span className="block text-right tabular-nums text-muted-foreground">0</span>;
        }
        return (
          <div className="text-right">
            <Button
              variant="link"
              className="h-auto p-0 tabular-nums"
              onClick={() => onShowMembers(row.original)}
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
          <DropdownMenuItem onSelect={() => onOpen(team)}>
            <SquareArrowOutUpRightIcon />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <NavLink to={'/org/teams/' + team.id + '/edit'}>
              <PencilIcon />
              Edit
            </NavLink>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onShowMembers(team)}>
            <UsersIcon />
            View members
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onDisband(team)}>
            <Trash2Icon />
            Disband
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
  ]);
}
