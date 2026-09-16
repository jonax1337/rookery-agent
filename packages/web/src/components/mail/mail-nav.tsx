import { useState, type ReactNode } from 'react';

import {
  ArchiveIcon,
  BotIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  DownloadIcon as InboxIcon,
  FileStackIcon,
  MailCheckIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SendIcon,
  UserIcon as UserRoundIcon,
} from "@/components/icons";

import type { Agent, MailFolder } from '@/lib/types';
import { cn } from '@/lib/utils';
import { AssistantAvatar } from '@/components/shell/assistant-avatar';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The left rail: whose mail is open (the switcher bar on top), and the fixed
 * folder structure below it - the same five folders for every mailbox.
 *
 * The switcher follows shadcn's account-switcher shape: the open mailbox as a
 * bar, a popover with search to change it. The folders are not navigation
 * someone maintains but routing made visible - what a thread *is* (chat,
 * assignment, report) decides where it lands, so an assignment stays
 * traceable no matter how long its reply chain grows. Every mailbox but "You"
 * is read-only; the user can look in on anyone's traffic, but the company
 * writes mail to each other, not through the user's own compose form.
 * `InboxPage` is the one place that decides what that means for the panes
 * beside this rail.
 *
 * Collapsing is a plain width swap rather than a `ResizablePanel`, because the
 * rail sits outside the panel group: the two panes a person actually drags are
 * the list and the reading pane.
 */

/** The fixed folders, in rail order. `outbox` is routed by sender, not kind. */
const FOLDERS: { id: MailFolder; label: string; icon: ReactNode }[] = [
  { id: 'inbox', label: 'Inbox', icon: <InboxIcon /> },
  { id: 'tasks', label: 'Tasks', icon: <FileStackIcon /> },
  { id: 'reports', label: 'Reports', icon: <MailCheckIcon /> },
  { id: 'outbox', label: 'Outbox', icon: <SendIcon /> },
  { id: 'archiv', label: 'Archive', icon: <ArchiveIcon /> },
];

interface NavRowProps {
  icon: ReactNode;
  label: string;
  /** Right-aligned count. Hidden when zero - an empty inbox says nothing. */
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
      // control without naming it - so the name has to be said outright, or
      // the rail reads as five unlabelled buttons.
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

interface MailboxOptionProps {
  icon: ReactNode;
  label: string;
  /** An agent's job title, the second line that tells six names apart. */
  sub?: string | undefined;
  active: boolean;
  onSelect(): void;
}

function MailboxOption({ icon, label, sub, active, onSelect }: MailboxOptionProps) {
  return (
    <CommandItem value={label + ' ' + (sub ?? '')} onSelect={onSelect} className="gap-2">
      <span className="grid size-5 shrink-0 place-items-center [&_svg]:size-4">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="w-full truncate">{label}</span>
        {sub && <span className="w-full truncate text-xs text-muted-foreground">{sub}</span>}
      </span>
      {active && <CheckIcon className="size-4 shrink-0" />}
    </CommandItem>
  );
}

interface MailNavProps {
  agents: Agent[];
  assistantName: string;
  mailboxId: string;
  /** The open mailbox's display name, for the switcher bar. */
  mailboxLabel: string;
  /** Its owner's job title, when the owner is an agent. */
  mailboxRole: string | null;
  onSelect(mailboxId: string): void;
  folder: MailFolder;
  onFolderChange(folder: MailFolder): void;
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
  folder,
  onFolderChange,
  unread,
  collapsed,
  onCollapsedChange,
}: MailNavProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const mailboxIcon =
    mailboxId === 'user' ? (
      <UserRoundIcon />
    ) : mailboxId === 'assistant' ? (
      <AssistantAvatar label={assistantName} className="size-5 rounded-md" />
    ) : (
      <BotIcon />
    );

  const collapseButton = (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      onClick={() => onCollapsedChange(!collapsed)}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
    </Button>
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
        <div
          className={cn(
            'flex shrink-0 items-center gap-1 py-2',
            collapsed ? 'w-[52px] flex-col' : 'h-[52px] px-2',
          )}
        >
          {/* The popover owns its trigger, so it wraps the whole header; the
              tooltip wraps the trigger inside it. Collapsed, the tooltip is
              the only label the bar has. */}
          <Popover open={switcherOpen} onOpenChange={setSwitcherOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size={collapsed ? 'icon-sm' : 'sm'}
                    aria-haspopup="listbox"
                    aria-expanded={switcherOpen}
                    className={cn('shrink-0', collapsed ? 'size-8 p-0' : 'min-w-0 flex-1 justify-start gap-2 px-2')}
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-muted [&_svg]:size-3.5">
                      {mailboxIcon}
                    </span>
                    {!collapsed && (
                      <span className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="w-full truncate text-sm font-medium">{mailboxLabel}</span>
                        {mailboxRole && (
                          <span className="w-full truncate text-xs font-normal text-muted-foreground">{mailboxRole}</span>
                        )}
                      </span>
                    )}
                    {!collapsed && <ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />}
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              {collapsed && <TooltipContent side="right">Switch mailbox</TooltipContent>}
            </Tooltip>
            <PopoverContent
              // A fixed width: the collapsed trigger is 32px, and sizing the
              // popover after it would crush the very list it opens for.
              side={collapsed ? 'right' : 'bottom'}
              align={collapsed ? 'end' : 'start'}
              className="w-64 p-0"
            >
              <Command>
                <CommandInput placeholder="Search mailboxes…" />
                <CommandList>
                  <CommandEmpty>No mailbox found.</CommandEmpty>
                  <CommandGroup heading="Your mailbox">
                    <MailboxOption
                      icon={<UserRoundIcon />}
                      label="You"
                      active={mailboxId === 'user'}
                      onSelect={() => {
                        setSwitcherOpen(false);
                        onSelect('user');
                      }}
                    />
                  </CommandGroup>
                  <CommandGroup heading="Assistant">
                    <MailboxOption
                      icon={<AssistantAvatar label={assistantName} className="size-5 rounded-[6px]" />}
                      label={assistantName}
                      active={mailboxId === 'assistant'}
                      onSelect={() => {
                        setSwitcherOpen(false);
                        onSelect('assistant');
                      }}
                    />
                  </CommandGroup>
                  {agents.length > 0 && (
                    <CommandGroup heading="Agents">
                      {agents.map((agent) => (
                        <MailboxOption
                          key={agent.id}
                          icon={<BotIcon />}
                          label={agent.name}
                          sub={agent.title || undefined}
                          active={mailboxId === agent.id}
                          onSelect={() => {
                            setSwitcherOpen(false);
                            onSelect(agent.id);
                          }}
                        />
                      ))}
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {collapseButton}
        </div>

        <Separator />

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-1 p-2">
            {FOLDERS.map(({ id, label, icon }) => (
              <NavRow
                key={id}
                icon={icon}
                label={label}
                badge={id === 'inbox' ? unread : null}
                active={folder === id}
                collapsed={collapsed}
                onClick={() => onFolderChange(id)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}
