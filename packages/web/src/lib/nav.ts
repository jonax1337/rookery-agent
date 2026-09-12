import { useMemo } from 'react';
import { useLocation } from 'react-router';
import {
  AudioLinesIcon,
  BrainIcon,
  Building2Icon,
  CalendarClockIcon,
  LayoutDashboardIcon,
  ListTodoIcon,
  MessagesSquareIcon,
  RadioTowerIcon,
  SendIcon,
  Settings2Icon,
  SparklesIcon,
  WrenchIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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
  { id: 'work', label: 'Arbeiten' },
  { id: 'operations', label: 'Betrieb' },
  { id: 'knowledge', label: 'Firma & Wissen' },
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
  icon?: LucideIcon;
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
  { path: '/dashboard', label: 'Übersicht', icon: LayoutDashboardIcon, group: 'work' },
  { path: '/chats', label: 'Gespräche', icon: MessagesSquareIcon, group: 'work' },
  // The chat hub itself. It sits under Gespräche in the breadcrumb but is not
  // a sidebar entry - "Neues Gespräch" is a button, not a destination.
  { path: '/', label: 'Chat', parent: '/chats', icon: MessagesSquareIcon, hidden: true },
  { path: '/c/:sessionId', label: 'Gespräch', parent: '/chats', icon: MessagesSquareIcon, hidden: true },
  // No `group`, so no sidebar row: the primary action already carries a voice
  // button beside "Neues Gespräch", and one destination does not need two
  // permanent doors. It keeps its label and icon, so the breadcrumb still names
  // it and the command palette still finds it.
  { path: '/voice', label: 'Sprechen', icon: AudioLinesIcon },

  /* -------------------------------- betrieb ------------------------------- */
  { path: '/tasks', label: 'Aufgaben', icon: ListTodoIcon, group: 'operations' },
  { path: '/tasks/new', label: 'Aufgabe anlegen', parent: '/tasks', hidden: true },
  { path: '/tasks/:id', label: 'Aufgabe', parent: '/tasks', hidden: true },
  { path: '/tasks/:id/edit', label: 'Aufgabe bearbeiten', parent: '/tasks', hidden: true },

  { path: '/assignments', label: 'Aufträge', icon: SendIcon, group: 'operations' },
  { path: '/assignments/:id', label: 'Auftrag', parent: '/assignments', hidden: true },

  { path: '/cron', label: 'Zeitpläne', icon: CalendarClockIcon, group: 'operations' },
  { path: '/cron/new', label: 'Zeitplan anlegen', parent: '/cron', hidden: true },
  { path: '/cron/:id', label: 'Zeitplan', parent: '/cron', hidden: true },
  { path: '/cron/:id/edit', label: 'Zeitplan bearbeiten', parent: '/cron', hidden: true },

  { path: '/gateways', label: 'Gateway', icon: RadioTowerIcon, group: 'operations' },
  { path: '/gateways/:id', label: 'Gateway', parent: '/gateways', hidden: true },

  /* --------------------------- firma & wissen ----------------------------- */
  // `/org` is a redirect, but it is the honest parent of the three tables and
  // the thing the sidebar calls "Firma".
  {
    path: '/org',
    label: 'Firma',
    icon: Building2Icon,
    group: 'knowledge',
    redirect: '/org/agents',
    children: ['/org/agents', '/org/teams', '/org/projects'],
  },
  { path: '/org/agents', label: 'Agenten', parent: '/org' },
  { path: '/org/agents/new', label: 'Agent einstellen', parent: '/org/agents', hidden: true },
  { path: '/org/agents/:id', label: 'Agent', parent: '/org/agents', hidden: true },
  { path: '/org/agents/:id/edit', label: 'Agent bearbeiten', parent: '/org/agents', hidden: true },
  { path: '/org/teams', label: 'Teams', parent: '/org' },
  { path: '/org/teams/new', label: 'Team anlegen', parent: '/org/teams', hidden: true },
  { path: '/org/teams/:id/edit', label: 'Team bearbeiten', parent: '/org/teams', hidden: true },
  { path: '/org/projects', label: 'Projekte', parent: '/org' },
  { path: '/org/projects/new', label: 'Projekt anlegen', parent: '/org/projects', hidden: true },
  { path: '/org/projects/:id/edit', label: 'Projekt bearbeiten', parent: '/org/projects', hidden: true },

  // `/memory` is both the section and its first tab, so the section name and
  // the page name differ - hence `navLabel`, and `children` listing itself.
  {
    path: '/memory',
    label: 'Erinnerungen',
    navLabel: 'Gedächtnis',
    icon: BrainIcon,
    group: 'knowledge',
    children: ['/memory', '/memory/graph', '/memory/sleep'],
  },
  { path: '/memory/graph', label: 'Netz', parent: '/memory' },
  { path: '/memory/sleep', label: 'Nächte', parent: '/memory' },

  { path: '/tools', label: 'Werkzeuge', icon: WrenchIcon, group: 'knowledge' },
  { path: '/tools/new', label: 'Eigener Server', parent: '/tools', hidden: true },
  { path: '/tools/:id', label: 'Werkzeug', parent: '/tools', hidden: true },

  { path: '/skills', label: 'Skills', icon: SparklesIcon, group: 'knowledge' },
  { path: '/skills/new', label: 'Skill anlegen', parent: '/skills', hidden: true },
  { path: '/skills/import', label: 'Importieren', parent: '/skills', hidden: true },
  { path: '/skills/:name', label: 'Skill', parent: '/skills', hidden: true },
  { path: '/skills/:name/edit', label: 'Skill bearbeiten', parent: '/skills', hidden: true },

  /* ------------------------------- unten ---------------------------------- */
  {
    path: '/settings',
    label: 'Einstellungen',
    icon: Settings2Icon,
    group: 'secondary',
    redirect: '/settings/identity',
  },
  { path: '/settings/:section', label: 'Einstellungen', parent: '/settings', hidden: true },
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
