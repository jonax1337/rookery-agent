import { NavLink } from 'react-router';

import {
  DeleteIcon as Trash2Icon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  PenToolIcon as PencilIcon,
} from '@/components/icons';

import { AUDIENCE_LABEL } from '@/lib/tools';
import { formatNumber } from '@/lib/stats';
import type { Skill, SkillOrigin } from '@/lib/types';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  relativeTimeCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
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

/**
 * Who wrote a skill. Worth a column of its own now that the shelf is no
 * longer only what a person put there: the assistant writes one with
 * `write_skill` when it works something out, the nightly run distils one out
 * of what the memory keeps repeating, and a few ship with Rookery itself.
 */
const SKILL_ORIGIN_LABEL: Record<SkillOrigin, string> = {
  user: 'You',
  agent: 'Agent',
  sleep: 'Night',
  builtin: 'Rookery',
};

const column = createRookeryColumnHelper<Skill>();

export const SKILL_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  audience: 'Audience',
  origin: 'Written by',
  files: 'Files',
  updatedAt: 'Updated',
  actions: 'Actions',
};

/** Editing a shipped skill does not change it: it writes your own copy, which then takes precedence. */
export function editLabel(skill: Skill): string {
  return skill.origin === 'builtin' ? 'Write your own version' : 'Edit';
}

interface SkillColumnOptions {
  onOpen(skill: Skill): void;
  onEdit(skill: Skill): void;
  onDelete(skill: Skill): void;
}

export function skillColumns({ onOpen, onEdit, onDelete }: SkillColumnOptions) {
  return column.columns([
    selectionColumn<Skill>({ rowLabel: (skill) => skill.name + ' selected' }),

    column.accessor('name', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
      cell: ({ row }) => (
        // The detail page, not the edit form: reading a skill should not
        // start by opening its source in a textarea.
        <NavLink to={'/skills/' + row.original.name} className="font-medium hover:underline">
          {row.original.name}
        </NavLink>
      ),
      enableHiding: false,
    }),

    column.accessor('description', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Description" />,
      cell: ({ row }) => (
        <p className="line-clamp-1 max-w-[32rem] text-muted-foreground">
          {row.original.description}
        </p>
      ),
    }),

    column.accessor('audience', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Audience" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {AUDIENCE_LABEL[row.original.audience]}
        </Badge>
      ),
    }),

    column.accessor('origin', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Written by" />,
      cell: ({ row }) => (
        <Badge
          variant={row.original.origin === 'user' ? 'outline' : 'secondary'}
          className="font-normal"
        >
          {SKILL_ORIGIN_LABEL[row.original.origin]}
        </Badge>
      ),
    }),

    column.accessor((skill) => skill.files.length, {
      id: 'files',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Files" align="end" />,
      cell: ({ row }) =>
        row.original.files.length > 0 ? (
          <span className="block text-right tabular-nums text-muted-foreground">
            {formatNumber(row.original.files.length)}
          </span>
        ) : (
          emptyCell('end')
        ),
    }),

    column.accessor('updatedAt', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Updated" />,
      // A shipped skill has no mtime: it changes when Rookery does, so
      // the cell says where it comes from instead of "never".
      cell: ({ row }) =>
        relativeTimeCell(
          row.original.updatedAt,
          row.original.origin === 'builtin' ? { fallback: 'with Rookery' } : {},
        ),
    }),

    actionsColumn<Skill>((skill) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton label={'Actions for ' + skill.name} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onSelect={() => onOpen(skill)}>
            <SquareArrowOutUpRightIcon />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onEdit(skill)}>
            <PencilIcon />
            {editLabel(skill)}
          </DropdownMenuItem>
          {skill.origin === 'builtin' ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(skill)}>
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )),
  ]);
}
