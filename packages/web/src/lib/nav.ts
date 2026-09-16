import { useMemo } from 'react';
import { useLocation } from 'react-router';

import {
  BrainIcon,
  BriefcaseBusinessIcon as Building2Icon,
  ConnectIcon,
} from "@/components/icons";

import {
  AssignmentsIcon,
  ConversationsIcon,
  GatewaysIcon,
  InboxIcon,
  OverviewIcon,
  SchedulesIcon,
  SettingsIcon,
  SkillsIcon,
  TasksIcon,
  VoiceIcon,
} from '@/components/shell/nav-icons';
import type { IconComponent } from "@/components/icons";

/**
 * The one place that knows what a route is called.
 *
 * Breadcrumbs, the sidebar and the command palette's "Seiten" group all read
 * this table, which is the point: the labels used to live in an if-chain in
 * `App.tsx` *and* in an array in the sidebar, and the two had already drifted
 * apart. Routes stay English, labels stay German.
 *
 * The table and the route table in `App.tsx` are congruent: every pattern
 * below is a route, and every route is a pattern below. The one exception is
 * the catch-all `*`, which has no entry on purpose - `NotFoundPage` names
 * itself, and a pattern that matches everything would win every lookup here.
 * A missing entry is a silently unnamed breadcrumb, so when a route is added
 * in `App.tsx`, it is added here in the same change.
 */

/** Which block of the sidebar an entry belongs to. */
export type NavGroup = 'work' | 'operations' | 'knowledge' | 'secondary';

export interface NavGroupMeta {
  id: NavGroup;
  /** `null` renders without a `SidebarGroupLabel` - the `mt-auto` footer block. */
  label: string | null;
}

export const NAV_GROUPS: NavGroupMeta[] = [
  { id: 'work', label: 'Work' },
  { id: 'operations', label: 'Operations' },
  { id: 'knowledge', label: 'Organization & Knowledge' },
  { id: 'secondary', label: null },
];

export interface RouteMeta {
  /** Route pattern the way react-router writes it: `/org/agents/:id`. */
  path: string;
  /** The page's own name: the last breadcrumb and the sidebar entry. */
  label: string;
  /**
   * What to call it when it stands as a breadcrumb ancestor or a sidebar
   * section head, where the page's own name would read wrong - `/memory` is
   * the "Erinnerungen" page but the "Gedächtnis" section.
   */
  navLabel?: string;
  /** The route one level up, as a pattern. Drives the breadcrumb chain. */
  parent?: string;
  icon?: IconComponent;
  /** Set only on the entries that appear in the sidebar themselves. */
  group?: NavGroup;
  /** Sub-entries of a sidebar section, in order, as patterns. */
  children?: string[];
  /** Where a section head navigates to when the route itself only redirects. */
  redirect?: string;
  /**
   * Kept out of the command palette's "Seiten" list. True for everything that
   * needs a parameter (`/tasks/:id`) and for the create forms, which are
   * reached by the button on the list they belong to rather than by name.
   */
  hidden?: boolean;
}

