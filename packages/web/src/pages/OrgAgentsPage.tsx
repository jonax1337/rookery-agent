import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router';
import {
  ArchiveIcon,
  Building2Icon,
  CpuIcon,
  InboxIcon,
  MailPlusIcon,
  PencilIcon,
  ShieldIcon,
  SquareArrowOutUpRightIcon,
  UsersIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { PERMISSION_LABEL, relativeTime, shorten } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { Agent, Assignment, OrgPerformanceEntry, PermissionLevel } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { UserRoundIcon } from '@/components/animate-ui/icons/user-round';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
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
 * archived agents over. So there is no "Archived zeigen" switch and no
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
  title: 'Title',
  slug: 'Slug',
  team: 'Team',
  manager: 'Manager',
  provider: 'Provider',
  permission: 'Permission',
  stage: 'Performance',
  actions: 'Actions',
};

const PERMISSIONS: readonly PermissionLevel[] = ['chat', 'read', 'write', 'full'];

/**
 * The "no agents hired yet" state swaps its lucide silhouette for the
 * animate-ui one: same stroke, the head nods once when the state scrolls
 * into view. `EmptyState` types its `icon` as a `LucideIcon` and renders it
 * without props, so the `animateOnView` trigger rides along in this shell.
 */
const AnimatedUserRoundIcon = forwardRef<SVGSVGElement>(function AnimatedUserRoundIcon() {
  return <UserRoundIcon size={24} animateOnView />;
});

