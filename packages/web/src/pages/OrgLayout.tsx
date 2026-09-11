import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { Building2Icon, ChevronDownIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { api } from '@/lib/api';
import { formatNumber } from '@/lib/stats';
import { shorten } from '@/lib/format';
import { useOrgState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards, StatCardsSkeleton, type StatCardProps } from '@/components/blocks/stat-cards';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { RunningBadge } from '@/components/common/status-badge';
import { collectErrors, useDraft, type FieldErrors } from '@/components/forms/form-kit';
import { reportFailure } from '@/lib/errors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

/**
 * The company, and the three tables it consists of.
 *
 * The old `/org` was one scrolling column of four Cards - a company header, a
 * team list, an agent list grouped by team, a project list - none of which
 * could be searched, sorted or filtered. The three lists are three routes now,
 * and this layout holds what they share: the headline numbers and the tab
 * strip. The numbers are deliberately common to all three tabs, so switching
 * from Agenten to Projekte does not make the page jump.
 *
 * The tabs are routes rather than local state: `/org/teams` is a place the
 * sidebar, the command palette and a bookmark can all point at. Radix' Tabs
 * still does the work - it gets the active value from the URL and every
 * trigger is a `NavLink` - which keeps the roving focus and the `aria-selected`
 * of the real thing instead of a row of hand-styled links.
 *
 * The company's own name and mission used to be edited by an inline form that
 * replaced the page header, with a `useEffect` that overwrote whatever was
 * typed the moment a socket broadcast came in. Two fields belong in a drawer,
 * and the draft belongs to `useDraft`, which a refetch cannot reset.
 */

interface OrgTab {
  value: string;
  to: string;
  label: string;
}

const TABS: readonly OrgTab[] = [
  { value: 'agents', to: '/org/agents', label: 'Agenten' },
  { value: 'teams', to: '/org/teams', label: 'Teams' },
  { value: 'projects', to: '/org/projects', label: 'Projekte' },
];

const organizationSchema = z.object({
  name: z.string().trim().min(1, 'Ein Name ist Pflicht'),
  mission: z.string(),
});

interface OrgDraft {
  name: string;
  mission: string;
}

export function OrgLayout() {
  const org = useOrgState();
  const { pathname } = useLocation();

  const organization = org.snapshot?.organization ?? null;
  const [editOpen, setEditOpen] = useState(false);

  const active = TABS.find((tab) => pathname.startsWith(tab.to))?.value ?? 'agents';
  const activeTab = TABS.find((tab) => tab.value === active) ?? TABS[0];
  /** Agenten is where /org lands, so it is this section's front page. */
  const isIndex = active === TABS[0]?.value;

  /* -------------------------------- header -------------------------------- */

  usePageMeta(
    {
      ...(organization ? { title: organization.name } : {}),
      breadcrumb: [
        { label: organization?.name ?? 'Firma', to: '/org/agents' },
        { label: activeTab?.label ?? 'Agenten' },
      ],
      // One primary button, then the overflow the detail pages already use.
      // Not a ButtonGroup: that welds a filled button to an outlined one, and
      // the seam reads as a mistake.
      actions: (
        <>
          <Button size="sm" asChild>
            <NavLink to="/org/agents/new">
              <PlusIcon data-icon="inline-start" />
              Agent einstellen
            </NavLink>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton tone="header" label="Weitere Aktionen für die Firma" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem asChild>
                <NavLink to="/org/teams/new">
                  <PlusIcon />
                  Team anlegen
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to="/org/projects/new">
                  <PlusIcon />
                  Projekt anlegen
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!organization} onSelect={() => setEditOpen(true)}>
                <PencilIcon />
                Firma bearbeiten
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ),
    },
    [organization?.id, organization?.name, activeTab?.label],
  );

  /* -------------------------------- numbers ------------------------------- */

  const counts = useMemo(() => {
    const withoutTeam = org.agents.filter((agent) => !agent.teamId).length;
    const withoutLead = org.teams.filter((team) => !team.leadId).length;
    const withPath = org.projects.filter((project) => Boolean(project.path)).length;
    // Several assignments can belong to the same agent; the card names people,
    // not runs, so the list is deduplicated before it is printed.
    const busy = [...new Set(org.running.map((view) => view.agentName))];
    return { withoutTeam, withoutLead, withPath, busy };
  }, [org.agents, org.teams, org.projects, org.running]);

  const running = org.running.length;

  // `GET /api/org` returns the active rows only - `listAgents` and
  // `listProjects` both filter `archived = 0`, and there is no endpoint that
  // would hand the archived ones over. So no card claims a total here; each
  // one says which population it counted.
  const cards: StatCardProps[] = [
    {
      label: 'Agenten',
      value: formatNumber(org.agents.length),
      headline:
        counts.withoutTeam === 0
          ? 'Alle einem Team zugeordnet'
          : formatNumber(counts.withoutTeam) + ' ohne Team',
      footnote: 'Nur die aktiven — archivierte liefert der Server nicht mit',
      to: '/org/agents',
    },
    {
      label: 'Teams',
      value: formatNumber(org.teams.length),
      headline:
        counts.withoutLead === 0
          ? 'Jedes Team hat eine Leitung'
          : formatNumber(counts.withoutLead) + ' ohne Leitung',
      footnote: 'Ein Team bündelt Agenten und gibt ihnen eine Ansprechpartnerin',
      to: '/org/teams',
    },
    {
      label: 'Projekte',
      value: formatNumber(org.projects.length),
      headline:
        counts.withPath === 0
          ? 'Alle laufen im Arbeitsraum'
          : formatNumber(counts.withPath) + ' mit eigenem Verzeichnis',
      footnote: 'Nur die aktiven — archivierte liefert der Server nicht mit',
      to: '/org/projects',
    },
    {
      label: 'Laufende Aufträge',
      value: formatNumber(running),
      ...(running > 0 ? { badge: <RunningBadge count={running} /> } : {}),
      headline:
        running === 0 ? 'Gerade arbeitet niemand' : shorten(counts.busy.join(', '), 40),
      footnote: 'Aus dem Livestream der Aufträge, nicht aus einer Liste',
      to: '/assignments',
    },
  ];

  /* -------------------------------- states -------------------------------- */

  if (org.loading && !organization) return <OrgSkeleton />;

  if (!organization) {
    return (
      <PageBody width="3xl">
        {org.error ? (
          <ServerOffline onRetry={() => void org.refresh()} />
        ) : (
          <EmptyState
            icon={Building2Icon}
            title="Keine Firma gefunden"
            description="Rookery legt die Firma beim ersten Start selbst an. Läuft der Server mit einer anderen Datenbank?"
            actionLabel="Erneut laden"
            onAction={() => void org.refresh()}
          />
        )}
      </PageBody>
    );
  }

  return (
    <PageBody>
      <div className="px-4 lg:px-6">
        <p className="text-sm text-muted-foreground">
          {organization.mission || 'Noch keine Mission hinterlegt.'}
        </p>
      </div>

      {/*
        The numbers and the view switcher belong to the section's front page.
        On Teams and Projekte they were a second navigation the sidebar already
        offers - its submenu stands open whenever /org/* is active - and the
        same four cards above every one of the three tables said nothing new.
      */}
      {isIndex && <StatCards items={cards} />}

      {/*
        One Tabs root whose value comes from the route. `TabsContent` holds the
        outlet so the panel keeps the `aria-controls` relationship the triggers
        announce - a bare row of links would drop it.
      */}
      <Tabs value={active} className="gap-4">
        {isIndex && (
        <div className="px-4 lg:px-6">
          <TabsList className="**:data-[slot=badge]:size-5 **:data-[slot=badge]:rounded-full **:data-[slot=badge]:bg-muted-foreground/30 **:data-[slot=badge]:px-1">
            <TabsTrigger value="agents" asChild>
              <NavLink to="/org/agents">
                Agenten
                <Badge variant="secondary">{formatNumber(org.agents.length)}</Badge>
              </NavLink>
            </TabsTrigger>
            <TabsTrigger value="teams" asChild>
              <NavLink to="/org/teams">
                Teams
                <Badge variant="secondary">{formatNumber(org.teams.length)}</Badge>
              </NavLink>
            </TabsTrigger>
            <TabsTrigger value="projects" asChild>
              <NavLink to="/org/projects">
                Projekte
                <Badge variant="secondary">{formatNumber(org.projects.length)}</Badge>
              </NavLink>
            </TabsTrigger>
          </TabsList>
        </div>
        )}

        <TabsContent value={active} forceMount className="flex flex-col gap-4">
          <Outlet />
        </TabsContent>
      </Tabs>

      <OrganizationDrawer
        open={editOpen}
        onOpenChange={setEditOpen}
        id={organization.id}
        name={organization.name}
        mission={organization.mission ?? ''}
        onSaved={() => void org.refresh()}
      />
    </PageBody>
  );
}

