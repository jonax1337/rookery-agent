import { NavLink } from 'react-router';

import {
  ArchiveIcon,
  CheckIcon,
  CopyIcon,
  DeleteIcon as Trash2Icon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  PenToolIcon as PencilIcon,
} from '@/components/icons';

import { formatNumber } from '@/lib/stats';
import type { Project, Session } from '@/lib/types';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
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

const column = createRookeryColumnHelper<Project>();

export const PROJECT_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  path: 'Directory',
  sessions: 'Conversations',
  actions: 'Actions',
};

interface ProjectColumnOptions {
  /** Conversations per project id, counted once per list change. */
  sessionsByProject: ReadonlyMap<string, readonly Session[]>;
  /** The conversation list is still on its way, so counts would read as zero. */
  sessionsLoading: boolean;
  onOpen(project: Project): void;
  onArchive(project: Project): void;
  onDelete(project: Project): void;
}

export function projectColumns({
  sessionsByProject,
  sessionsLoading,
  onOpen,
  onArchive,
  onDelete,
}: ProjectColumnOptions) {
  const conversationCount = (project: Project) => sessionsByProject.get(project.id)?.length ?? 0;

  return column.columns([
    selectionColumn<Project>({ rowLabel: (project) => project.name + ' selected' }),

    column.accessor('name', {
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
      cell: ({ row }) => (
        <DetailDrawerTrigger className="font-medium" onClick={() => onOpen(row.original)}>
          {row.original.name}
        </DetailDrawerTrigger>
      ),
      enableHiding: false,
    }),

    column.accessor((project) => project.description ?? '', {
      id: 'description',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Description" />,
      cell: ({ row }) =>
        row.original.description ? (
          <span className="line-clamp-1 max-w-[28rem] text-muted-foreground">
            {row.original.description}
          </span>
        ) : (
          emptyCell()
        ),
    }),

    column.accessor((project) => project.path ?? '', {
      id: 'path',
      header: ({ column: head }) => <DataTableColumnHeader column={head} title="Directory" />,
      cell: ({ row }) => <PathCell path={row.original.path ?? null} />,
    }),

    column.accessor(conversationCount, {
      id: 'sessions',
      header: ({ column: head }) => (
        <DataTableColumnHeader column={head} title="Conversations" align="end" />
      ),
      cell: ({ row }) => (
        <span className="block text-right tabular-nums text-muted-foreground">
          {sessionsLoading ? '…' : formatNumber(conversationCount(row.original))}
        </span>
      ),
    }),

    actionsColumn<Project>((project) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton label={'Actions for ' + project.name} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => onOpen(project)}>
            <SquareArrowOutUpRightIcon />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <NavLink to={'/org/projects/' + project.id + '/edit'}>
              <PencilIcon />
              Edit
            </NavLink>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onArchive(project)}>
            <ArchiveIcon />
            Archive
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(project)}>
            <Trash2Icon />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )),
  ]);
}

/**
 * The working directory, in the mono face, with a copy button: a path is
 * something people paste into a terminal rather than read.
 *
 * A project without a path is not missing anything - its assignments run in
 * the shared workspace - so it says that rather than showing an empty cell.
 */
function PathCell({ path }: { path: string | null }) {
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  if (!path) return <span className="text-muted-foreground">Workspace</span>;

  return (
    <div className="flex min-w-0 max-w-[22rem] items-center gap-1">
      <span className="truncate font-mono text-xs" title={path}>
        {path}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 text-muted-foreground"
        aria-label="Copy directory"
        onClick={() => copyToClipboard(path)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
}