/** In sidebar order within each group; the palette lists them the same way. */
export const ROUTE_META: RouteMeta[] = [
  /* ------------------------------- arbeiten ------------------------------- */
  { path: '/dashboard', label: 'Overview', icon: OverviewIcon, group: 'work' },
  { path: '/chats', label: 'Conversations', icon: ConversationsIcon, group: 'work' },
  // The chat hub itself. It sits under Gespräche in the breadcrumb but is not
  // a sidebar entry - "Neues Gespräch" is a button, not a destination.
  { path: '/', label: 'Chat', parent: '/chats', icon: ConversationsIcon, hidden: true },
  { path: '/c/:sessionId', label: 'Conversation', parent: '/chats', icon: ConversationsIcon, hidden: true },
  // No `group`, so no sidebar row: the primary action already carries a voice
  // button beside "Neues Gespräch", and one destination does not need two
  // permanent doors. It keeps its label and icon, so the breadcrumb still names
  // it and the command palette still finds it.
  { path: '/voice', label: 'Voice', icon: VoiceIcon },
  // A personal mailbox, not an org-management screen - the assistant itself
  // writes into it (a night's summary, a schedule reporting back), not only
  // agents. It used to sit under Organization; a top-level entry beside
  // Chat/Tasks says what it actually is. Same route both nav and the route
  // table in `App.tsx` use, so the two stay congruent.
  { path: '/inbox', label: 'Inbox', icon: InboxIcon, group: 'work' },

  /* -------------------------------- betrieb ------------------------------- */
  { path: '/tasks', label: 'Tasks', icon: TasksIcon, group: 'operations' },
  { path: '/tasks/new', label: 'Create task', parent: '/tasks', hidden: true },
  { path: '/tasks/:id', label: 'Task', parent: '/tasks', hidden: true },
  { path: '/tasks/:id/edit', label: 'Edit task', parent: '/tasks', hidden: true },

  { path: '/assignments', label: 'Assignments', icon: AssignmentsIcon, group: 'operations' },
  { path: '/assignments/:id', label: 'Assignment', parent: '/assignments', hidden: true },

  { path: '/cron', label: 'Schedules', icon: SchedulesIcon, group: 'operations' },
  { path: '/cron/new', label: 'Create schedule', parent: '/cron', hidden: true },
  { path: '/cron/:id', label: 'Schedule', parent: '/cron', hidden: true },
  { path: '/cron/:id/edit', label: 'Edit schedule', parent: '/cron', hidden: true },

  { path: '/gateways', label: 'Gateways', icon: GatewaysIcon, group: 'operations' },
  { path: '/gateways/:id', label: 'Gateway', parent: '/gateways', hidden: true },

  /* --------------------------- firma & wissen ----------------------------- */
  // Section links open their overview; each section has three child pages.
  {
    path: '/org',
    label: 'Overview',
    navLabel: 'Organization',
    icon: Building2Icon,
    group: 'knowledge',
    children: ['/org/agents', '/org/teams', '/org/projects'],
  },
  { path: '/org/agents', label: 'Agents', parent: '/org' },
  { path: '/org/agents/new', label: 'Create agent', parent: '/org/agents', hidden: true },
  { path: '/org/agents/:id', label: 'Agent', parent: '/org/agents', hidden: true },
  { path: '/org/agents/:id/edit', label: 'Edit agent', parent: '/org/agents', hidden: true },
  { path: '/org/teams', label: 'Teams', parent: '/org' },
  { path: '/org/teams/new', label: 'Create team', parent: '/org/teams', hidden: true },
  { path: '/org/teams/:id/edit', label: 'Edit team', parent: '/org/teams', hidden: true },
  { path: '/org/projects', label: 'Projects', parent: '/org' },
  { path: '/org/projects/new', label: 'Create project', parent: '/org/projects', hidden: true },
  { path: '/org/projects/:id/edit', label: 'Edit project', parent: '/org/projects', hidden: true },

  {
    path: '/memory',
    label: 'Overview',
    navLabel: 'Memory',
    icon: BrainIcon,
    group: 'knowledge',
    children: ['/memory/memories', '/memory/graph', '/memory/sleep'],
  },
  { path: '/memory/memories', label: 'Memories', parent: '/memory' },
  { path: '/memory/graph', label: 'Graph', parent: '/memory' },
  { path: '/memory/sleep', label: 'Nights', parent: '/memory' },

  // "MCP Tools" rather than "Tools": the page is the MCP catalogue (servers,
  // tools, transports), and the connect plug says that better than the wrench
  // - the wrench moved to Skills, where it always belonged.
  { path: '/tools', label: 'MCP Tools', icon: ConnectIcon, group: 'knowledge' },
  { path: '/tools/new', label: 'Custom server', parent: '/tools', hidden: true },
  { path: '/tools/:id', label: 'Tool', parent: '/tools', hidden: true },

  { path: '/skills', label: 'Skills', icon: SkillsIcon, group: 'knowledge' },
  { path: '/skills/new', label: 'Create skill', parent: '/skills', hidden: true },
  { path: '/skills/import', label: 'Import', parent: '/skills', hidden: true },
  { path: '/skills/:name', label: 'Skill', parent: '/skills', hidden: true },
  { path: '/skills/:name/edit', label: 'Edit skill', parent: '/skills', hidden: true },

  /* ------------------------------- unten ---------------------------------- */
  {
    path: '/settings',
    label: 'Settings',
    icon: SettingsIcon,
    group: 'secondary',
    redirect: '/settings/identity',
  },
  { path: '/settings/:section', label: 'Settings', parent: '/settings', hidden: true },
];

