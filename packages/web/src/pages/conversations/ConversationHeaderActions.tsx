import { NavLink } from 'react-router';

import { RowMenuButton } from '@/components/common/row-menu-button';
import { AudioLinesIcon, PlusIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * One primary action, with its variant on the split. Speaking and writing
 * both start a conversation, so the voice entry belongs on this button
 * rather than glued beside it as a second, equal-looking one.
 */
export function ConversationHeaderActions({ onNewConversation }: { onNewConversation(): void }) {
  return (
    <>
      <Button size="sm" onClick={onNewConversation}>
        {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
        <PlusIcon data-icon="inline-start" />
        New conversation
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton tone="header" label="More ways to start a conversation" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <NavLink to="/voice">
              <AudioLinesIcon />
              Voice conversation
            </NavLink>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
