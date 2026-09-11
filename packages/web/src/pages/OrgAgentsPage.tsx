import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router';
import {
  ArchiveIcon,
  Building2Icon,
  CpuIcon,
  InboxIcon,
  MessagesSquareIcon,
  PencilIcon,
  ShieldIcon,
  SquareArrowOutUpRightIcon,
  UserRoundIcon,
  UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { PERMISSION_LABEL, relativeTime, shorten } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Agent, Assignment, PermissionLevel } from '@/lib/types';
import { useChatSession, useOrgState } from '@/providers/rookery-provider';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer, DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { useBulkAction, useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { FilterCombobox } from '@/components/common/filter-combobox';
import { MetaList } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { RelatedItem } from '@/components/common/related-item';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { ResultMarkdown } from '@/components/result-markdown';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ItemGroup } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Everyone who works here, as one table.
 *
 * The list this replaces was a `<ul>` grouped by team: no search, no sorting,
 * no way to see who reports to whom without opening every entry. The grouping
 * it did offer is the Team filter now, and it is shareable - the team filter
 * lives in the URL, so the member count on the Teams tab can link straight
 * into "the four people in Redaktion".
 *
 * What is missing is missing on the server: `GET /api/org` calls
 * `listAgents(orgId)`, which filters `archived = 0`, and no endpoint hands
 * archived agents over. So there is no "Archivierte zeigen" switch and no
 * archived count - archiving simply removes the row, and the confirmation
 * says so.
 */

/** Team filter value for "belongs to no team at all". */
const NO_TEAM = '__none__';
/** Access filter value for "inherits the level from the settings". */
const INHERITED = '__default__';

/** How many past assignments the drawer fetches. A glance, not a history. */
const DRAWER_ASSIGNMENTS = 5;

const column = createRookeryColumnHelper<Agent>();

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  title: 'Titel',
  slug: 'Kürzel',
  team: 'Team',
  manager: 'Vorgesetzter',
  provider: 'Anbieter',
  permission: 'Zugriff',
  actions: 'Aktionen',
};

const PERMISSIONS: readonly PermissionLevel[] = ['chat', 'read', 'write', 'full'];

