import { NavLink } from 'react-router';
import { AudioLinesIcon } from '@/components/animate-ui/icons/audio-lines';
import { PlusIcon } from '@/components/animate-ui/icons/plus';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
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
    // The quick-create block fades in as one section on mount - the same
    // treatment the other sidebar groups get, never row by row.
    <Fade>
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
                <PlusIcon className="size-4" animateOnHover />
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
                      {/* The button base parks pointer-events on none for
                          icons; the equaliser needs them back to dance under
                          the pointer. */}
                      <AudioLinesIcon className="pointer-events-auto! size-4" animateOnHover />
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
