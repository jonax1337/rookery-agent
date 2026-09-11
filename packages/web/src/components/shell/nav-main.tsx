import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { ChevronRightIcon, type LucideIcon } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';

export interface NavSubItem {
  title: string;
  url: string;
  isActive?: boolean;
}

export interface NavMainItem {
  title: string;
  url: string;
  icon: LucideIcon;
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
  /** Sections with sub-entries become the block's collapsible row. */
  items?: NavSubItem[];
}

/**
 * One labelled block of the navigation (sidebar-16's `nav-main`).
 *
 * An entry without `items` is a plain link; with them it grows the block's
 * chevron action and a `SidebarMenuSub`, which stays open while the section
 * is the active one. Badge and chevron would sit on the same absolute spot,
 * so no entry ever carries both - sections count nothing, leaves have no
 * children.
 */
export function NavMain({ label, items }: { label: string; items: NavMainItem[] }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) => (
          <Collapsible key={item.title} asChild defaultOpen={item.isActive}>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip={item.badgeLabel ? item.title + ' — ' + item.badgeLabel : item.title}
                isActive={item.isActive}
              >
                <NavLink to={item.url}>
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
              {item.items?.length ? (
                <>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuAction className="data-[state=open]:rotate-90">
                      <ChevronRightIcon />
                      {/* The block's bare "Toggle" would read as several
                          identical buttons in a row; the section name is right
                          here in the same iteration. */}
                      <span className="sr-only">{item.title} auf- oder zuklappen</span>
                    </SidebarMenuAction>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub>
                      {item.items.map((subItem) => (
                        <SidebarMenuSubItem key={subItem.title}>
                          <SidebarMenuSubButton asChild isActive={subItem.isActive}>
                            <NavLink to={subItem.url}>
                              <span>{subItem.title}</span>
                            </NavLink>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </>
              ) : null}
            </SidebarMenuItem>
          </Collapsible>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
