import { useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { RadioTowerIcon, SquareArrowOutUpRightIcon } from 'lucide-react';

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
  status: 'Zustand',
  allowedCount: 'Erlaubte IDs',
  actions: 'Aktionen',
};

export function GatewaysPage() {
  const navigate = useNavigate();
  const { gateways, loading, error, refresh } = useGateways();

  usePageMeta({ breadcrumb: [{ label: 'Gateway' }] });

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

        // Sorted by the caption, so "Aus" and "Läuft" group up like on Werkzeuge.
        column.accessor((gateway) => gatewayStateLook(gateway).label, {
          id: 'status',
          header: ({ column: col }) => <DataTableColumnHeader column={col} title="Zustand" />,
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
            <DataTableColumnHeader column={col} title="Erlaubte IDs" align="end" />
          ),
          cell: ({ row }) => (
            <span className="block text-right tabular-nums">{formatNumber(row.original.allowedCount)}</span>
          ),
        }),

        actionsColumn<GatewayStatus>((gateway) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <RowMenuButton label={'Aktionen für ' + gateway.label} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => void navigate('/gateways/' + gateway.id)}>
                <SquareArrowOutUpRightIcon />
                Öffnen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )),
      ]),
    [navigate],
  );

  return (
    <PageBody>
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
        empty={
          <EmptyState
            icon={RadioTowerIcon}
            title="Noch kein Gateway eingerichtet"
            description="Ein Gateway verbindet den Assistenten mit einem Kanal wie Telegram."
            variant="plain"
            size="sm"
          />
        }
      />
    </PageBody>
  );
}
