import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import {
  BadgeAlertIcon as TriangleAlertIcon,
  ChevronRightIcon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  UsersIcon,
} from "@/components/icons";

import { api } from '@/lib/api';
import type { OrgPerformanceEntry } from '@/lib/types';
import { usePageMeta } from '@/components/shell/page-meta';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { actionsColumn, emptyCell } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { TrendIndicator } from '@/components/common/trend-indicator';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import type { IconComponent } from "@/components/icons";

/**
 * Performance: every agent's standing in one table, same shell as
 * `/org/agents` and `/org/teams` (`DataTable` + `createRookeryColumnHelper`)
 * rather than a one-off list - a bespoke table here would have meant search,
 * sorting and the column picker work everywhere else in the app except this
 * page. A pending replacement proposal links into the agent's own page,
 * where the draft and the approval already live (`AgentDetailPage`); this
 * page only says who needs attention.
 */

const column = createRookeryColumnHelper<OrgPerformanceEntry>();

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  title: 'Title',
  average: 'Average',
  trend: 'Trend',
  failureRate: 'Failure rate',
  stage: 'Stage',
  actions: 'Actions',
};

function TrendCell({ trend }: { trend: number | null }) {
  if (trend === null) return emptyCell('end');
  return <TrendIndicator trend={trend} size="sm" align="end" />;
}

/**
 * `EmptyState` expects a lucide component; this bridges to the animated
 * users icon so the empty table's symbol bounces in on view.
 */
const UsersEmptyIcon = (() => <UsersIcon size={24} />) as unknown as IconComponent;

export function OrgPerformancePage() {
  usePageMeta({ title: 'Performance' }, []);
  const navigate = useNavigate();

  const [entries, setEntries] = useState<OrgPerformanceEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async (): Promise<void> => {
    setError(false);
    try {
      setEntries(await api.orgPerformance());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = entries ?? [];
  const proposals = rows.filter((row) => row.pendingProposal);

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor((row) => row.agent.name, {
          id: 'name',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Name" />,
          cell: ({ row }) => (
            <NavLink to={'/org/agents/' + row.original.agent.id} className="font-medium hover:underline">
              {row.original.agent.name}
            </NavLink>
          ),
          enableHiding: false,
        }),

        column.accessor((row) => row.agent.title, {
          id: 'title',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Title" />,
          cell: ({ row }) => <span className="text-muted-foreground">{row.original.agent.title}</span>,
        }),

        column.accessor((row) => row.performance.average ?? -1, {
          id: 'average',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Average" align="end" />,
          cell: ({ row }) => {
            const average = row.original.performance.average;
            return (
              <span className="block text-right tabular-nums">
                {average !== null ? average.toFixed(1) + ' / 5' : <span className="text-muted-foreground">No data</span>}
              </span>
            );
          },
        }),

        column.accessor((row) => row.performance.trend ?? 0, {
          id: 'trend',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Trend" align="end" />,
          cell: ({ row }) => <TrendCell trend={row.original.performance.trend} />,
        }),

        column.accessor((row) => row.performance.failureRate, {
          id: 'failureRate',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Failure rate" align="end" />,
          cell: ({ row }) => (
            <span className="block text-right tabular-nums text-muted-foreground">
              {Math.round(row.original.performance.failureRate * 100)}%
            </span>
          ),
        }),

        column.accessor((row) => row.performance.stage, {
          id: 'stage',
          header: ({ column: head }) => <DataTableColumnHeader column={head} title="Stage" />,
          cell: ({ row }) => {
            const stage = row.original.performance.stage;
            return stage > 0 ? (
              <StatusBadge kind="agentStage" status={stage} />
            ) : (
              <span className="text-muted-foreground">Normal</span>
            );
          },
        }),

        actionsColumn<OrgPerformanceEntry>((row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + row.agent.name} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => void navigate('/org/agents/' + row.agent.id)}>
                <SquareArrowOutUpRightIcon />
                Open
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [navigate],
  );

  return (
    <div className="flex flex-col gap-4">
      {proposals.length > 0 ? (
        <Fade>
          <div className="px-4 lg:px-6">
            {/* No alert role: this panel mounts after the fetch and holds a
                link list - as a live region it would be announced
                assertively in full on appearance. */}
            <Alert variant="destructive" role="group">
              <TriangleAlertIcon />
              <AlertTitle>
                {proposals.length === 1 ? (
                  'One replacement proposed'
                ) : (
                  <span>
                    <CountingNumber number={proposals.length} /> replacements proposed
                  </span>
                )}
              </AlertTitle>
              <AlertDescription>
                Review the successor draft and approve or adjust it on the agent&apos;s own page.
              </AlertDescription>
              {/* The alert lays out icon and text as a two-column grid; the
                  proposal rows span it in full width below the description. */}
              <ItemGroup className="col-span-full mt-3">
                {proposals.map((row) => (
                  <Item key={row.agent.id} asChild variant="outline" size="sm">
                    <NavLink to={'/org/agents/' + row.agent.id}>
                      <ItemContent>
                        <ItemTitle>{row.agent.name}</ItemTitle>
                        <ItemDescription>{row.agent.title}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <ChevronRightIcon className="size-4" />
                      </ItemActions>
                    </NavLink>
                  </Item>
                ))}
              </ItemGroup>
            </Alert>
          </div>
        </Fade>
      ) : null}

      <Fade delay={50}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.agent.id}
          idPrefix="performance"
          onRowClick={(row) => void navigate('/org/agents/' + row.agent.id)}
          rowClickIgnoreColumns={['name', 'actions']}
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search agents"
          searchText={(row) => row.agent.name + ' ' + row.agent.title}
          columnLabels={COLUMN_LABELS}
          initialSorting={[
            { id: 'stage', desc: true },
            { id: 'average', desc: false },
          ]}
          rowLabel={{ singular: 'Agent', plural: 'Agents' }}
          loading={loading && !entries}
          error={error && !entries ? <ServerOffline onRetry={() => void load()} /> : undefined}
          empty={
            <EmptyState
              icon={UsersEmptyIcon}
              title="No agents yet"
              description="Hire an agent to see their performance here once they have completed a few assignments."
              actionLabel="Hire agent"
              actionTo="/org/agents/new"
              variant="plain"
            />
          }
          filteredEmpty={
            <NoResults {...(search.trim() ? { query: search.trim() } : {})} onReset={() => setSearch('')} />
          }
        />
      </Fade>
    </div>
  );
}
