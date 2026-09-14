import { useCallback, useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import {
  DownloadIcon,
  ExternalLinkIcon,
  PlusIcon,
  RotateCcwIcon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  WrenchIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards } from '@/components/blocks/stat-cards';
import type { StatCardProps } from '@/components/blocks/stat-cards';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { useRemoveTool } from '@/components/common/entity-actions';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { useTools } from '@/hooks/useTools';
import { failureMessage, reportFailure } from '@/lib/errors';
import { AUDIENCE_LABEL, INSTALL_LABEL, toolStatus, toolStatusLook } from '@/lib/tools';
import { formatNumber } from '@/lib/stats';
import type { ToolServer } from '@/lib/types';

/**
 * The MCP hub as one table.
 *
 * The page used to be two Cards - "Katalog" and "Custom servers" - with no
 * shared filter, no search and a bare coloured dot for the state. It is the
 * longest list in the project, so it gets the block's facet tabs, one search
 * over name and description, and a state that is spelled out.
 */

const column = createRookeryColumnHelper<ToolServer>();

const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  status: 'Status',
  audience: 'Audience',
  install: 'Source',
  enabled: 'Active',
  actions: 'Actions',
};

type Tab = 'alle' | 'aktiv' | 'schluessel' | 'eigene' | 'gefunden';

/** What a finished preparation had to say, held for the drawer. */
interface PrepareResult {
  tool: ToolServer;
  ok: boolean;
  output: string;
}

