import { NavLink } from 'react-router';

import { RowMenuButton } from '@/components/common/row-menu-button';
import { ArchiveIcon, PenToolIcon as PencilIcon, SendIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Agent } from '@/lib/types';

/** The page header's buttons: hand over a task, or edit/archive from the menu. */
export function AgentHeaderActions({
  agent,
  onAssign,
  onArchive,
}: {
  agent: Agent;
  onAssign: () => void;
  onArchive: () => void;
}) {
  return (
    <>
      <Button size="sm" onClick={onAssign} disabled={agent.archived}>
        {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
        <SendIcon data-icon="inline-start" />
        Create assignment
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton tone="header" label="More actions" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem asChild>
            <NavLink to={'/org/agents/' + agent.id + '/edit'}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </NavLink>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" disabled={agent.archived} onSelect={onArchive}>
            <ArchiveIcon data-icon="inline-start" />
            Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
