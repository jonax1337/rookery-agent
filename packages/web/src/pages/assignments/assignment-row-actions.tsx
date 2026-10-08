import { NavLink } from 'react-router';

import {
  BanIcon,
  ClipboardCheckIcon,
  ExternalLinkIcon,
  UserIcon,
} from '@/components/icons';
import { RowMenuButton } from '@/components/common/row-menu-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { isOpenStatus, shortTitle, type AssignmentRow } from './assignment-row';

/**
 * The row menu.
 *
 * "Cancel" sits here rather than only on the detail page: stopping a run
 * that is going wrong used to cost two navigations, which is one too many for
 * something people do while watching the list.
 */
export function AssignmentRowActions({
  row,
  onCancel,
}: {
  row: AssignmentRow;
  onCancel?: (row: AssignmentRow) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <RowMenuButton label={'Actions for ' + shortTitle(row.title)} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem asChild>
          <NavLink to={'/assignments/' + row.id}>
            <ExternalLinkIcon data-icon="inline-start" />
            Open
          </NavLink>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <NavLink to={'/org/agents/' + row.agentId}>
            <UserIcon data-icon="inline-start" />
            Open agent
          </NavLink>
        </DropdownMenuItem>
        {row.taskId ? (
          <DropdownMenuItem asChild>
            <NavLink to={'/tasks/' + row.taskId}>
              <ClipboardCheckIcon data-icon="inline-start" />
              View task
            </NavLink>
          </DropdownMenuItem>
        ) : null}
        {isOpenStatus(row.status) && onCancel ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onCancel(row)}>
              <BanIcon data-icon="inline-start" />
              Cancel
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
