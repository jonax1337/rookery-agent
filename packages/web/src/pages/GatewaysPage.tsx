import { useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { SquareArrowOutUpRightIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { RadioTower } from '@/components/animate-ui/icons/radio-tower';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import { actionsColumn } from '@/components/blocks/data-table/table-columns';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { usePageMeta } from '@/components/shell/page-meta';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useGateways } from '@/hooks/useGateways';
import { gatewayStateLook } from '@/lib/gateways';
import { formatNumber } from '@/lib/stats';
import type { GatewayStatus } from '@/lib/types';

/**
 * Every chat gateway, as one table.
 *
 * There is exactly one row today - Telegram - but the page never says so in
 * code: it draws whatever `GET /api/gateways` hands back, the same way
 * `ToolsPage` draws whatever the MCP catalogue contains. A second gateway
 * needs a new entry on the server and a detail page of its own; this table
 * needs nothing.
 */

const column = createRookeryColumnHelper<GatewayStatus>();

const COLUMN_LABELS: Record<string, string> = {
  label: 'Name',
  status: 'Status',
  allowedCount: 'Allowed IDs',
  actions: 'Actions',
};

/**
 * The empty-state icon as its animate-ui twin: same 24px silhouette and
 * stroke as the lucide original, but the arcs blink once when the empty
 * state enters the viewport. Needs this shim because `EmptyState` types its
 * `icon` as `LucideIcon` and renders it without any props.
 */
const RadioTowerAnimated = (() => <RadioTower size={24} animateOnView />) as unknown as LucideIcon;

export function GatewaysPage() {
  const navigate = useNavigate();
  const { gateways, loading, error, refresh } = useGateways();

  usePageMeta({ breadcrumb: [{ label: 'Gateways' }] });

  const columns = useMemo(
    () =>
      column.columns([
        column.accessor('label', {
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Name" />,
          cell: ({ row }) => (
            <NavLink to={'/gateways/' + row.original.id} className="font-medium hover:underline">
              {row.original.label}
            </NavLink>
          ),
          enableHiding: false,
        }),

        // Sorted by the caption, so "Aus" and "Läuft" group up like on Tools.
        column.accessor((gateway) => gatewayStateLook(gateway).label, {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Status" />,
          cell: ({ row }) => {
            const look = gatewayStateLook(row.original);
            return (
              <Badge variant={look.variant} className="gap-1">
                {look.icon ? <look.icon className={look.iconClassName} aria-hidden="true" /> : null}
                {look.label}
              </Badge>
            );
          },
        }),

        column.accessor('allowedCount', {
          header: ({ column: col }) => (
            <DataTableColumnHeader column={col} title="Allowed IDs" align="end" />
          ),
          cell: ({ row }) => (
            <span className="block text-right tabular-nums">{formatNumber(row.original.allowedCount)}</span>
          ),
        }),

        actionsColumn<GatewayStatus>((gateway) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Actions for ' + gateway.label} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => void navigate('/gateways/' + gateway.id)}>
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
    <PageBody>
      <Fade>
        <DataTable
          data={gateways}
          columns={columns}
          getRowId={(gateway) => gateway.id}
          idPrefix="gateways"
          onRowClick={(gateway) => void navigate('/gateways/' + gateway.id)}
          rowClickIgnoreColumns={['label', 'actions']}
          columnLabels={COLUMN_LABELS}
          initialSorting={[{ id: 'label', desc: false }]}
          rowLabel={{ singular: 'Gateway', plural: 'Gateways' }}
          loading={loading}
          error={error ? <ServerOffline onRetry={() => void refresh()} /> : undefined}
          // EmptyState brings its own Fade, so no wrapper here - one fade, not two.
          empty={
            <EmptyState
              icon={RadioTowerAnimated}
              title="No gateway configured yet"
              description="A gateway connects the assistant to a channel such as Telegram."
              variant="plain"
              size="sm"
            />
          }
        />
      </Fade>
    </PageBody>
  );
}
