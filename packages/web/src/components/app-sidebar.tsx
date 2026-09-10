import { useState, type ComponentProps } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useAuiState } from '@assistant-ui/react';
import {
  AudioLinesIcon,
  BrainIcon,
  Building2Icon,
  ChevronRightIcon,
  CalendarClockIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  SettingsIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Session } from '@/lib/types';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { SparklesIcon, WrenchIcon } from 'lucide-react';
import {
  ThreadListItems,
  ThreadListNew,
  ThreadListRoot,
  ThreadListSearch,
} from '@/components/assistant-ui/elements/thread-list.aui';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboardIcon },
  { to: '/', label: 'Chat', icon: MessagesSquareIcon },
  { to: '/voice', label: 'Sprechen', icon: AudioLinesIcon },
  { to: '/org', label: 'Firma', icon: Building2Icon },
  { to: '/tasks', label: 'Aufgaben', icon: ListTodoIcon },
  { to: '/assignments', label: 'Aufträge', icon: ClipboardListIcon },
  { to: '/cron', label: 'Zeitpläne', icon: CalendarClockIcon },
  { to: '/tools', label: 'Werkzeuge', icon: WrenchIcon },
  { to: '/skills', label: 'Skills', icon: SparklesIcon },
  { to: '/memory', label: 'Gedächtnis', icon: BrainIcon },
  { to: '/settings', label: 'Einstellungen', icon: SettingsIcon },
] as const;

const VOICE_FOLDER_OPEN = 'rookery.sidebar.voiceOpen';

/** The chat owns `/` and `/c/<id>`; every other entry owns its whole subtree. */
function isActive(pathname: string, to: string): boolean {
  if (to === '/') return pathname === '/' || pathname.startsWith('/c/');
  return pathname === to || pathname.startsWith(to + '/');
}

type AppSidebarProps = ComponentProps<typeof Sidebar> & {
  connected: boolean;
  /** Who the chat is with right now. Null means the assistant. */
  counterpartId: string | null;
  /** Where "Chat" leads: the open conversation, or the blank chat. */
  chatPath: string;
  /** Hands-free conversations, filed in their own collapsed folder. */
  voiceSessions: Session[];
  activeId: string | null;
  /** "Chat" always returns to the assistant; agent chats open from the agent's page. */
  onSelectCounterpart(id: string | null): void;
};

/**
 * The stock thread list, split so "new" and search stay put while only the
 * conversations scroll. In one scroll box the two controls would slide out of
 * view after a handful of chats.
 */
function ConversationList() {
  const [search, setSearch] = useState('');
  const hasThreads = useAuiState((s) => s.threads.threadIds.length > 0);

  return (
    <ThreadListRoot className="min-h-0 flex-1">
      <ThreadListNew />
      {hasThreads && <ThreadListSearch value={search} onValueChange={setSearch} />}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <ThreadListItems searchQuery={hasThreads ? search : ''} />
      </div>
    </ThreadListRoot>
  );
}

/**
 * assistant-ui's `threadlist-sidebar` shell with the app's own pages on top:
 * brand in the header, page navigation, then the stock thread list of the
 * conversations with whoever is currently being written to.
 *
 * The chat is the assistant's by default. A direct chat with an agent starts
 * from that agent's page; "Chat" in the navigation always leads back home.
 */
export function AppSidebar({
  connected,
  counterpartId,
  chatPath,
  voiceSessions,
  activeId,
  onSelectCounterpart,
  ...props
}: AppSidebarProps) {
  const { pathname } = useLocation();
  const [voiceOpen, setVoiceOpen] = useState(() => {
    try {
      return localStorage.getItem(VOICE_FOLDER_OPEN) === '1';
    } catch {
      return false;
    }
  });
  const toggleVoiceFolder = (open: boolean): void => {
    setVoiceOpen(open);
    try {
      localStorage.setItem(VOICE_FOLDER_OPEN, open ? '1' : '0');
    } catch {
      // Private mode; the folder state lives for this visit only.
    }
  };

  return (
    <Sidebar {...props}>
      <SidebarHeader className="border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/dashboard" aria-label="Rookery Dashboard">
                <img src="/logo.svg" alt="Rookery" className="h-6 w-auto dark:hidden" />
                <img src="/logo-light.svg" alt="" className="hidden h-6 w-auto dark:block" aria-hidden="true" />
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="overflow-hidden">
        <SidebarGroup className="shrink-0">
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(pathname, item.to)}
                    tooltip={item.label}
                  >
                    <NavLink
                      to={item.to === '/' && counterpartId === null ? chatPath : item.to}
                      onClick={() => {
                        if (item.to === '/' && counterpartId !== null) onSelectCounterpart(null);
                      }}
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {voiceSessions.length > 0 && (
          <Collapsible open={voiceOpen} onOpenChange={toggleVoiceFolder} className="shrink-0">
            <SidebarGroup className="py-0">
              <CollapsibleTrigger asChild>
                <SidebarGroupLabel className="cursor-pointer gap-1 hover:text-foreground">
                  <ChevronRightIcon className={cn('size-3.5 transition-transform', voiceOpen && 'rotate-90')} />
                  Sprachgespräche
                  <span className="ml-auto text-[10px]">{voiceSessions.length}</span>
                </SidebarGroupLabel>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarGroupContent className="max-h-40 overflow-y-auto [scrollbar-width:thin]">
                  <SidebarMenu>
                    {voiceSessions.map((session) => (
                      <SidebarMenuItem key={session.id}>
                        <SidebarMenuButton asChild isActive={activeId === session.id} tooltip={session.title}>
                          <NavLink to={'/c/' + session.id}>
                            <AudioLinesIcon />
                            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                              {session.title}
                            </span>
                          </NavLink>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        )}

        <SidebarGroup className="flex min-h-40 flex-1 flex-col">
          <SidebarGroupLabel className="shrink-0">Gespräche</SidebarGroupLabel>
          <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
            <ConversationList />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {props.collapsible !== 'none' && <SidebarRail />}

      <SidebarFooter className="border-t">
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span
            className={cn('size-2 rounded-full', connected ? 'bg-emerald-500' : 'bg-destructive')}
            aria-hidden="true"
          />
          {connected ? 'Mit Rookery-Server verbunden' : 'Keine Verbindung zum Server'}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
