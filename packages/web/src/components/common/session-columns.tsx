import type { ReactNode } from 'react';
import { BotIcon, FeatherIcon } from 'lucide-react';

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
 * and "Gesprochen"/"Getippt" on the other, and a deleted agent was
 * "Unbekannter Agent" here and "Unbekannt" there. The labels now come from
 * `SESSION_KIND_LABEL`, and the counterpart from one cell.
 */

export const SESSION_COLUMN_LABELS: Record<string, string> = {
  titel: 'Title',
  gegenueber: 'Counterpart',
  art: 'Type',
  anbieter: 'Provider',
  projekt: 'Project',
  nachrichten: 'Messages',
  zuletzt: 'Last updated',
  actions: 'Actions',
};

/** Most recent first. The recency separators only hold in this order. */
export const SESSION_SORTING = [{ id: 'zuletzt', desc: true }];

/** An agent that no longer exists. Named, so both tables say the same thing. */
export const UNKNOWN_AGENT = 'Unknown agent';

export interface CounterpartCellProps {
  /** Unset means the conversation is with the assistant. */
  agentId?: string;
  /** The agent's name, already resolved. `undefined` means it is gone. */
  agentName?: string;
  /** What the assistant is called in this installation. */
  assistantName: string;
}

/**
 * Who the conversation is with: an agent, or the assistant itself.
 *
 * The glyph carries the distinction before the name is read - a bot for an
 * agent, the assistant's own feather for the assistant.
 */
export function CounterpartCell({ agentId, agentName, assistantName }: CounterpartCellProps) {
  const name = agentId ? (agentName ?? UNKNOWN_AGENT) : assistantName;
  return (
    <div className="w-36">
      <Badge variant="outline" className="px-1.5 text-muted-foreground">
        {agentId ? <BotIcon /> : <FeatherIcon />}
        <span className="truncate">{name}</span>
      </Badge>
    </div>
  );
}

export interface SessionColumnsOptions {
  /** What the assistant is called; the counterpart of an agent-less session. */
  assistantName: string;
  /** Resolves an agent's name. `undefined` for one that was deleted. */
  agentName(id: string): string | undefined;
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
    assistantName,
    agentName,
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

    column.accessor(
      (session) =>
        session.agentId ? (agentName(session.agentId) ?? UNKNOWN_AGENT) : assistantName,
      {
        id: 'gegenueber',
        header: ({ column: col }) => <DataTableColumnHeader column={col} title="Counterpart" />,
        cell: ({ row }) => (
          <CounterpartCell
            {...(row.original.agentId ? { agentId: row.original.agentId } : {})}
            {...(row.original.agentId
              ? { agentName: agentName(row.original.agentId) ?? UNKNOWN_AGENT }
              : {})}
            assistantName={assistantName}
          />
        ),
      },
    ),

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
        <div className="text-right text-sm tabular-nums">
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