/* ------------------------------ the company ------------------------------ */

interface OrganizationDrawerProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  id: string;
  name: string;
  mission: string;
  onSaved(): void;
}

/**
 * Name and mission, in the one place they can be changed.
 *
 * `useDraft` rather than two `useState`s plus an effect: the company reloads
 * on every structural broadcast in the whole system, and the old inline form
 * threw away what was typed each time one arrived.
 */
function OrganizationDrawer({
  open,
  onOpenChange,
  id,
  name,
  mission,
  onSaved,
}: OrganizationDrawerProps) {
  const { draft, dirty, set, hydrate, markSaved } = useDraft<OrgDraft>({ name, mission });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);

  // Keyed by the values, not just the id: the company reloads on every
  // structural broadcast, and a change made elsewhere should show up here -
  // while `useDraft` still refuses to overwrite anything already typed.
  useEffect(() => {
    if (!open) return;
    hydrate(id + '|' + name + '|' + mission, () => ({ name, mission }));
  }, [hydrate, id, mission, name, open]);

  const save = useCallback(async (): Promise<void> => {
    const parsed = organizationSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error));
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      await api.updateOrganization(id, {
        name: parsed.data.name,
        mission: parsed.data.mission.trim() || null,
      });
      markSaved();
      onSaved();
      onOpenChange(false);
      toast('Firma gespeichert');
    } catch (caught) {
      reportFailure('Speichern', caught);
    } finally {
      setSaving(false);
    }
  }, [draft, id, markSaved, onOpenChange, onSaved]);

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Firma bearbeiten"
      description="Der Name steht im Kopf jeder Firmenseite, die Mission im Systemprompt der Agenten."
      closeLabel="Abbrechen"
      footer={
        <Button onClick={() => void save()} disabled={saving || !dirty}>
          Speichern
        </Button>
      }
    >
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor="firma-name">Name</FieldLabel>
          <Input
            id="firma-name"
            value={draft.name}
            aria-invalid={errors.name ? true : undefined}
            onChange={(event) => set({ name: event.target.value })}
          />
          {errors.name ? <FieldError>{errors.name}</FieldError> : null}
        </Field>

        <Field>
          <FieldLabel htmlFor="firma-mission">Mission</FieldLabel>
          <Textarea
            id="firma-mission"
            rows={4}
            placeholder="Wofür die Firma da ist, in ein bis zwei Sätzen."
            value={draft.mission}
            onChange={(event) => set({ mission: event.target.value })}
          />
        </Field>
      </FieldGroup>
    </DetailDrawer>
  );
}

/**
 * The loading state in the geometry the loaded page has: four numbers, the
 * tab strip, a table. Anything shorter would move the tabs under the pointer
 * the moment the request comes back.
 */
function OrgSkeleton() {
  return (
    <PageBody>
      <div className="px-4 lg:px-6">
        <Skeleton className="h-5 w-80 max-w-full" />
      </div>

      <StatCardsSkeleton />

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <Skeleton className="h-9 w-72 max-w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
    </PageBody>
  );
}