export function OrgAgentsPage() {
  const org = useOrgState();
  const navigate = useNavigate();
  const { chooseCounterpart } = useChatSession();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  const [searchParams, setSearchParams] = useSearchParams();
  const team = searchParams.get('team');
  const [permission, setPermission] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  /**
   * The team filter lives in the URL so the Teams tab can link into it. Written
   * with `replace` because filtering is not a place in the history - the back
   * button should leave the page, not step through five filter states.
   */
  const setTeam = useCallback(
    (value: string | null) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set('team', value);
          else next.delete('team');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /* -------------------------------- actions ------------------------------- */

  const archive = useCallback(
    async (agent: Agent): Promise<void> => {
      const teamName = org.teams.find((entry) => entry.id === agent.teamId)?.name;
      const reports = org.agents.filter((entry) => entry.managerId === agent.id).length;

      const parts = [
        agent.name +
          ' nimmt keine Aufträge mehr an und verschwindet aus dieser Liste — der Server ' +
          'gibt archivierte Agenten nicht mehr heraus.',
        teamName ? 'Das Team ' + teamName + ' verliert damit ein Mitglied.' : null,
        reports > 0
          ? formatNumber(reports) +
            (reports === 1 ? ' unterstellter Agent berichtet' : ' unterstellte Agenten berichten') +
            ' danach an niemanden mehr.'
          : null,
        'Aufträge und Erinnerungen bleiben erhalten.',
      ].filter(Boolean);

      const ok = await confirm({
        title: agent.name + ' archivieren?',
        description: parts.join(' '),
        confirmLabel: 'Archivieren',
        destructive: true,
        icon: ArchiveIcon,
      });
      if (!ok) return;

      try {
        await api.updateAgent(agent.id, { archived: true });
        await org.refresh();
        toast(agent.name + ' archiviert');
      } catch (caught) {
        reportFailure('Archivieren', caught);
      }
    },
    [confirm, org],
  );

  /* -------------------------------- columns ------------------------------- */

  const columns = useMemo(
    () =>
      column.columns([
        selectionColumn<Agent>({ rowLabel: (agent) => agent.name + ' wählen' }),

        column.accessor('name', {
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
          cell: ({ row }) => (
            <DetailDrawerTrigger
              className="font-medium"
              onClick={() => setDrawerId(row.original.id)}
            >
              {row.original.name}
            </DetailDrawerTrigger>
          ),
          enableHiding: false,
        }),

        column.accessor('title', {
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Titel" />,
          cell: ({ row }) => (
            <span className="line-clamp-1 text-muted-foreground">{row.original.title}</span>
          ),
        }),

        column.accessor('slug', {
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Kürzel" />,
          cell: ({ row }) => (
            <Badge variant="outline" className="font-mono font-normal">
              {row.original.slug}
            </Badge>
          ),
        }),

        // Sorted by the team's name, not its id, so the column groups the way
        // it reads.
        column.accessor(
          (agent) => org.teams.find((entry) => entry.id === agent.teamId)?.name ?? '',
          {
            id: 'team',
            header: ({ column: head }) => <DataTableColumnHeader column={head} title="Team" />,
            cell: ({ row }) => {
              const entry = org.teams.find((candidate) => candidate.id === row.original.teamId);
              if (!entry) return <span className="text-muted-foreground">Ohne Team</span>;
              return (
                <NavLink to={'/org/agents?team=' + entry.id} className="hover:underline">
                  {entry.name}
                </NavLink>
              );
            },
          },
        ),

        column.accessor(
          (agent) => org.agents.find((entry) => entry.id === agent.managerId)?.name ?? '',
          {
            id: 'manager',
            header: ({ column: head }) => (
              <DataTableColumnHeader column={head} title="Vorgesetzter" />
            ),
            cell: ({ row }) => {
              const manager = org.agentById(row.original.managerId);
              if (!manager) return <span className="text-muted-foreground">Der Assistent</span>;
              return (
                <NavLink to={'/org/agents/' + manager.id} className="hover:underline">
                  {manager.name}
                </NavLink>
              );
            },
          },
        ),

        column.accessor((agent) => agent.provider ?? '', {
          id: 'provider',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Anbieter" />,
          cell: ({ row }) => (
            <ProviderCell
              fallback="Standard"
              {...(row.original.provider ? { provider: row.original.provider } : {})}
              {...(row.original.model ? { model: row.original.model } : {})}
            />
          ),
        }),

        column.accessor((agent) => agent.permission ?? '', {
          id: 'permission',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Zugriff" />,
          cell: ({ row }) =>
            row.original.permission ? (
              <Badge variant="outline" className="font-normal">
                {PERMISSION_LABEL[row.original.permission]}
              </Badge>
            ) : (
              <span className="text-muted-foreground">Vorgabe</span>
            ),
        }),

        actionsColumn<Agent>((agent) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Aktionen für ' + agent.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => void navigate('/org/agents/' + agent.id)}>
                <SquareArrowOutUpRightIcon />
                Öffnen
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to={'/org/agents/' + agent.id + '/edit'}>
                  <PencilIcon />
                  Bearbeiten
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => chooseCounterpart(agent.id)}>
                <MessagesSquareIcon />
                Chat mit {shorten(agent.name, 18)}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void archive(agent)}>
                <ArchiveIcon />
                Archivieren
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [archive, chooseCounterpart, navigate, org],
  );

  /* --------------------------------- rows --------------------------------- */

  const rows = useMemo(() => {
    let list = org.agents;
    if (team) {
      list = list.filter((agent) =>
        team === NO_TEAM ? !agent.teamId : agent.teamId === team,
      );
    }
    if (permission) {
      list = list.filter((agent) =>
        permission === INHERITED ? !agent.permission : agent.permission === permission,
      );
    }
    return list;
  }, [org.agents, permission, team]);

  const filtered = team !== null || permission !== null;
  const drawerAgent = org.agents.find((agent) => agent.id === drawerId) ?? null;

  return (
    <>
      {dialog}
      {bulk.dialog}

      <DataTable
        data={rows}
        columns={columns}
        getRowId={(agent) => agent.id}
        idPrefix="agenten"
        onRowClick={(agent) => setDrawerId(agent.id)}
        rowClickIgnoreColumns={['select', 'name', 'actions']}
        searchable
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Agenten durchsuchen"
        searchText={(agent) => agent.name + ' ' + agent.title + ' ' + agent.slug}
        columnLabels={COLUMN_LABELS}
        initialSorting={[{ id: 'name', desc: false }]}
        rowLabel={{ singular: 'Agent', plural: 'Agenten' }}
        loading={org.loading && org.agents.length === 0}
        error={org.error ? <ServerOffline onRetry={() => void org.refresh()} /> : undefined}
        filters={
          <>
            <FilterCombobox
              label="Team"
              placeholder="Team"
              value={team}
              onChange={setTeam}
              options={[
                { value: NO_TEAM, label: 'Ohne Team' },
                ...org.teams.map((entry) => ({ value: entry.id, label: entry.name })),
              ]}
            />
            <FilterCombobox
              label="Zugriff"
              placeholder="Zugriff"
              value={permission}
              onChange={setPermission}
              options={[
                { value: INHERITED, label: 'Vorgabe' },
                ...PERMISSIONS.map((level) => ({
                  value: level,
                  label: PERMISSION_LABEL[level],
                })),
              ]}
            />
          </>
        }
        bulkActions={(selected, clear) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void bulk.run({
                rows: selected,
                noun: { singular: 'Agent', plural: 'Agenten' },
                nameOf: (agent) => agent.name,
                verb: 'archivieren',
                done: 'archiviert',
                confirmLabel: 'Archivieren',
                icon: ArchiveIcon,
                description:
                  'Sie nehmen keine Aufträge mehr an und verschwinden aus dieser Liste. ' +
                  'Aufträge und Erinnerungen bleiben erhalten.',
                run: (agent) => api.updateAgent(agent.id, { archived: true }),
                after: org.refresh,
                clear,
              })
            }
          >
            <ArchiveIcon data-icon="inline-start" />
            Archivieren
          </Button>
        )}
        empty={
          // The table's own `empty` fires when nothing was handed over at all -
          // which, with the facet filters applied before the hand-over, is also
          // what an empty filter result looks like. The two say different
          // things, so the page picks the right sentence.
          filtered ? (
            <NoResults
              onReset={() => {
                setSearch('');
                setTeam(null);
                setPermission(null);
              }}
            />
          ) : (
            <EmptyState
              icon={UserRoundIcon}
              title="Noch niemand eingestellt"
              description="Ohne Agenten arbeitet der Assistent allein. Ein Agent ist ein eigener Prozess mit eigenen Anweisungen, eigenem Gedächtnis und eigener Zugriffsstufe."
              actionLabel="Agent einstellen"
              actionTo="/org/agents/new"
              variant="plain"
            />
          )
        }
        filteredEmpty={
          <NoResults
            {...(search.trim() ? { query: search.trim() } : {})}
            onReset={() => {
              setSearch('');
              setTeam(null);
              setPermission(null);
            }}
          />
        }
      />

      {filtered && rows.length > 0 ? (
        <div className="px-4 lg:px-6">
          <p className="text-xs text-muted-foreground">
            Gefiltert aus {formatNumber(org.agents.length)} aktiven Agenten.{' '}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setTeam(null);
                setPermission(null);
              }}
            >
              Filter aufheben
            </button>
          </p>
        </div>
      ) : null}

      <AgentDrawer
        agent={drawerAgent}
        onOpenChange={(open) => {
          if (!open) setDrawerId(null);
        }}
        teamName={org.teams.find((entry) => entry.id === drawerAgent?.teamId)?.name ?? null}
        managerName={org.agentById(drawerAgent?.managerId)?.name ?? null}
      />
    </>
  );
}

