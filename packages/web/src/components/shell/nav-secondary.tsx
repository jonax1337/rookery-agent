import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { NavLink } from 'react-router';
import type { LucideIcon } from 'lucide-react';
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';

export interface NavSecondaryItem {
  title: string;
  icon: LucideIcon;
  /** A destination, or nothing when the entry only runs `onClick`. */
  url?: string;
  onClick?: () => void;
  isActive?: boolean;
  /** The shortcut hint beside "Search"; anything else fits here too. */
  badge?: ReactNode;
}

/**
 * The small block in the rail's footer (sidebar-16's `nav-secondary`).
 *
 * "Search" has no URL: it opens the command palette the shell owns, which is
 * why an entry here may be a button instead of a link.
 */
export function NavSecondary({
  items,
  ...props
}: { items: NavSecondaryItem[] } & ComponentPropsWithoutRef<typeof SidebarGroup>) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup {...props}>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.title}>
              {item.url ? (
                <SidebarMenuButton asChild tooltip={item.title} isActive={item.isActive}>
                  <NavLink to={item.url} onClick={() => setOpenMobile(false)}>
                    <item.icon />
                    <span>{item.title}</span>
                  </NavLink>
                </SidebarMenuButton>
              ) : (
                <SidebarMenuButton tooltip={item.title} onClick={item.onClick}>
                  <item.icon />
                  <span>{item.title}</span>
                </SidebarMenuButton>
              )}
              {item.badge !== undefined && <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
