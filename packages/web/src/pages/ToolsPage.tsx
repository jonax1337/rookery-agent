import { useMemo, useState } from 'react';
import { NavLink, useNavigate } from 'react-router';

import { PlusIcon, WrenchIcon } from '@/components/icons';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';

import { DataTable } from '@/components/blocks/data-table/data-table';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards, type StatCardProps } from '@/components/blocks/stat-cards';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import { useRemoveTool } from '@/components/common/entity-actions';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTools } from '@/hooks/useTools';
import { formatNumber } from '@/lib/stats';
import type { ToolServer } from '@/lib/types';

import { PrepareOutputDrawer, usePrepareTool, useToggleTool } from './tools/tool-actions';
import { TOOL_COLUMN_LABELS, toolColumns } from './tools/tool-columns';

/**
 * The MCP hub as one table.
 *
 * It is the longest list in the project, so it gets the block's facet tabs,
 * one search over name and description, and a state that is spelled out.
 */

/** Each facet of the table, as the question it asks of a server. */
const TAB_FILTERS = {
  all: () => true,
  active: (tool: ToolServer) => tool.active,
  keys: (tool: ToolServer) => tool.missingEnv.length > 0,
  custom: (tool: ToolServer) => tool.install === 'custom',
  found: (tool: ToolServer) => tool.install === 'external',
} as const;

type Tab = keyof typeof TAB_FILTERS;

const TAB_LABELS: Record<Tab, string> = {
  all: 'All',
  active: 'Active',
  keys: 'Requires keys',
  custom: 'Custom',
  found: 'Found here',
};

const TABS = Object.keys(TAB_FILTERS) as Tab[];

export function ToolsPage() {
  const navigate = useNavigate();
  const { tools, loading, error, refresh, setEnabled, remove, prepare } = useTools();
  const { dialog, removeTool } = useRemoveTool(remove, refresh);
  const toggle = useToggleTool(setEnabled);
  const preparation = usePrepareTool(prepare);

  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');

  usePageMeta({
    breadcrumb: [{ label: 'MCP Tools' }],
    actions: (
      <Button asChild size="sm">
        <NavLink to="/tools/new">
          <PlusIcon data-icon="inline-start" />
          Add custom server
        </NavLink>
      </Button>
    ),
  });

  const columns = useMemo(
    () =>
      toolColumns({
        preparingId: preparation.preparingId,
        onToggle: (tool, on) => void toggle(tool, on),
        onOpen: (tool) => void navigate('/tools/' + tool.id),
        onPrepare: (tool) => void preparation.run(tool),
        onRemove: (tool) => void removeTool(tool),
      }),
    [navigate, preparation.preparingId, preparation.run, removeTool, toggle],
  );

  const counts = useMemo(
    () =>
      Object.fromEntries(
        TABS.map((name) => [name, tools.filter(TAB_FILTERS[name]).length]),
      ) as Record<Tab, number>,
    [tools],
  );

  const rows = useMemo(() => tools.filter(TAB_FILTERS[tab]), [tab, tools]);

  return (
    <PageBody>
      {dialog}

      <Fade>
        <StatCards items={buildToolCards(counts)} />
      </Fade>

      <Fade delay={50}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(tool) => tool.id}
          idPrefix="tools"
          onRowClick={(tool) => void navigate('/tools/' + tool.id)}
          rowClickIgnoreColumns={['select', 'name', 'enabled', 'actions']}
          tabs={TABS.map((name) => ({ value: name, label: TAB_LABELS[name], count: counts[name] }))}
          tab={tab}
          onTabChange={(value) => setTab(value as Tab)}
          tabLabel="Tool selection"
          searchable
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search tools"
          searchText={(tool) => tool.name + ' ' + tool.description + ' ' + tool.id}
          columnLabels={TOOL_COLUMN_LABELS}
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
            <Fade>
              <EmptyState
                icon={WrenchIcon}
                title="No tools in this selection"
                description="There is nothing in this tab right now. The complete catalog is available under “All”."
                actionLabel="Show all"
                onAction={() => {
                  setTab('all');
                  setSearch('');
                }}
                variant="plain"
                size="sm"
              />
            </Fade>
          }
          filteredEmpty={
            <Fade>
              <NoResults query={search.trim() || undefined} onReset={() => setSearch('')} />
            </Fade>
          }
        />
      </Fade>

      <PrepareOutputDrawer result={preparation.result} onDismiss={preparation.dismiss} />
    </PageBody>
  );
}

// Every number rests on `GET /api/tools`, which returns the whole catalogue
// - there is no list limit here, so none of these cards needs a footnote
// about its base the way the paged lists do.
function buildToolCards(counts: Record<Tab, number>): StatCardProps[] {
  return [
    {
      label: 'Active',
      value: <CountingNumber number={counts.active} />,
      headline: 'Of ' + formatNumber(counts.all) + ' in the catalog',
      footnote: 'Enabled, installed, and configured with all required keys',
    },
    {
      label: 'Requires keys',
      value: <CountingNumber number={counts.keys} />,
      badge: counts.keys > 0 ? <Badge variant="destructive">remains disabled</Badge> : undefined,
      headline: counts.keys > 0 ? 'Waiting for credentials' : 'Nothing pending',
    },
    {
      label: 'Found here',
      value: <CountingNumber number={counts.found} />,
      headline: 'Installed in Claude Code',
      footnote: 'Read from ~/.claude; each one runs only once you switch it on',
    },
    {
      label: 'Custom servers',
      value: <CountingNumber number={counts.custom} />,
      headline: 'Added manually',
      to: '/tools',
    },
  ];
}
