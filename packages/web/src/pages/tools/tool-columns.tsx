import { NavLink } from 'react-router';

import {
  DownloadIcon,
  ExternalLinkIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
} from '@/components/icons';

import { AUDIENCE_LABEL, INSTALL_LABEL, toolStatus } from '@/lib/tools';
import type { ToolServer } from '@/lib/types';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { actionsColumn, selectionColumn } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';

import { RemoveToolMenuItem } from './tool-actions';
import { ToolStatusBadge } from './ToolStatusBadge';

const column = createRookeryColumnHelper<ToolServer>();

export const TOOL_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  status: 'Status',
  audience: 'Audience',
  install: 'Source',
  enabled: 'Active',
  actions: 'Actions',
};

interface ToolColumnOptions {
  /** The server whose preparation is running, so its row menu can show it. */
  preparingId: string | null;
  onToggle(tool: ToolServer, on: boolean): void;
  onOpen(tool: ToolServer): void;
  onPrepare(tool: ToolServer): void;
  onRemove(tool: ToolServer): void;
}

export function toolColumns({
  preparingId,
  onToggle,
  onOpen,
  onPrepare,
  onRemove,
}: ToolColumnOptions) {
  return column.columns([
    selectionColumn<ToolServer>({ rowLabel: (tool) => tool.name + ' selected' }),

    column.accessor('name', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
      cell: ({ row }) => (
        <div className="min-w-0 max-w-[24rem]">
          <NavLink to={'/tools/' + row.original.id} className="font-medium hover:underline">
            {row.original.name}
          </NavLink>
          <p className="line-clamp-1 text-xs text-muted-foreground">{row.original.description}</p>
        </div>
      ),
      enableHiding: false,
    }),

    // Sorted by the caption, so "Key missing" and "Ready" group up.
    column.accessor((tool) => toolStatus(tool).label, {
      id: 'status',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
      cell: ({ row }) => <ToolStatusBadge tool={row.original} />,
    }),

    column.accessor('audience', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Audience" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {AUDIENCE_LABEL[row.original.audience]}
        </Badge>
      ),
    }),

    column.accessor('install', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
      // A discovered server names the installation it came from: "Claude
      // Code - vercel" says more than "already installed here" does.
      cell: ({ row }) => (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {row.original.source || INSTALL_LABEL[row.original.install]}
        </Badge>
      ),
    }),

    column.accessor('enabled', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Active" />,
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={!row.original.installed}
          aria-label={'Enable ' + row.original.name}
          onCheckedChange={(on) => onToggle(row.original, on)}
        />
      ),
    }),

    actionsColumn<ToolServer>((tool) => {
      const preparing = preparingId === tool.id;
      return (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <RowMenuButton label={'Actions for ' + tool.name} busy={preparing} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => onOpen(tool)}>
              <SquareArrowOutUpRightIcon />
              Open
            </DropdownMenuItem>
            {tool.prepare ? (
              <DropdownMenuItem
                disabled={preparing}
                onSelect={(event) => {
                  event.preventDefault();
                  onPrepare(tool);
                }}
              >
                <DownloadIcon />
                {tool.prepare.label}
              </DropdownMenuItem>
            ) : null}
            {tool.homepage ? (
              <DropdownMenuItem asChild>
                <a href={tool.homepage} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon />
                  Open project page
                </a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <RemoveToolMenuItem tool={tool} onRemove={() => onRemove(tool)} />
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }),
  ]);
}
