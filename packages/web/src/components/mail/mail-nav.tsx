import type { ReactNode } from 'react';
import { BotIcon, InboxIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SendIcon, UserRoundIcon } from 'lucide-react';

import type { Agent } from '@/lib/types';
import { cn } from '@/lib/utils';
import { AssistantAvatar } from '@/components/shell/assistant-avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The left rail: whose mail is open, and which of their two folders.
 *
 * Laid out the way shadcn's mail example lays out its sidebar - the open
 * account on top, then a folder group, then the switcher - with one difference
 * that is ours: the "account" here is not one of the user's own addresses but
 * any mailbox in the company. Every mailbox but "You" is read-only; the user
 * can look in on anyone's traffic, but the company writes mail to each other,
 * not through the user's own compose form. `InboxPage` is the one place that
 * decides what that means for the panes beside this rail.
 *
 * Collapsing is a plain width swap rather than a `ResizablePanel`, because the
 * rail sits outside the panel group: the two panes a person actually drags are
 * the list and the reading pane.
 */

interface NavRowProps {
  icon: ReactNode;
  label: string;
  /** An agent's job title, on a second line. Folders and people have none. */
  sub?: string | undefined;
  /** Right-aligned count. Hidden when zero - an empty inbox says nothing. */
  badge?: number | null;
  active: boolean;
  collapsed: boolean;
  onClick(): void;
}

function NavRow({ icon, label, sub, badge, active, collapsed, onClick }: NavRowProps) {
  const count = badge != null && badge > 0 ? badge : null;

  const row = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      // Collapsed there is no text in the button, and a tooltip describes a
      // control without naming it - so the name has to be said outright, or
      // the rail reads as ten unlabelled buttons.
      aria-label={collapsed ? (sub ? label + ', ' + sub : label) : undefined}
      className={cn(
        buttonVariants({ variant: active ? 'default' : 'ghost', size: 'sm' }),
        'w-full',
        collapsed ? 'justify-center px-0' : 'justify-start gap-2',
        // `size-sm` is a fixed `h-8`, which would clip the second line.
        !collapsed && sub && 'h-auto py-1.5',
      )}
    >
      {icon}
      {!collapsed && (
        <span className="flex min-w-0 flex-1 flex-col items-start">
          <span className="w-full truncate text-left font-normal">{label}</span>
          {sub && (
            <span
              className={cn(
                'w-full truncate text-left text-xs font-normal',
                active ? 'text-primary-foreground/70' : 'text-muted-foreground',
              )}
            >
              {sub}
            </span>
          )}
        </span>
      )}
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
        {/* Collapsed, the tooltip is the only place the title can still appear. */}
        {sub && <span className="text-background/60">{sub}</span>}
        {count !== null && <span className="text-background/60">{count}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

interface MailNavProps {
  agents: Agent[];
  assistantName: string;
  mailboxId: string;
  /** The open mailbox's display name, for the header. */
  mailboxLabel: string;
  /** Its owner's job title, when the owner is an agent. */
  mailboxRole: string | null;
  onSelect(mailboxId: string): void;
  box: 'inbox' | 'outbox';
  onBoxChange(box: 'inbox' | 'outbox'): void;
  /** Unread in the open mailbox's inbox, or `null` when it is not known. */
  unread: number | null;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
}

export function MailNav({
  agents,
  assistantName,
  mailboxId,
  mailboxLabel,
  mailboxRole,
  onSelect,
  box,
  onBoxChange,
  unread,
  collapsed,
  onCollapsedChange,
}: MailNavProps) {
  const mailboxIcon =
    mailboxId === 'user' ? (
      <UserRoundIcon />
    ) : mailboxId === 'assistant' ? (
      <AssistantAvatar label={assistantName} className="size-5 rounded-md" />
    ) : (
      <BotIcon />
    );

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
        <div className={cn('flex h-[52px] shrink-0 items-center gap-2', collapsed ? 'justify-center' : 'px-2')}>
          {!collapsed && (
            <>
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted [&_svg]:size-4">
                {mailboxIcon}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{mailboxLabel}</span>
                {mailboxRole && (
                  <span className="truncate text-xs text-muted-foreground">{mailboxRole}</span>
                )}
              </span>
            </>
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

        <div className="flex flex-col gap-1 p-2">
          <NavRow
            icon={<InboxIcon />}
            label="Inbox"
            badge={unread}
            active={box === 'inbox'}
            collapsed={collapsed}
            onClick={() => onBoxChange('inbox')}
          />
          <NavRow
            icon={<SendIcon />}
            label="Outbox"
            active={box === 'outbox'}
            collapsed={collapsed}
            onClick={() => onBoxChange('outbox')}
          />
        </div>

        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {!collapsed && (
              <div className="mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Mailboxes
              </div>
            )}
            <NavRow
              icon={<UserRoundIcon />}
              label="You"
              active={mailboxId === 'user'}
              collapsed={collapsed}
              onClick={() => onSelect('user')}
            />
            <NavRow
              icon={<AssistantAvatar label={assistantName} className="size-4 rounded-[4px]" />}
              label={assistantName}
              active={mailboxId === 'assistant'}
              collapsed={collapsed}
              onClick={() => onSelect('assistant')}
            />

            {agents.length > 0 &&
              (collapsed ? (
                <Separator className="my-1" />
              ) : (
                <div className="mt-3 mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Agents
                </div>
              ))}

            {agents.map((agent) => (
              <NavRow
                key={agent.id}
                icon={<BotIcon />}
                label={agent.name}
                // Six names in a rail say nothing about who does what; the
                // title is the one fact that tells them apart.
                sub={agent.title || undefined}
                active={mailboxId === agent.id}
                collapsed={collapsed}
                onClick={() => onSelect(agent.id)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
