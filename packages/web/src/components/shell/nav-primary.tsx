import { NavLink } from 'react-router';
import { AudioLinesIcon, PlusIcon } from 'lucide-react';
import { useChatSession } from '@/providers/rookery-provider';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

/**
 * The one thing the sidebar is for before it is navigation: starting a
 * conversation.
 *
 * Markup and classes are dashboard-01's "Quick Create" row - a primary-tinted
 * menu button with a square ghost button beside it that folds away when the
 * rail collapses to icons.
 *
 * The button always starts a brand-new assistant conversation and always
 * reads "New conversation" - chat is assistant-only, so there is no
 * counterpart to switch and no label to keep in sync with one.
 */

export function NavPrimary() {
  const { setOpenMobile } = useSidebar();
  const { newConversation } = useChatSession();

  const label = 'New conversation';

  return (
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            <SidebarMenuButton
              tooltip={label}
              onClick={() => {
                newConversation();
                setOpenMobile(false);
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/90 min-w-8 duration-200 ease-linear"
            >
              <PlusIcon />
              <span>{label}</span>
            </SidebarMenuButton>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  asChild
                  size="icon"
                  variant="outline"
                  className="size-8 group-data-[collapsible=icon]:opacity-0"
                >
                  <NavLink to="/voice" onClick={() => setOpenMobile(false)}>
                    <AudioLinesIcon />
                    <span className="sr-only">Voice</span>
                  </NavLink>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Voice</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
