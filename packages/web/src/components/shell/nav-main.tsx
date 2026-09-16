import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import type { IconComponent } from "@/components/icons";

export interface NavMainItem {
  title: string;
  url: string;
  icon: IconComponent;
  isActive?: boolean;
  /**
   * A count worth interrupting for - running tasks, open assignments. Only
   * ever something the app actually holds; `undefined` renders nothing. It is
   * a node rather than a number because a count over a capped list has to be
   * able to say "500+" instead of pretending to be exact.
   */
  badge?: ReactNode;
  /**
   * What the badge counts, as a whole sentence, when the bare number would be
   * read as more than it is. Screen readers get it beside the number, and the
   * collapsed rail's tooltip carries it too - the badge itself is
   * `pointer-events-none`, so it can never hold a tooltip of its own.
   */
  badgeLabel?: string;
}

/**
 * One labelled block of the navigation (sidebar-16's `nav-main`).
 *
 * Every entry is a plain link. Sections with sub-pages - Organization,
 * Memory - do not open here any more: their tabs live on the page itself
 * (`OrgLayout`, `MemoryLayout`), so the rail carries one door per section and
 * nothing to expand.
 */
export function NavMain({ label, items }: { label: string; items: NavMainItem[] }) {
  const { setOpenMobile } = useSidebar();
  return (
    // One labelled navigation block counts as one section: it fades in as a
    // whole on mount, never row by row.
    <Fade>
      <SidebarGroup className="py-1">
        <SidebarGroupLabel className="h-6">{label}</SidebarGroupLabel>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                tooltip={item.badgeLabel ? item.title + ' — ' + item.badgeLabel : item.title}
                isActive={item.isActive}
              >
                <NavLink to={item.url} onClick={() => setOpenMobile(false)}>
                  <item.icon />
                  <span>{item.title}</span>
                </NavLink>
              </SidebarMenuButton>
              {item.badge !== undefined && item.badge !== null ? (
                <SidebarMenuBadge>
                  {item.badge}
                  {item.badgeLabel ? <span className="sr-only"> {item.badgeLabel}</span> : null}
                </SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </Fade>
  );
}