const BY_PATH = new Map(ROUTE_META.map((meta) => [meta.path, meta]));

/** The entry for an exact pattern, e.g. to resolve a `children` id. */
export function routeMeta(path: string): RouteMeta | undefined {
  return BY_PATH.get(path);
}

/** The sidebar entries of one group, in declaration order. */
export function navItems(group: NavGroup): RouteMeta[] {
  return ROUTE_META.filter((meta) => meta.group === group);
}

/** Everything a person could sensibly jump to - the palette's "Seiten" list. */
export function navigableRoutes(): RouteMeta[] {
  return ROUTE_META.filter((meta) => !meta.hidden && !meta.path.includes(':'));
}

export interface RouteMatch {
  meta: RouteMeta;
  params: Record<string, string>;
}

/**
 * Which entry a concrete pathname belongs to.
 *
 * Patterns are matched segment by segment and the most literal one wins, so
 * `/org/agents/new` finds its own entry rather than `/org/agents/:id`.
 */
export function matchRoute(pathname: string): RouteMatch | null {
  const parts = segments(pathname);
  let best: RouteMatch | null = null;
  let bestScore = -1;

  for (const meta of ROUTE_META) {
    const pattern = segments(meta.path);
    if (pattern.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let score = 0;
    let ok = true;
    for (let i = 0; i < pattern.length; i += 1) {
      const expected = pattern[i] as string;
      const actual = parts[i] as string;
      if (expected.startsWith(':')) params[expected.slice(1)] = decodeURIComponent(actual);
      else if (expected === actual) score += 1;
      else {
        ok = false;
        break;
      }
    }
    if (ok && score > bestScore) {
      best = { meta, params };
      bestScore = score;
    }
  }
  return best;
}

export interface Breadcrumb {
  label: string;
  /** Unset on the current page, which renders as `BreadcrumbPage`. */
  to?: string;
}

/**
 * The breadcrumb chain for a pathname, walked up through `parent`.
 *
 * Capped at three levels, the depth the header has room for; ancestors keep
 * the parameters of the matched route, so `/tasks/:id/edit` links back to the
 * task it is editing and not to a literal `:id`.
 *
 * `leaf` replaces the last label with something only the page knows - a
 * conversation title, an agent's name. Pages that need more than that pass
 * their own array to `usePageMeta`; this is the default, not a straitjacket.
 */
export function useBreadcrumbs(leaf?: string): Breadcrumb[] {
  const { pathname } = useLocation();
  return useMemo(() => breadcrumbsFor(pathname, leaf), [pathname, leaf]);
}

export function breadcrumbsFor(pathname: string, leaf?: string): Breadcrumb[] {
  const match = matchRoute(pathname);
  if (!match) return [];

  const chain: RouteMeta[] = [];
  let current: RouteMeta | undefined = match.meta;
  // `seen` guards against a typo in `parent` turning into an endless loop.
  const seen = new Set<string>();
  while (current && !seen.has(current.path)) {
    seen.add(current.path);
    chain.unshift(current);
    current = current.parent ? BY_PATH.get(current.parent) : undefined;
  }

  const trimmed = chain.slice(-3);
  return trimmed.map((meta, index) => {
    const last = index === trimmed.length - 1;
    const label = last ? (leaf ?? meta.label) : (meta.navLabel ?? meta.label);
    if (last) return { label };
    const to = resolvePath(meta.redirect ?? meta.path, match.params);
    return to ? { label, to } : { label };
  });
}

/** Puts the matched parameters back into an ancestor's pattern. */
function resolvePath(pattern: string, params: Record<string, string>): string | undefined {
  const parts = segments(pattern).map((part) =>
    part.startsWith(':') ? params[part.slice(1)] : part,
  );
  return parts.some((part) => part === undefined) ? undefined : '/' + parts.join('/');
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}
