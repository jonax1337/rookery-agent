import { NavLink } from 'react-router';

import { BanIcon, ClipboardCheckIcon, UserIcon } from '@/components/icons';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** The page header's actions: "Cancel" while the run is open, plus a menu of related places. */
export function AssignmentHeaderActions({
  open,
  agentId,
  taskId,
  onCancel,
}: {
  open: boolean;
  agentId: string;
  taskId: string | null;
  onCancel: () => void;
}) {
  return (
    <>
      {open ? (
        <Button size="sm" variant="destructive" onClick={onCancel}>
          <BanIcon data-icon="inline-start" />
          Cancel
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton tone="header" label="More actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {taskId ? (
            <DropdownMenuItem asChild>
              <NavLink to={'/tasks/' + taskId}>
                <ClipboardCheckIcon data-icon="inline-start" />
                View task
              </NavLink>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem asChild>
            <NavLink to={'/org/agents/' + agentId}>
              <UserIcon data-icon="inline-start" />
              Open agent
            </NavLink>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
