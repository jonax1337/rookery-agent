import { FeatherIcon } from "@/components/icons";
import type { ComponentProps, ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';

import { NAV_GROUPS, navItems, type NavGroup, type RouteMeta } from '@/lib/nav';
import { formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';
import {
  useAllSessionsState,
  useNotificationState,
  useOrgState,
  useTasksState,
} from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { NavMain, type NavMainItem } from '@/components/shell/nav-main';
import { NavPrimary } from '@/components/shell/nav-primary';
import { NavSecondary, type NavSecondaryItem } from '@/components/shell/nav-secondary';
import { NavStatus } from '@/components/shell/nav-status';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

interface RailBadge {
  node: ReactNode;
  label?: string;
}

/**
 * The rail builds itself top to bottom: one stagger across all sections (brand
 * first, footer last), capped so a longer navigation cannot string it out.
 * Sections, never single rows - the rows themselves stay still.
 */
const SECTION_STAGGER_MS = 50;
const MAX_SECTION_DELAY_MS = 400;

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
export function AppSidebar({ className, ...props }: ComponentProps<typeof Sidebar>) {
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
  const notifications = useNotificationState();

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

  const badges: Record<string, RailBadge> = {};
  if (openConversations > 0) {
    badges['/chats'] = {
      node: (
        <>
          <RollingCount value={openConversations} />
          {capped ? '+' : ''}
        </>
      ),
      ...(capped
        ? {
            label:
              'at least ' +
              formatNumber(openConversations) +
              ' open conversations; the list is limited to ' +
              formatNumber(limit),
          }
        : {}),
    };
  }
  if (runningTasks > 0) {
    badges['/tasks'] = {
      node: <RollingCount value={runningTasks} />,
      label: 'running top-level tasks; subtasks are not included',
    };
  }
  if (liveAssignments > 0) {
    badges['/assignments'] = { node: <RollingCount value={liveAssignments} /> };
  }
  // Unread notifications - a schedule result, an agent's question, a
  // finished card - on the row that opens them.
  if (notifications.unreadCount > 0) {
    badges['/inbox'] = {
      node: <RollingCount value={notifications.unreadCount} />,
      label: 'unread notifications',
    };
  }

  const buildItem = (meta: RouteMeta): NavMainItem => {
    const badge = badges[meta.path];
    return {
      ...routeEntry(meta, pathname),
      ...(badge ? { badge: badge.node, ...(badge.label ? { badgeLabel: badge.label } : {}) } : {}),
    };
  };

  // No search entry here: the site header carries one, with the same shortcut.
  // Two fields for one command palette read as two different searches.
  const secondary: NavSecondaryItem[] = navItems('secondary').map((meta) =>
    routeEntry(meta, pathname),
  );

  const labelledGroups = NAV_GROUPS.filter(isLabelled);
  const sectionDelay = (index: number) => Math.min(index * SECTION_STAGGER_MS, MAX_SECTION_DELAY_MS);

  return (
    <Sidebar
      collapsible="icon"
      // Fixed positioning plus a header that spans the full width: the rail
      // has to be told where the header ends.
      className={cn('top-(--header-height) h-[calc(100svh-var(--header-height))]!', className)}
      {...props}
    >
      <SidebarHeader>
        <Fade>
          <SidebarMenu>
            <SidebarMenuItem>
              {/*
                A plain NavLink, not a SidebarMenuButton: the menu button
                registers itself as a highlight item, and the rail's floating
                hover background would plate itself behind the brand. A logo is
                not navigation - the same reasoning that made the quick-create
                row a plain Button. The classes carry the lg menu button's
                geometry (the h-12 row, the icon square when collapsed), so
                only the highlight registration is lost, not the layout.
              */}
              <NavLink
                to="/dashboard"
                onClick={() => setOpenMobile(false)}
                className="flex h-12 w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm ring-sidebar-ring outline-hidden focus-visible:ring-2 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-0!"
              >
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
                  src="/mark-small.svg"
                  alt="Rookery"
                  className="hidden size-6 shrink-0 group-data-[collapsible=icon]:block dark:group-data-[collapsible=icon]:hidden"
                />
                <img
                  src="/mark-small-light.svg"
                  alt="Rookery"
                  className="hidden size-6 shrink-0 dark:group-data-[collapsible=icon]:block"
                />
                <img
                  src="/logo.svg"
                  alt="Rookery"
                  width={524}
                  height={150}
                  className="h-auto w-40 group-data-[collapsible=icon]:hidden dark:hidden"
                />
                <img
                  src="/logo-light.svg"
                  alt="Rookery"
                  width={524}
                  height={150}
                  className="hidden h-auto w-40 group-data-[collapsible=icon]:hidden dark:block dark:group-data-[collapsible=icon]:hidden"
                />
              </NavLink>
            </SidebarMenuItem>
          </SidebarMenu>
        </Fade>
      </SidebarHeader>

      <SidebarContent className="gap-0">
        <Fade delay={sectionDelay(1)}>
          <NavPrimary />
        </Fade>
        {labelledGroups.map((group, index) => (
          <Fade key={group.id} delay={sectionDelay(index + 2)}>
            <NavMain label={group.label} items={navItems(group.id).map(buildItem)} />
          </Fade>
        ))}
      </SidebarContent>

      <SidebarFooter className="mt-auto shrink-0 gap-0 bg-sidebar p-0">
        <Fade delay={sectionDelay(labelledGroups.length + 2)}>
          <NavSecondary items={secondary} />
        </Fade>
        <Fade delay={sectionDelay(labelledGroups.length + 3)}>
          <div className="border-t p-2">
            <NavStatus />
          </div>
        </Fade>
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
 * A section owns its whole subtree, so an agent's page keeps "Organization" lit.
 * "Conversations" additionally owns the chat hub (`/` and `/c/<id>`): an open
 * conversation has no sidebar entry of its own any more and would otherwise
 * leave the navigation showing nothing at all.
 */
function isActive(pathname: string, path: string): boolean {
  if (path === '/chats') {
    return pathname === '/chats' || pathname === '/' || pathname.startsWith('/c/');
  }
  return pathname === path || pathname.startsWith(path + '/');
}

/** The entry fields a route contributes to the main and the secondary block alike. */
function routeEntry(meta: RouteMeta, pathname: string) {
  return {
    title: meta.navLabel ?? meta.label,
    url: meta.redirect ?? meta.path,
    icon: meta.icon ?? FeatherIcon,
    isActive: isActive(pathname, meta.path),
  };
}

/** The counts are live values, so their digits roll into place instead of jumping. */
function RollingCount({ value }: { value: number }) {
  return <SlidingNumber number={value} thousandSeparator="," />;
}
