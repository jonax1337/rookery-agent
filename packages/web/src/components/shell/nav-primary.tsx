import { NavLink } from 'react-router';
import { AudioLinesIcon, BotIcon, ChevronsUpDownIcon, FeatherIcon, PlusIcon } from 'lucide-react';
import { useChatSession, useConfig, useOrgState } from '@/providers/rookery-provider';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
 * menu button with square ghost buttons beside it that fold away when the
 * rail collapses to icons.
 *
 * The button starts a thread with whoever the chat hub is talking to, and
 * says so: a conversation belongs to one counterpart for life, so "Neues
 * Gespräch" while an agent is selected would be a lie. The chooser beside it
 * is the only way back - picking an agent from its own page sets the
 * counterpart, and without this nothing ever set it back to the assistant.
 */

/** Radix' radio groups have no empty value, so "the assistant" needs one. */
const ASSISTANT = '__assistant__';

export function NavPrimary() {
  const { setOpenMobile } = useSidebar();
  const { counterpart, newConversation, chooseCounterpart } = useChatSession();
  const { assistantName } = useConfig();
  const org = useOrgState();

  // A retired agent is not on the list any more - unless the open conversation
  // belongs to it, because a radio group with no matching value would look
  // like nobody is selected at all.
  const agents = org.agents.filter((agent) => !agent.archived || agent.id === counterpart?.id);
  const label = counterpart ? 'Neu mit ' + counterpart.name : 'Neues Gespräch';

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

            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="outline"
                      className="size-8 group-data-[collapsible=icon]:opacity-0"
                    >
                      <ChevronsUpDownIcon />
                      <span className="sr-only">Gegenüber wählen</span>
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">Gegenüber wählen</TooltipContent>
              </Tooltip>
              <DropdownMenuContent side="right" align="start" className="w-56">
                <DropdownMenuLabel>Gespräch mit</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuRadioGroup
                  value={counterpart?.id ?? ASSISTANT}
                  onValueChange={(value) => {
                    chooseCounterpart(value === ASSISTANT ? null : value);
                    setOpenMobile(false);
                  }}
                >
                  <DropdownMenuRadioItem value={ASSISTANT}>
                    <FeatherIcon />
                    {assistantName}
                  </DropdownMenuRadioItem>
                  {agents.map((agent) => (
                    <DropdownMenuRadioItem key={agent.id} value={agent.id}>
                      <BotIcon />
                      {agent.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>

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
                    <span className="sr-only">Sprechen</span>
                  </NavLink>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">Sprechen</TooltipContent>
            </Tooltip>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