export function OrgAgentsPage() {
  const org = useOrgState();
  const navigate = useNavigate();
  const { confirm, dialog } = useConfirm();
  const bulk = useBulkAction();

  const [searchParams, setSearchParams] = useSearchParams();
  const team = searchParams.get('team');
  const [permission, setPermission] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);

  // Fetched once, alongside the list rather than through org state: the
  // score badge is a nice-to-have on this page, not something the socket
  // needs to keep live-updated for every column in the app.
  const [performance, setPerformance] = useState<Map<string, OrgPerformanceEntry>>(new Map());
  useEffect(() => {
    api
      .orgPerformance()
      .then((rows) => setPerformance(new Map(rows.map((row) => [row.agent.id, row]))))
      .catch(() => setPerformance(new Map()));
  }, []);

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
          ' will no longer accept assignments and will disappear from this list — the server ' +
          'no longer returns archived agents.',
        teamName ? 'The team ' + teamName + ' will lose a member.' : null,
        reports > 0
          ? formatNumber(reports) +
            (reports === 1 ? ' direct report will report' : ' direct reports will report') +
            ' to no one afterward.'
          : null,
        'Assignments and memories will remain.',
      ].filter(Boolean);

      const ok = await confirm({
        title: agent.name + ' archive?',
        description: parts.join(' '),
        confirmLabel: 'Archive',
        destructive: true,
        icon: ArchiveIcon,
      });
      if (!ok) return;

      try {
        await api.updateAgent(agent.id, { archived: true });
        await org.refresh();
        toast(agent.name + ' archived');
      } catch (caught) {
        reportFailure('Archive', caught);
      }
    },
    [confirm, org],
  );

  /* -------------------------------- columns ------------------------------- */

  const columns = useMemo(
    () =>
      column.columns([
        selectionColumn<Agent>({ rowLabel: (agent) => agent.name + ' selected' }),

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
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Title" />,
          cell: ({ row }) => (
            <span className="line-clamp-1 text-muted-foreground">{row.original.title}</span>
          ),
        }),

        column.accessor('slug', {
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Slug" />,
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
              if (!entry) return <span className="text-muted-foreground">No team</span>;
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
              <DataTableColumnHeader column={head} title="Manager" />
            ),
            cell: ({ row }) => {
              const manager = org.agentById(row.original.managerId);
              if (!manager) return <span className="text-muted-foreground">The assistant</span>;
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
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Provider" />,
          cell: ({ row }) => (
            <ProviderCell
              fallback="Default"
              {...(row.original.provider ? { provider: row.original.provider } : {})}
              {...(row.original.model ? { model: row.original.model } : {})}
            />
          ),
        }),

        column.accessor((agent) => agent.permission ?? '', {
          id: 'permission',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Permission" />,
          cell: ({ row }) =>
            row.original.permission ? (
              <Badge variant="outline" className="font-normal">
                {PERMISSION_LABEL[row.original.permission]}
              </Badge>
            ) : (
              <span className="text-muted-foreground">Default</span>
            ),
        }),

        column.accessor((agent) => performance.get(agent.id)?.performance.stage ?? 0, {
          id: 'stage',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Performance" />,
          cell: ({ row }) => {
            const stage = performance.get(row.original.id)?.performance.stage ?? 0;
            return stage > 0 ? (
              <StatusBadge kind="agentStage" status={stage} />
            ) : (
              <span className="text-muted-foreground">Normal</span>
            );
          },
        }),

        actionsColumn<Agent>((agent) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + agent.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => void navigate('/org/agents/' + agent.id)}>
                <SquareArrowOutUpRightIcon />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <NavLink to={'/org/agents/' + agent.id + '/edit'}>
                  <PencilIcon />
                  Edit
                </NavLink>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void navigate('/inbox?mailbox=' + agent.id)}>
                <InboxIcon />
                View mailbox
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void navigate('/inbox?compose=' + agent.id)}>
                <MailPlusIcon />
                Write mail
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => void archive(agent)}>
                <ArchiveIcon />
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [archive, navigate, org, performance],
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

      <Fade>
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
          searchPlaceholder="Search agents"
          searchText={(agent) => agent.name + ' ' + agent.title + ' ' + agent.slug}
          columnLabels={COLUMN_LABELS}
          initialSorting={[{ id: 'name', desc: false }]}
          rowLabel={{ singular: 'Agent', plural: 'Agents' }}
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
                  { value: NO_TEAM, label: 'No team' },
                  ...org.teams.map((entry) => ({ value: entry.id, label: entry.name })),
                ]}
              />
              <FilterCombobox
                label="Permission"
                placeholder="Permission"
                value={permission}
                onChange={setPermission}
                options={[
                  { value: INHERITED, label: 'Default' },
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
                  noun: { singular: 'Agent', plural: 'Agents' },
                  nameOf: (agent) => agent.name,
                  verb: 'archive',
                  done: 'archived',
                  confirmLabel: 'Archive',
                  icon: ArchiveIcon,
                  description:
                    'They will no longer accept assignments and will disappear from this list. ' +
                    'Assignments and memories will remain.',
                  run: (agent) => api.updateAgent(agent.id, { archived: true }),
                  after: org.refresh,
                  clear,
                })
              }
            >
              <ArchiveIcon data-icon="inline-start" />
              Archive
            </Button>
          )}
          empty={
            // The table's own `empty` fires when nothing was handed over at all -
            // which, with the facet filters applied before the hand-over, is also
            // what an empty filter result looks like. The two say different
            // things, so the page picks the right sentence.
            <Fade>
              {filtered ? (
                <NoResults
                  onReset={() => {
                    setSearch('');
                    setTeam(null);
                    setPermission(null);
                  }}
                />
              ) : (
                <EmptyState
                  icon={AnimatedUserRoundIcon}
                  title="No agents hired yet"
                  description="Without agents, the assistant works alone. An agent is a separate process with its own instructions, Memory, and permission level."
                  actionLabel="Hire agent"
                  actionTo="/org/agents/new"
                  variant="plain"
                />
              )}
            </Fade>
          }
          filteredEmpty={
            <Fade>
              <NoResults
                {...(search.trim() ? { query: search.trim() } : {})}
                onReset={() => {
                  setSearch('');
                  setTeam(null);
                  setPermission(null);
                }}
              />
            </Fade>
          }
        />
      </Fade>

      {filtered && rows.length > 0 ? (
        <Fade delay={50}>
          <div className="px-4 lg:px-6">
            <p className="text-xs text-muted-foreground">
              Filtered from <CountingNumber number={org.agents.length} /> active agents.{' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => {
                  setTeam(null);
                  setPermission(null);
                }}
              >
                Clear filter
              </button>
            </p>
          </div>
        </Fade>
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
            <NavLink to={'/org/agents/' + agent.id}>Open agent</NavLink>
          </Button>
        ) : null
      }
    >
      {agent ? (
        <>
          <div>
            <h3 className="mb-2 text-sm font-medium">Instructions</h3>
            {instructions === '' ? (
              <EmptyState
                icon={PencilIcon}
                title="No custom instructions"
                description={agent.name + ' works only from the assignment text.'}
                actionLabel="Edit"
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
                    <AccordionTrigger>Show full text</AccordionTrigger>
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
              { label: 'Slug', value: agent.slug, mono: true },
              {
                label: 'Team',
                value: teamName ?? 'No team',
                icon: Building2Icon,
                ...(agent.teamId ? { to: '/org/agents?team=' + agent.teamId } : {}),
              },
              {
                label: 'Manager',
                value: managerName ?? 'The assistant',
                icon: UsersIcon,
                ...(agent.managerId ? { to: '/org/agents/' + agent.managerId } : {}),
              },
              {
                label: 'Provider',
                value: (
                  <ProviderCell
                    layout="inline"
                    fallback="Default"
                    {...(agent.provider ? { provider: agent.provider } : {})}
                    {...(agent.model ? { model: agent.model } : {})}
                  />
                ),
                icon: CpuIcon,
              },
              {
                label: 'Permission',
                value: agent.permission ? PERMISSION_LABEL[agent.permission] : 'Default',
                icon: ShieldIcon,
              },
              { label: 'Hired', value: formatDateTime(agent.createdAt) },
            ]}
          />

          <div>
            <h3 className="mb-2 text-sm font-medium">Recent assignments</h3>
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
                title={'No assignments for ' + agent.name}
                description="Assignments run in a separate process, independently of the conversation."
                actionLabel="Open agent"
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
