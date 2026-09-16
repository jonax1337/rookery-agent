import { NavLink } from 'react-router';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { useChatSession } from '@/providers/rookery-provider';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AudioLinesIcon, PlusIcon } from '@/components/icons';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

/**
 * The one thing the sidebar is for before it is navigation: starting a
 * conversation.
 *
 * Still dashboard-01's "Quick Create" row - a primary action with a square
 * ghost button beside it that folds away when the rail collapses to icons -
 * but the action is a real Button, the same one the conversations page's
 * header carries. As a menu button it registered as a highlight item, and the
 * rail's floating hover background sprang onto it: through the primary fill's
 * translucent hover it read as an amber halo above the navigation it belongs
 * to. Actions do not ride the navigation highlight.
 *
 * The button always starts a brand-new assistant conversation and always
 * reads "New conversation" - chat is assistant-only, so there is no
 * counterpart to switch and no label to keep in sync with one.
 */

export function NavPrimary() {
  const { setOpenMobile, state, isMobile } = useSidebar();
  const { newConversation } = useChatSession();

  const label = 'New conversation';

  return (
    // The quick-create block fades in as one section on mount - the same
    // treatment the other sidebar groups get, never row by row.
    <Fade>
      <SidebarGroup>
        <SidebarGroupContent className="flex flex-col gap-2">
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-2">
              {/*
                A plain Button, not a SidebarMenuButton: the menu button
                registers itself as a highlight item, and the rail's floating
                hover background would plate itself under the primary fill -
                shining through its 90%-opacity hover as an amber halo. The
                real Button gets the press dip and the spinning plus its twin
                in the conversations header has. Collapsed to icons, the
                same group-data classes as a menu button fold it to the icon
                square, and the tooltip below stands in for the hidden label.
              */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    onClick={() => {
                      newConversation();
                      setOpenMobile(false);
                    }}
                    className="min-w-0 flex-1 justify-start gap-2 px-2 transition-[width,height,padding,background-color,color] duration-200 ease-linear group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
                  >
                    <PlusIcon className="size-4" />
                    <span className="group-data-[collapsible=icon]:hidden">
                      {label}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="right"
                  align="center"
                  hidden={state !== 'collapsed' || isMobile}
                >
                  {label}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    asChild
                    size="icon"
                    variant="outline"
                    className="size-8 group-data-[collapsible=icon]:opacity-0"
                  >
                    <NavLink to="/voice" onClick={() => setOpenMobile(false)}>
                      {/* The button base parks pointer-events on none for
                          icons; the equaliser needs them back to dance under
                          the pointer. */}
                      <AudioLinesIcon className="pointer-events-auto! size-4" />
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
    </Fade>
  );
}
