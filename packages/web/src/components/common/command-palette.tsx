import * as React from 'react';
import { useNavigate } from 'react-router';
import {
  Building2Icon,
  FolderIcon,
  ListTodoIcon,
  MessageSquareIcon,
  SendIcon,
  UsersIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { navigableRoutes } from '@/lib/nav';
import { relativeTime } from '@/lib/format';
import type {
  Agent,
  AssignmentView,
  Project,
  Session,
  Task,
  Team,
} from '@/lib/types';

/**
 * Strg/Cmd+K, and everything in the company is one keystroke away.
 *
 * The app has grown past the point where the sidebar can list what there is:
 * conversations, agents, teams, projects, assignments, tasks and two dozen
 * pages. Rather than another nav level, one search field over all of them.
 *
 * Every source arrives as a prop. The palette owns no fetching and no socket
 * of its own - `AppShell` mounts it with the state it already holds, which is
 * also why an absent list simply means an absent group rather than an error.
 */

/** A verb rather than a destination: "Neues Gespräch", "Agent einstellen". */
export interface CommandAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Extra words that should find this entry, e.g. an English synonym. */
  keywords?: string[];
  /** Printed right-aligned, e.g. "⌘N". */
  shortcut?: string;
  /** A route to go to. Ignored when `run` is given. */
  to?: string;
  run?: () => void;
}

export interface CommandPaletteProps {
  /** Controlled from the header's search button; omit for keyboard-only. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  actions?: readonly CommandAction[];
  sessions?: readonly Session[];
  agents?: readonly Agent[];
  teams?: readonly Team[];
  projects?: readonly Project[];
  assignments?: readonly AssignmentView[];
  tasks?: readonly Task[];
}

/** Long lists make the palette a scroll exercise; the search field is faster. */
const PER_GROUP = 8;

export function CommandPalette({
  open: controlledOpen,
  onOpenChange,
  actions = [],
  sessions = [],
  agents = [],
  teams = [],
  projects = [],
  assignments = [],
  tasks = [],
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const setOpen = React.useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  // Strg/Cmd+K anywhere, including inside the composer: the shortcut is
  // universal enough that swallowing it in text fields would surprise more
  // people than it helps.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setOpen(!open);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setOpen]);

  const go = React.useCallback(
    (to: string) => {
      setOpen(false);
      void navigate(to);
    },
    [navigate, setOpen],
  );

  const runAction = React.useCallback(
    (action: CommandAction) => {
      setOpen(false);
      if (action.run) action.run();
      else if (action.to) void navigate(action.to);
    },
    [navigate, setOpen],
  );

  // Newest first, because "the thing I just worked on" is the overwhelmingly
  // common target; the search field handles everything older.
  const recentSessions = React.useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, query.trim() ? undefined : PER_GROUP),
    [sessions, query],
  );
  const recentTasks = React.useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, query.trim() ? undefined : PER_GROUP),
    [tasks, query],
  );
  const liveAssignments = React.useMemo(
    () => assignments.slice(0, query.trim() ? undefined : PER_GROUP),
    [assignments, query],
  );

  const pages = React.useMemo(() => navigableRoutes(), []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      showCloseButton
      className="[&_[data-slot=command-input-wrapper]]:pr-10"
      description="Search loaded conversations, agents, tasks, and pages"
    >
      <Command>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search loaded items…" />
        <CommandList className="max-h-[60svh]">
          <CommandEmpty>Nothing found.</CommandEmpty>

          {actions.length > 0 && (
            <CommandGroup heading="Actions">
              {actions.map((action) => (
                <CommandItem
                  key={action.id}
                  value={'aktion ' + action.label + ' ' + (action.keywords?.join(' ') ?? '') + ' ' + action.id}
                  onSelect={() => runAction(action)}
                >
                  {action.icon && <action.icon />}
                  <span>{action.label}</span>
                  {action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {recentSessions.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Conversations">
                {recentSessions.map((session) => (
                  <CommandItem
                    key={session.id}
                    value={'gespraech ' + session.title + ' ' + session.id}
                    onSelect={() => go('/c/' + session.id)}
                  >
                    <MessageSquareIcon />
                    <span className="truncate">{session.title || 'Untitled'}</span>
                    <CommandShortcut>{relativeTime(session.updatedAt)}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {agents.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Agents">
                {agents.map((agent) => (
                  <CommandItem
                    key={agent.id}
                    value={'agent ' + agent.name + ' ' + agent.slug + ' ' + agent.title + ' ' + agent.id}
                    onSelect={() => go('/org/agents/' + agent.id)}
                  >
                    <Building2Icon />
                    <span className="truncate">{agent.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{agent.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {teams.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Teams">
                {teams.map((team) => (
                  <CommandItem
                    key={team.id}
                    value={'team ' + team.name + ' ' + (team.purpose ?? '') + ' ' + team.id}
                    onSelect={() => go('/org/teams')}
                  >
                    <UsersIcon />
                    <span className="truncate">{team.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {projects.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Projects">
                {projects.map((project) => (
                  <CommandItem
                    key={project.id}
                    value={'projekt ' + project.name + ' ' + (project.description ?? '') + ' ' + project.id}
                    onSelect={() => go('/org/projects')}
                  >
                    <FolderIcon />
                    <span className="truncate">{project.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {liveAssignments.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Assignments">
                {liveAssignments.map((assignment) => (
                  <CommandItem
                    key={assignment.id}
                    value={'auftrag ' + assignment.agentName + ' ' + assignment.task + ' ' + assignment.id}
                    onSelect={() => go('/assignments/' + assignment.id)}
                  >
                    <SendIcon />
                    <span className="truncate">{assignment.task}</span>
                    <CommandShortcut>{assignment.agentName}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          {recentTasks.length > 0 && (
            <>
              <CommandSeparator />
              <CommandGroup heading="Tasks">
                {recentTasks.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={'aufgabe ' + task.title + ' ' + task.description + ' ' + task.id}
                    onSelect={() => go('/tasks/' + task.id)}
                  >
                    <ListTodoIcon />
                    <span className="truncate">{task.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          )}

          <CommandSeparator />
          <CommandGroup heading="Pages">
            {pages.map((page) => (
              <CommandItem
                key={page.path}
                value={'seite ' + page.label + ' ' + (page.navLabel ?? '') + ' ' + page.path}
                onSelect={() => go(page.redirect ?? page.path)}
              >
                {page.icon && <page.icon />}
                <span>{page.navLabel ?? page.label}</span>
                <CommandShortcut className="font-mono tracking-normal">
                  {page.path}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