/* --------------------------------- drawer --------------------------------- */

interface AgentDrawerProps {
  agent: Agent | null;
  onOpenChange(open: boolean): void;
  teamName: string | null;
  managerName: string | null;
}

/**
 * One agent at a glance, without leaving the table.
 *
 * The last assignments are fetched when the drawer opens rather than joined
 * into the list: `GET /api/org` carries no assignment history per agent, and
 * five rows for the one person being looked at is one request, not N.
 */
function AgentDrawer({ agent, onOpenChange, teamName, managerName }: AgentDrawerProps) {
  const [recent, setRecent] = useState<Assignment[] | null>(null);
  const [failed, setFailed] = useState(false);

  const agentId = agent?.id ?? null;

  useEffect(() => {
    if (!agentId) {
      setRecent(null);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setRecent(null);
    setFailed(false);
    api
      .assignments({ agentId, limit: DRAWER_ASSIGNMENTS })
      .then((list) => {
        if (!cancelled) setRecent(list);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const instructions = agent?.instructions.trim() ?? '';

  return (
    <DetailDrawer
      open={agent !== null}
      onOpenChange={onOpenChange}
      title={agent?.name ?? 'Agent'}
      description={agent?.title}
      className="data-[vaul-drawer-direction=right]:sm:max-w-xl"
      footer={
        agent ? (
          <Button asChild>
            <NavLink to={'/org/agents/' + agent.id}>Agent öffnen</NavLink>
          </Button>
        ) : null
      }
    >
      {agent ? (
        <>
          <div>
            <h3 className="mb-2 text-sm font-medium">Anweisungen</h3>
            {instructions === '' ? (
              <EmptyState
                icon={PencilIcon}
                title="Keine eigenen Anweisungen"
                description={agent.name + ' arbeitet nur mit dem Auftragstext.'}
                actionLabel="Bearbeiten"
                actionTo={'/org/agents/' + agent.id + '/edit'}
                variant="plain"
                size="sm"
              />
            ) : (
              <>
                {/* Six lines is the fold; Tailwind needs the class spelled out. */}
                <div className="line-clamp-6">
                  <ResultMarkdown text={instructions} />
                </div>
                {/* A fold, not a truncation: the whole text stays one click away. */}
                <Accordion type="single" collapsible>
                  <AccordionItem value="full" className="border-b-0">
                    <AccordionTrigger>Ganzen Text zeigen</AccordionTrigger>
                    <AccordionContent>
                      <ResultMarkdown text={instructions} />
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </>
            )}
          </div>

          <MetaList
            columns={1}
            items={[
              { label: 'Kürzel', value: agent.slug, mono: true },
              {
                label: 'Team',
                value: teamName ?? 'Ohne Team',
                icon: Building2Icon,
                ...(agent.teamId ? { to: '/org/agents?team=' + agent.teamId } : {}),
              },
              {
                label: 'Vorgesetzter',
                value: managerName ?? 'Der Assistent',
                icon: UsersIcon,
                ...(agent.managerId ? { to: '/org/agents/' + agent.managerId } : {}),
              },
              {
                label: 'Anbieter',
                value: (
                  <ProviderCell
                    layout="inline"
                    fallback="Standard"
                    {...(agent.provider ? { provider: agent.provider } : {})}
                    {...(agent.model ? { model: agent.model } : {})}
                  />
                ),
                icon: CpuIcon,
              },
              {
                label: 'Zugriff',
                value: agent.permission ? PERMISSION_LABEL[agent.permission] : 'Vorgabe',
                icon: ShieldIcon,
              },
              { label: 'Eingestellt', value: formatDateTime(agent.createdAt) },
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-medium">Letzte Aufträge</h3>
            {failed ? (
              <ServerOffline size="sm" />
            ) : recent === null ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 3 }, (_, index) => (
                  <Skeleton key={index} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : recent.length === 0 ? (
              <EmptyState
                icon={InboxIcon}
                title={'Noch kein Auftrag für ' + agent.name}
                description="Aufträge laufen als eigener Prozess, unabhängig vom Gespräch."
                actionLabel="Agent öffnen"
                actionTo={'/org/agents/' + agent.id}
                variant="plain"
                size="sm"
              />
            ) : (
              <ItemGroup className="gap-2">
                {recent.map((assignment) => (
                  <RelatedItem
                    key={assignment.id}
                    to={'/assignments/' + assignment.id}
                    title={shorten(assignment.task, 80)}
                    description={relativeTime(assignment.createdAt)}
                    trailing={<StatusBadge kind="assignment" status={assignment.status} />}
                  />
                ))}
              </ItemGroup>
            )}
          </div>
        </>
      ) : null}
    </DetailDrawer>
  );
}

