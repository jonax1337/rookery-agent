import { formatNumber } from '@/lib/stats';
import type { ExternalAgentRef, ExternalPluginState, ExternalSource, ToolServerAudience } from '@/lib/types';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { emptyCell } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';

import { AudienceSelect, ChangedBadge } from './approval-controls';

const sourceColumn = createRookeryColumnHelper<ExternalSource>();
const agentColumn = createRookeryColumnHelper<ExternalAgentRef>();

export const SOURCE_COLUMN_LABELS: Record<string, string> = {
  label: 'Source',
  origin: 'Kind',
  skillCount: 'Skills',
  agents: 'Subagents',
  hooks: 'Hooks',
  enabled: 'Skills available',
  loadWhole: 'Whole plugin',
};

export const SUBAGENT_COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'When to use it',
  model: 'Model',
  tools: 'Tools',
  audience: 'Audience',
  enabled: 'Approved',
};

/** How many subagents and hook handlers a shelf brought along. */
export interface SourceTally {
  agents: number;
  hooks: number;
}

interface SourceColumnOptions {
  tallies: ReadonlyMap<string, SourceTally>;
  pluginBySource: ReadonlyMap<string, ExternalPluginState>;
  onToggleSource(source: ExternalSource, on: boolean): void;
  onToggleLoadWhole(plugin: ExternalPluginState, on: boolean): void;
}

/** The second table: one row per shelf found in Claude Code. */
export function sourceColumns({
  tallies,
  pluginBySource,
  onToggleSource,
  onToggleLoadWhole,
}: SourceColumnOptions) {
  return sourceColumn.columns([
    sourceColumn.accessor('label', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
      cell: ({ row }) => <span className="font-medium">{row.original.label}</span>,
      enableHiding: false,
    }),
    sourceColumn.accessor('origin', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Kind" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {row.original.origin === 'home' ? 'Own folder' : 'Plugin'}
        </Badge>
      ),
    }),
    sourceColumn.accessor('skillCount', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Skills" />,
      cell: ({ row }) => formatNumber(row.original.skillCount),
    }),
    sourceColumn.accessor((source) => tallies.get(source.id)?.agents ?? 0, {
      id: 'agents',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Subagents" />,
      cell: ({ row }) => formatNumber(tallies.get(row.original.id)?.agents ?? 0),
    }),
    sourceColumn.accessor((source) => tallies.get(source.id)?.hooks ?? 0, {
      id: 'hooks',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Hooks" />,
      cell: ({ row }) => formatNumber(tallies.get(row.original.id)?.hooks ?? 0),
    }),
    sourceColumn.accessor('enabled', {
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Skills available" />
      ),
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          aria-label={row.original.label + ' skills available'}
          onCheckedChange={(on) => onToggleSource(row.original, on)}
        />
      ),
    }),
    // The whole shelf at once: skills, subagents and hooks of this plugin
    // go into the turn the way Claude Code itself would load them. Only a
    // plugin has a folder to load, so the person's own skills folder
    // shows nothing here.
    sourceColumn.accessor((source) => pluginBySource.get(source.id)?.loadWhole ?? false, {
      id: 'loadWhole',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Whole plugin" />,
      cell: ({ row }) => {
        const plugin = pluginBySource.get(row.original.id);
        if (!plugin) return emptyCell();
        return (
          <div className="flex items-center gap-2">
            <Switch
              checked={plugin.loadWhole}
              aria-label={'Load all of ' + row.original.label}
              onCheckedChange={(on) => onToggleLoadWhole(plugin, on)}
            />
            {plugin.loadWhole && !plugin.active ? <ChangedBadge /> : null}
          </div>
        );
      },
    }),
  ]);
}

interface SubagentColumnOptions {
  sourceLabelOf(sourceId: string): string;
  onSetAudience(agent: ExternalAgentRef, audience: ToolServerAudience): void;
  onApprove(agent: ExternalAgentRef, enabled: boolean): void;
}

/** The third table: one row per subagent type found in those shelves. */
export function subagentColumns({ sourceLabelOf, onSetAudience, onApprove }: SubagentColumnOptions) {
  return agentColumn.columns([
    agentColumn.accessor('name', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    agentColumn.accessor('description', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="When to use it" />,
      cell: ({ row }) => (
        <p className="line-clamp-1 max-w-[28rem] text-muted-foreground">{row.original.description}</p>
      ),
    }),
    agentColumn.accessor((agent) => sourceLabelOf(agent.sourceId), {
      id: 'source',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Source" />,
      cell: ({ row }) => (
        <Badge variant="outline" className="font-normal text-muted-foreground">
          {sourceLabelOf(row.original.sourceId)}
        </Badge>
      ),
    }),
    agentColumn.accessor((agent) => agent.model ?? '', {
      id: 'model',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Model" />,
      cell: ({ row }) => row.original.model ?? emptyCell(),
    }),
    agentColumn.accessor((agent) => (agent.tools ?? []).join(', '), {
      id: 'tools',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Tools" />,
      cell: ({ row }) =>
        row.original.tools?.length ? (
          <p className="line-clamp-1 max-w-[16rem] text-muted-foreground">
            {row.original.tools.join(', ')}
          </p>
        ) : (
          emptyCell()
        ),
    }),
    agentColumn.accessor('audience', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Audience" />,
      cell: ({ row }) => (
        <AudienceSelect
          value={row.original.audience}
          label={'Audience for ' + row.original.name}
          onChange={(audience) => onSetAudience(row.original, audience)}
        />
      ),
    }),
    agentColumn.accessor('enabled', {
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Approved" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <Switch
            checked={row.original.enabled}
            aria-label={'Approve ' + row.original.name}
            onCheckedChange={(on) => onApprove(row.original, on)}
          />
          {/* Approved once, and the file has moved on since: the approval
              stands but nothing is handed over until somebody looks. */}
          {row.original.enabled && !row.original.active ? <ChangedBadge /> : null}
        </div>
      ),
    }),
  ]);
}
