import { useMemo, useState } from 'react';
import { Outlet } from 'react-router';
import { MessageSquarePlusIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  useAllSessionsState,
  useChatSession,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
import { SiteHeader } from '@/components/shell/site-header';
import { AppSidebar } from '@/components/shell/app-sidebar';
import { CommandPalette, type CommandAction } from '@/components/common/command-palette';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';

/**
 * The frame every page sits in (sidebar-16).
 *
 * The header spans the full width above both columns, so the sidebar starts
 * below it - that is the whole difference to dashboard-01's inset shell, and
 * the reason the two cannot be mixed.
 *
 * `h-svh` plus `min-h-0` all the way down is not decoration: the chat thread
 * brings its own scroll container, and without a height that actually ends
 * somewhere it would grow past the viewport and take the composer with it.
 */
export function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Search all loaded conversations, rather than the chat hub's 50-row
  // slice for the current counterpart. Archived conversations stay hidden.
  const allSessions = useAllSessionsState();
  const paletteSessions = useMemo(
    () => allSessions.sessions.filter((session) => !session.archived),
    [allSessions.sessions],
  );
  const { newConversation } = useChatSession();
  const org = useOrgState();
  const tasks = useTasksState();
  const { resolvedTheme, setTheme } = useTheme();

  const actions: CommandAction[] = [
    {
      id: 'new-chat',
      label: 'New conversation',
      icon: MessageSquarePlusIcon,
      keywords: ['chat', 'conversation', 'unterhaltung'],
      run: newConversation,
    },
    {
      id: 'theme',
      label: resolvedTheme === 'dark' ? 'Light theme' : 'Dark theme',
      icon: resolvedTheme === 'dark' ? SunIcon : MoonIcon,
      keywords: ['theme', 'light', 'dark', 'hell', 'dunkel'],
      run: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
    },
  ];

  return (
    <div className="[--header-height:calc(--spacing(14))]">
      <SidebarProvider className="flex h-svh flex-col overflow-hidden">
          {/* First in tab order so keyboard users can skip navigation.
            The link becomes visible on focus and targets the main element. */}
        <a
          href="#inhalt"
          className="sr-only z-50 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:shadow-md focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        >
          Skip to content
        </a>
        <SiteHeader onSearch={() => setPaletteOpen(true)} />
        <div className="flex min-h-0 flex-1">
          {/* The rail knows where the header ends and what it links to; all it
              needs from the shell is the way into the palette. */}
          <AppSidebar onSearch={() => setPaletteOpen(true)} />
          <SidebarInset
            id="inhalt"
            tabIndex={-1}
            className="flex min-h-0 flex-col overflow-hidden outline-none"
          >
            <Outlet />
          </SidebarInset>
        </div>

        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          actions={actions}
          sessions={paletteSessions}
          agents={org.agents}
          teams={org.teams}
          projects={org.projects}
          assignments={org.running}
          tasks={tasks.tasks}
        />
      </SidebarProvider>
    </div>
  );
}
