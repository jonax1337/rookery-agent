import type { ReactNode } from 'react';

import {
  ArchiveIcon,
  BellIcon,
  BotIcon,
  CircleHelpIcon,
  ClipboardCheckIcon,
  ClockIcon,
  DownloadIcon as InboxIcon,
  LayoutGridIcon,
  MoonIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SettingsIcon,
  type IconComponent,
} from '@/components/icons';

import { NOTIFICATION_FILTERS, type NotificationFilter } from '@/lib/notifications';
import type { NotificationKind } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The left rail of the notifications page: one row per kind, and the archive.
 *
 * The kinds are not folders someone maintains but what Rookery says to the
 * user, sorted by who said it and why - a question waiting on an answer, a
 * schedule's result, a finished card, an agent's report. Each row carries its
 * unread count, so a question does not hide under a pile of schedule results.
 *
 * Collapsing is a plain width swap rather than a `ResizablePanel`, because the
 * rail sits outside the panel group: the two panes a person actually drags are
 * the list and the reading pane.
 */

/** The icon per kind, shared with the list and the reading pane. */
export const NOTIFICATION_KIND_ICON: Record<NotificationKind, IconComponent> = {
  question: CircleHelpIcon,
  schedule: ClockIcon,
  task: ClipboardCheckIcon,
  agent: BotIcon,
  watch: LayoutGridIcon,
  sleep: MoonIcon,
  system: SettingsIcon,
};

export function filterIcon(filter: NotificationFilter): IconComponent {
  return filter === 'all' ? InboxIcon : NOTIFICATION_KIND_ICON[filter];
}

interface NavRowProps {
  icon: ReactNode;
  label: string;
  /** Right-aligned count. Hidden when zero - an empty row says nothing. */
  badge?: number | null;
  active: boolean;
  collapsed: boolean;
  onClick(): void;
}

function NavRow({ icon, label, badge, active, collapsed, onClick }: NavRowProps) {
  const count = badge != null && badge > 0 ? badge : null;

  const row = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      // Collapsed there is no text in the button, and a tooltip describes a
      // control without naming it - so the name has to be said outright.
      aria-label={collapsed ? label : undefined}
      className={cn(
        buttonVariants({ variant: active ? 'default' : 'ghost', size: 'sm' }),
        'w-full',
        collapsed ? 'justify-center px-0' : 'justify-start gap-2',
      )}
    >
      {icon}
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left font-normal">{label}</span>}
      {!collapsed && count !== null && (
        <span
          className={cn(
            'shrink-0 text-xs tabular-nums',
            active ? 'text-primary-foreground' : 'text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
      {/* Collapsed, the count has nowhere to go but onto the icon. */}
      {collapsed && count !== null && !active && (
        <span aria-hidden="true" className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary" />
      )}
    </button>
  );

  if (!collapsed) return row;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative block">{row}</span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {count !== null && <span className="text-background/60">{count}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

interface NotificationNavProps {
  filter: NotificationFilter;
  archived: boolean;
  onSelect(filter: NotificationFilter, archived: boolean): void;
  /** Unread per kind, and in total under `all`, when known. */
  unread: Partial<Record<NotificationFilter, number>> | null;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
}

export function NotificationNav({
  filter,
  archived,
  onSelect,
  unread,
  collapsed,
  onCollapsedChange,
}: NotificationNavProps) {
  return (
    // `delayDuration={0}`: collapsed, the tooltip is the only label there is,
    // so it has to arrive the moment the pointer does.
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          'flex shrink-0 flex-col border-r transition-[width] duration-200 ease-in-out',
          collapsed ? 'w-[52px]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 py-2',
            collapsed ? 'w-[52px] flex-col' : 'h-[52px] px-2',
          )}
        >
          {!collapsed && (
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted [&_svg]:size-3.5">
                <BellIcon />
              </span>
              <span className="truncate text-sm font-medium">Notifications</span>
            </div>
          )}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => onCollapsedChange(!collapsed)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
          </Button>
        </div>

        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {NOTIFICATION_FILTERS.map(({ id, label }) => {
              const Icon = filterIcon(id);
              return (
                <NavRow
                  key={id}
                  icon={<Icon />}
                  label={label}
                  badge={unread?.[id] ?? null}
                  active={!archived && filter === id}
                  collapsed={collapsed}
                  onClick={() => onSelect(id, false)}
                />
              );
            })}
            <Separator className="my-1" />
            <NavRow
              icon={<ArchiveIcon />}
              label="Archive"
              active={archived}
              collapsed={collapsed}
              onClick={() => onSelect('all', true)}
            />
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
