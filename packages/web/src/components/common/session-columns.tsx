import type { ReactNode } from 'react';

import { DetailDrawerTrigger } from '@/components/blocks/detail-drawer';
import { DataTableColumnHeader } from '@/components/blocks/data-table/column-header';
import {
  actionsColumn,
  emptyCell,
  relativeTimeCell,
  selectionColumn,
} from '@/components/blocks/data-table/table-columns';
import type { RookeryColumnDef } from '@/components/blocks/data-table/table-features';
import { createRookeryColumnHelper } from '@/components/blocks/data-table/table-features';
import { ProviderCell } from '@/components/common/provider-cell';
import { Badge } from '@/components/ui/badge';
import { SESSION_KIND_ICON, SESSION_KIND_LABEL, UNTITLED_SESSION } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { Session } from '@/lib/types';

/**
 * The conversation table, defined once.
 *
 * The conversations list and the dashboard's "Zuletzt" tab wrote it twice and
 * disagreed about the words: the kind column said "Sprache"/"Chat" on one page
 * and "Gesprochen"/"Getippt" on the other. The labels now come from
 * `SESSION_KIND_LABEL`. Chat is assistant-only, so there is no counterpart
 * column any more - every row is with the assistant.
 */

export const SESSION_COLUMN_LABELS: Record<string, string> = {
  titel: 'Title',
  art: 'Type',
  anbieter: 'Provider',
  projekt: 'Project',
  nachrichten: 'Messages',
  zuletzt: 'Last updated',
  actions: 'Actions',
};

/** Most recent first. The recency separators only hold in this order. */
export const SESSION_SORTING = [{ id: 'zuletzt', desc: true }];

export interface SessionColumnsOptions {
  /** Prepends the checkbox column. */
  selectable?: boolean;
  /** Makes the title open the drawer. Without it it is plain text. */
  onOpenDetail?(session: Session): void;
  /** Adds the "Projekt" column. Return '' for a conversation without one. */
  projectName?(session: Session): string;
  /** Adds the "Anbieter" column. */
  showProvider?: boolean;
  /** Adds the trailing menu column. */
  rowActions?(session: Session): ReactNode;
}

export function buildSessionColumns(
  options: SessionColumnsOptions,
): RookeryColumnDef<Session>[] {
  const {
    selectable = false,
    onOpenDetail,
    projectName,
    showProvider = false,
    rowActions,
  } = options;

  const column = createRookeryColumnHelper<Session>();
  const columns: RookeryColumnDef<Session>[] = [];

  if (selectable) {
    columns.push(
      selectionColumn<Session>({
        rowLabel: (session) => 'Select ' + (session.title || UNTITLED_SESSION),
      }),
    );
  }

  columns.push(
    column.accessor((session) => session.title || UNTITLED_SESSION, {
      id: 'titel',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Title" />,
      enableHiding: false,
      cell: ({ row, getValue }) => {
        const title = String(getValue());
        const archived = row.original.archived ? (
          <Badge variant="outline" className="ml-2 px-1.5 text-muted-foreground">
            Archived
          </Badge>
        ) : null;

        if (!onOpenDetail) {
          return (
            <div className="max-w-[42ch] truncate font-medium">
              {title}
              {archived}
            </div>
          );
        }
        return (
          <DetailDrawerTrigger onClick={() => onOpenDetail(row.original)}>
            <span className="line-clamp-1">{title}</span>
            {archived}
          </DetailDrawerTrigger>
        );
      },
    }),

    column.accessor((session) => SESSION_KIND_LABEL[session.kind], {
      id: 'art',
      header: ({ column: col }) => <DataTableColumnHeader column={col} title="Type" />,
      cell: ({ row }) => {
        const Icon = SESSION_KIND_ICON[row.original.kind];
        return (
          <Badge variant="outline" className="px-1.5 text-muted-foreground">
            <Icon />
            {SESSION_KIND_LABEL[row.original.kind]}
          </Badge>
        );
      },
    }),
  );

  if (showProvider) {
    columns.push(
      column.accessor((session) => session.provider, {
        id: 'anbieter',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Provider" />,
        cell: ({ row }) => (
          <ProviderCell
            provider={row.original.provider}
            {...(row.original.model ? { model: row.original.model } : {})}
            fallback="Default"
          />
        ),
      }),
    );
  }

  if (projectName) {
    columns.push(
      column.accessor((session) => projectName(session), {
        id: 'projekt',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Project" />,
        cell: ({ getValue }) => {
          const name = String(getValue());
          return name ? (
            <Badge variant="outline" className="font-normal">
              {name}
            </Badge>
          ) : (
            emptyCell()
          );
        },
      }),
    );
  }

  columns.push(
    column.accessor((session) => session.messageCount, {
      id: 'nachrichten',
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Messages" align="end" />
      ),
      cell: ({ row }) => (
        <div className="numeric text-right text-sm">
          {formatNumber(row.original.messageCount)}
        </div>
      ),
    }),

    column.accessor('updatedAt', {
      id: 'zuletzt',
      // Newest first on the first click: nobody opens a conversation list
      // looking for the oldest row.
      sortDescFirst: true,
      header: ({ column: col }) => (
        <DataTableColumnHeader column={col} title="Last updated" align="end" />
      ),
      cell: ({ row }) => relativeTimeCell(row.original.updatedAt, { align: 'end' }),
    }),
  );

  if (rowActions) columns.push(actionsColumn<Session>(rowActions));

  return columns;
}
