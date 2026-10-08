import { ExternalLinkIcon } from '@/components/icons';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { GROUPS, SECTIONS, type SectionMeta } from './sections';

export function SettingsSidebar({
  activeSlug,
  onSelect,
}: {
  activeSlug: string;
  onSelect(entry: SectionMeta): void;
}) {
  return (
    <Sidebar collapsible="none" className="hidden w-60 border-r md:flex">
      <SidebarHeader className="px-4 pt-5 pb-1">
        <span className="text-base font-semibold">Settings</span>
      </SidebarHeader>
      <SidebarContent>
        {GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="py-1">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.sections.map((entry) => (
                  <SidebarMenuItem key={entry.slug}>
                    <SidebarMenuButton
                      isActive={entry.slug === activeSlug}
                      onClick={() => onSelect(entry)}
                    >
                      <entry.icon />
                      <span>{entry.label}</span>
                      {entry.href ? (
                        <ExternalLinkIcon className="ml-auto size-3.5 text-muted-foreground" />
                      ) : null}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}

/** The sidebar is hidden on a phone; this select takes its place. */
export function SectionSelect({
  activeSlug,
  onSelect,
}: {
  activeSlug: string;
  onSelect(entry: SectionMeta): void;
}) {
  const selectSlug = (slug: string): void => {
    const entry = SECTIONS.find((item) => item.slug === slug);
    if (entry) onSelect(entry);
  };

  return (
    <Select value={activeSlug} onValueChange={selectSlug}>
      <SelectTrigger className="w-full md:hidden" aria-label="Settings section"><SelectValue /></SelectTrigger>
      <SelectContent>
        {GROUPS.map((group) => (
          <SelectGroup key={group.label}>
            <SelectLabel>{group.label}</SelectLabel>
            {group.sections.map((entry) => (
              <SelectItem key={entry.slug} value={entry.slug}>{entry.label}</SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
