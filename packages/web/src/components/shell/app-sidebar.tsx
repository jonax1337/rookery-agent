import type { ComponentProps, ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
import { FeatherIcon } from 'lucide-react';
import { NAV_GROUPS, navItems, routeMeta, type NavGroup, type RouteMeta } from '@/lib/nav';
import { formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';
import {
  useAllSessionsState,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
import { NavMain, type NavMainItem, type NavSubItem } from '@/components/shell/nav-main';
import { NavPrimary } from '@/components/shell/nav-primary';
import { NavSecondary, type NavSecondaryItem } from '@/components/shell/nav-secondary';
import { NavStatus } from '@/components/shell/nav-status';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

interface AppSidebarProps extends ComponentProps<typeof Sidebar> {
  /** Opens the command palette; the shell owns it, the rail only asks. */
  onSearch(): void;
}

/**
 * The navigation rail (sidebar-16), and nothing but navigation.
 *
 * The conversations used to live down here: a thread list, a folder of voice
 * chats and the page links, three scroll containers stacked inside one
 * column, all competing for the same height. They moved to `/chats`, which is
 * a page and can be a table. What is left is one scroll area with the same
 * entries the breadcrumb and the command palette use, because all three read
 * `ROUTE_META` - the labels used to exist twice and had already drifted.
 *
 * Badges carry only numbers the app is actually holding: loaded conversations,
 * running tasks, live assignments. Nothing is derived from a total the server
 * never sent.
 */
export function AppSidebar({ onSearch, className, ...props }: AppSidebarProps) {
  const { pathname } = useLocation();
  const { setOpenMobile } = useSidebar();
  const tasks = useTasksState();
  const org = useOrgState();
  // The same list `/chats` shows, not the chat hub's own slice: that one holds
  // only the current counterpart's typed conversations, so its length would
  // contradict the page the badge points at. It comes from the provider, so
  // a deletion on `/chats` moves this number at once instead of leaving it
  // standing until the next socket event.
  const { sessions, capped, limit } = useAllSessionsState();
  // Archived rows are behind a facet on that page, so they are not what the
  // badge is counting.
  const openConversations = sessions.filter((session) => !session.archived).length;

  /**
   * Counts the rail may show, keyed by the route they belong to.
   *
   * Every one of them is a number the app is holding, and two of them are
   * held over a list the server cuts off - so neither is allowed to look
   * exact. The conversation count grows a "+" the moment its list sits on the
   * limit, and the task count says out loud that subtasks are not in it.
   * Zero is not news: an entry without a count renders no badge at all.
   */
  const runningTasks = tasks.countByStatus.running;
  const liveAssignments = org.running.length;

  const badges: Record<string, { node: ReactNode; label?: string }> = {
    ...(openConversations > 0
      ? {
          '/chats': {
            node: formatNumber(openConversations) + (capped ? '+' : ''),
            ...(capped
              ? {
                  label:
                    'at least ' +
                    formatNumber(openConversations) +
                    ' open conversations; the list is limited to ' +
                    formatNumber(limit),
                }
              : {}),
          },
        }
      : {}),
    ...(runningTasks > 0
      ? {
          '/tasks': {
            node: formatNumber(runningTasks),
            label: 'running top-level tasks; subtasks are not included',
          },
        }
      : {}),
    ...(liveAssignments > 0 ? { '/assignments': { node: formatNumber(liveAssignments) } } : {}),
  };

  const buildItem = (meta: RouteMeta): NavMainItem => {
    const subItems: NavSubItem[] =
      meta.children?.flatMap((childPath) => {
        const child = routeMeta(childPath);
        if (!child) return [];
        return [{ title: child.label, url: child.path, isActive: subActive(pathname, child, meta) }];
      }) ?? [];

    const badge = badges[meta.path];
    return {
      title: meta.navLabel ?? meta.label,
      url: meta.redirect ?? meta.path,
      icon: meta.icon ?? FeatherIcon,
      isActive: isActive(pathname, meta.path),
      ...(badge ? { badge: badge.node, ...(badge.label ? { badgeLabel: badge.label } : {}) } : {}),
      ...(subItems.length > 0 ? { items: subItems } : {}),
    };
  };

  // No search entry here: the site header carries one, with the same shortcut.
  // Two fields for one command palette read as two different searches.
  const secondary: NavSecondaryItem[] = [
    ...navItems('secondary').map((meta) => ({
      title: meta.navLabel ?? meta.label,
      icon: meta.icon ?? FeatherIcon,
      url: meta.redirect ?? meta.path,
      isActive: isActive(pathname, meta.path),
    })),
  ];

  return (
    <Sidebar
      collapsible="icon"
      // Fixed positioning plus a header that spans the full width: the rail
      // has to be told where the header ends.
      className={cn('top-(--header-height) h-[calc(100svh-var(--header-height))]!', className)}
      {...props}
    >
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/dashboard" onClick={() => setOpenMobile(false)}>
                {/*
                  The brand, not a stand-in for it. The rail collapses to icon
                  width, so the mark carries the collapsed state and the
                  wordmark the expanded one. Both are solid-colour artwork
                  rather than themeable SVG, so each ships a light and a dark
                  cut; the mark is decorative because the wordmark beside it
                  already names the app.

                  The assistant's name does not belong up here as well - it is
                  on the avatar in the footer, and printing it twice made the
                  header read as two labels for one thing.
                */}
                <img
                  src="/mark.svg"
                  alt="Rookery"
                  className="hidden size-7 shrink-0 group-data-[collapsible=icon]:block dark:group-data-[collapsible=icon]:hidden"
                />
                <img
                  src="/mark-light.svg"
                  alt="Rookery"
                  className="hidden size-7 shrink-0 dark:group-data-[collapsible=icon]:block"
                />
                <img
                  src="/logo.svg"
                  alt="Rookery"
                  className="h-8 w-auto group-data-[collapsible=icon]:hidden dark:hidden"
                />
                <img
                  src="/logo-light.svg"
                  alt="Rookery"
                  className="hidden h-8 w-auto group-data-[collapsible=icon]:hidden dark:block dark:group-data-[collapsible=icon]:hidden"
                />
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <NavPrimary />
        {NAV_GROUPS.filter(isLabelled).map((group) => (
          <NavMain key={group.id} label={group.label} items={navItems(group.id).map(buildItem)} />
        ))}
      </SidebarContent>

      <SidebarFooter>
        <NavSecondary items={secondary} className="p-0" />
        <NavStatus />
      </SidebarFooter>
    </Sidebar>
  );
}

/** Narrows away the one group that renders without a heading. */
function isLabelled(group: { id: NavGroup; label: string | null }): group is {
  id: NavGroup;
  label: string;
} {
  return group.label !== null;
}

/**
 * Which entry the current URL belongs to.
 *
 * A section owns its whole subtree, so an agent's page keeps "Firma" lit.
 * "Gespräche" additionally owns the chat hub (`/` and `/c/<id>`): an open
 * conversation has no sidebar entry of its own any more and would otherwise
 * leave the navigation showing nothing at all.
 */
function isActive(pathname: string, path: string): boolean {
  if (path === '/chats') {
    return pathname === '/chats' || pathname === '/' || pathname.startsWith('/c/');
  }
  return pathname === path || pathname.startsWith(path + '/');
}

/**
 * A sub-entry that *is* its section (`/memory` under "Gedächtnis") must match
 * exactly, or it would stay lit on every sibling tab.
 */
function subActive(pathname: string, child: RouteMeta, parent: RouteMeta): boolean {
  if (child.path === parent.path) return pathname === child.path;
  return isActive(pathname, child.path);
}
