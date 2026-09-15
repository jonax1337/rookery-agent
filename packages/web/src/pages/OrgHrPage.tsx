import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  ChevronRightIcon,
  MinusIcon,
  SquareArrowOutUpRightIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { LucideIcon, LucideProps } from 'lucide-react';

import { api } from '@/lib/api';
import type { OrgPerformanceEntry } from '@/lib/types';
import { usePageMeta } from '@/components/shell/page-meta';
import { UsersIcon } from '@/components/animate-ui/icons/users';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { actionsColumn, emptyCell } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { StatusBadge } from '@/components/common/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * "Personalabteilung": every agent's standing in one table, same shell as
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
  const Icon = trend > 0.05 ? TrendingUpIcon : trend < -0.05 ? TrendingDownIcon : MinusIcon;
  const tone =
    trend > 0.05 ? 'text-emerald-600 dark:text-emerald-400' : trend < -0.05 ? 'text-destructive' : 'text-muted-foreground';
  return (
    <span className={'flex items-center justify-end gap-1 tabular-nums ' + tone}>
      <Icon className="size-3.5" />
      {(trend >= 0 ? '+' : '') + trend.toFixed(1)}
    </span>
  );
}

/**
 * `EmptyState` expects a lucide component; this bridges to the animated
 * users icon so the empty table's symbol bounces in on view.
 */
const UsersEmptyIcon = (() => <UsersIcon animateOnView size={24} />) as unknown as LucideIcon;

export function OrgHrPage() {
  usePageMeta({ title: 'HR' }, []);
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
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TriangleAlertIcon className="size-4 text-destructive" />
                  {proposals.length === 1 ? (
                    'One replacement proposed'
                  ) : (
                    <span>
                      <CountingNumber number={proposals.length} /> replacements proposed
                    </span>
                  )}
                </CardTitle>
                <CardDescription>
                  Review the successor draft and approve or adjust it on the agent&apos;s own page.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {proposals.map((row) => (
                  <NavLink
                    key={row.agent.id}
                    to={'/org/agents/' + row.agent.id}
                    className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-accent"
                  >
                    <span>
                      <span className="font-medium">{row.agent.name}</span>
                      <span className="text-muted-foreground"> · {row.agent.title}</span>
                    </span>
                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                  </NavLink>
                ))}
              </CardContent>
            </Card>
          </div>
        </Fade>
      ) : null}

      <Fade delay={50}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.agent.id}
          idPrefix="hr"
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