export function ToolsPage() {
  const navigate = useNavigate();
  const { tools, loading, error, refresh, setEnabled, remove, prepare } = useTools();
  const { dialog, removeTool } = useRemoveTool(remove, refresh);

  const [tab, setTab] = useState<Tab>('alle');
  const [search, setSearch] = useState('');
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);

  usePageMeta({
    breadcrumb: [{ label: 'Tools' }],
    actions: (
      <Button asChild size="sm">
        <NavLink to="/tools/new">
          <PlusIcon data-icon="inline-start" />
          Add custom server
        </NavLink>
      </Button>
    ),
  });

  const toggle = useCallback(
    async (tool: ToolServer, on: boolean): Promise<void> => {
      try {
        await setEnabled(tool.id, on);
        toast(tool.name + (on ? ' enabled' : ' disabled'));
      } catch (caught) {
        reportFailure('Update', caught);
      }
    },
    [setEnabled],
  );

  const runPrepare = useCallback(
    async (tool: ToolServer): Promise<void> => {
      setPreparingId(tool.id);
      try {
        const outcome = await prepare(tool.id);
        setResult({ tool, ok: outcome.ok, output: outcome.output });
      } catch (caught) {
        // The panel prints this verbatim, so a stopped server has to reach it
        // as a sentence rather than as the browser's "Failed to fetch".
        setResult({ tool, ok: false, output: failureMessage(caught) });
      } finally {
        setPreparingId(null);
      }
    },
    [prepare],
  );

  const columns = useMemo(
    () =>
      column.columns([
        selectionColumn<ToolServer>({ rowLabel: (tool) => tool.name + ' selected' }),

        column.accessor('name', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
          cell: ({ row }) => (
            <div className="min-w-0 max-w-[24rem]">
              <NavLink
                to={'/tools/' + row.original.id}
                className="font-medium hover:underline"
              >
                {row.original.name}
              </NavLink>
              <p className="line-clamp-1 text-xs text-muted-foreground">
                {row.original.description}
              </p>
            </div>
          ),
          enableHiding: false,
        }),

        // Sorted by the caption, so "Keys missing" and "Bereit" group up.
        column.accessor((tool) => toolStatus(tool).label, {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
          cell: ({ row }) => {
            const look = toolStatusLook(row.original);
            return (
              <Badge variant={look.variant} className="gap-1">
                {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
                {look.label}
              </Badge>
            );
          },
        }),

        column.accessor('audience', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Audience" />,
          cell: ({ row }) => (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {AUDIENCE_LABEL[row.original.audience]}
            </Badge>
          ),
        }),

        column.accessor('install', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
          // A discovered server names the installation it came from: "Claude
          // Code - vercel" says more than "already installed here" does.
          cell: ({ row }) => (
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {row.original.source || INSTALL_LABEL[row.original.install]}
            </Badge>
          ),
        }),

        column.accessor('enabled', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Active" />,
          cell: ({ row }) => (
            <Switch
              checked={row.original.enabled}
              disabled={!row.original.installed}
              aria-label={row.original.name + ' enable'}
              onCheckedChange={(on) => void toggle(row.original, on)}
            />
          ),
        }),

        actionsColumn<ToolServer>((tool) => {
          const busy = preparingId === tool.id;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <RowMenuButton label={'Actions for ' + tool.name} busy={busy} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => void navigate('/tools/' + tool.id)}>
                  <SquareArrowOutUpRightIcon />
                  Open
                </DropdownMenuItem>
                {tool.prepare ? (
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={(event) => {
                      event.preventDefault();
                      void runPrepare(tool);
                    }}
                  >
                    <DownloadIcon />
                    {tool.prepare.label}
                  </DropdownMenuItem>
                ) : null}
                {tool.homepage ? (
                  <DropdownMenuItem asChild>
                    <a href={tool.homepage} target="_blank" rel="noreferrer">
                      <ExternalLinkIcon />
                      Open project page
                    </a>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                {tool.install === 'custom' ? (
                  <DropdownMenuItem variant="destructive" onSelect={() => void removeTool(tool)}>
                    <Trash2Icon />
                    Remove
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => void removeTool(tool)}>
                    <RotateCcwIcon />
                    Restore default
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        }),
      ]),
    [navigate, preparingId, removeTool, runPrepare, toggle],
  );

  const counts = useMemo(
    () => ({
      alle: tools.length,
      aktiv: tools.filter((tool) => tool.active).length,
      schluessel: tools.filter((tool) => tool.missingEnv.length > 0).length,
      eigene: tools.filter((tool) => tool.install === 'custom').length,
      nichtInstalled: tools.filter((tool) => !tool.installed).length,
      gefunden: tools.filter((tool) => tool.install === 'external').length,
    }),
    [tools],
  );

  const rows = useMemo(() => {
    switch (tab) {
      case 'aktiv':
        return tools.filter((tool) => tool.active);
      case 'schluessel':
        return tools.filter((tool) => tool.missingEnv.length > 0);
      case 'eigene':
        return tools.filter((tool) => tool.install === 'custom');
      case 'gefunden':
        return tools.filter((tool) => tool.install === 'external');
      default:
        return tools;
    }
  }, [tab, tools]);

  // Every number rests on `GET /api/tools`, which returns the whole catalogue
  // - there is no list limit here, so none of these cards needs a footnote
  // about its base the way the paged lists do.
  const cards: StatCardProps[] = [
    {
      label: 'Active',
      value: formatNumber(counts.aktiv),
      headline: 'Of ' + formatNumber(counts.alle) + ' in the catalog',
      footnote: 'Enabled, installed, and configured with all required keys',
    },
    {
      label: 'Requires keys',
      value: formatNumber(counts.schluessel),
      badge:
        counts.schluessel > 0 ? <Badge variant="destructive">remains disabled</Badge> : undefined,
      headline: counts.schluessel > 0 ? 'Waiting for credentials' : 'Nothing pending',
    },
    {
      label: 'Found here',
      value: formatNumber(counts.gefunden),
      headline: 'Installed in Claude Code',
      footnote: 'Read from ~/.claude; each one runs only once you switch it on',
    },
    {
      label: 'Custom servers',
      value: formatNumber(counts.eigene),
      headline: 'Added manually',
      to: '/tools',
    },
  ];

  return (
    <PageBody>
      {dialog}

      <StatCards items={cards} />

      <DataTable
        data={rows}
        columns={columns}
        getRowId={(tool) => tool.id}
        idPrefix="werkzeuge"
        onRowClick={(tool) => void navigate('/tools/' + tool.id)}
        rowClickIgnoreColumns={['select', 'name', 'enabled', 'actions']}
        tabs={[
          { value: 'alle', label: 'All', count: counts.alle },
          { value: 'aktiv', label: 'Active', count: counts.aktiv },
          { value: 'schluessel', label: 'Requires keys', count: counts.schluessel },
          { value: 'eigene', label: 'Custom', count: counts.eigene },
          { value: 'gefunden', label: 'Found here', count: counts.gefunden },
        ]}
        tab={tab}
        onTabChange={(value) => setTab(value as Tab)}
        tabLabel="Tool selection"
        searchable
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Tools durchsuchen"
        searchText={(tool) => tool.name + ' ' + tool.description + ' ' + tool.id}
        columnLabels={COLUMN_LABELS}
        initialSorting={[{ id: 'name', desc: false }]}
        rowLabel={{ singular: 'Tool', plural: 'tools' }}
        loading={loading}
        error={error ? <ServerOffline onRetry={() => void refresh()} /> : undefined}
        bulkActions={(selected, clear) => (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                for (const tool of selected) {
                  if (tool.installed && !tool.enabled) void toggle(tool, true);
                }
                clear();
              }}
            >
              Enable
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                for (const tool of selected) {
                  if (tool.enabled) void toggle(tool, false);
                }
                clear();
              }}
            >
              Disable
            </Button>
          </>
        )}
        empty={
          <EmptyState
            icon={WrenchIcon}
            title="No tools in this selection"
            description="There is nothing in this tab right now. The complete catalog is available under “All”."
            actionLabel="Show all"
            onAction={() => {
              setTab('alle');
              setSearch('');
            }}
            variant="plain"
            size="sm"
          />
        }
        filteredEmpty={
          <NoResults
            {...(search.trim() ? { query: search.trim() } : {})}
            onReset={() => setSearch('')}
          />
        }
      />

      {/* The preparation can print a whole npm log; a toast would swallow it. */}
      <DetailDrawer
        open={result !== null}
        onOpenChange={(open) => {
          if (!open) setResult(null);
        }}
        title={result ? result.tool.name + ' set up' : 'Setup'}
        description={
          result ? (result.ok ? 'Completed.' : 'Failed.') : undefined
        }
      >
        <pre className="rounded-lg bg-muted/60 p-3 font-mono text-xs whitespace-pre-wrap">
          {result?.output.trim() || 'No output.'}
        </pre>
      </DetailDrawer>
    </PageBody>
  );
}
