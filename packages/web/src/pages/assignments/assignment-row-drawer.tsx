import type { ReactNode } from 'react';

import { BanIcon } from '@/components/icons';
import { DetailDrawer, useDrawerSubject } from '@/components/blocks/detail-drawer';
import { AssignmentTerminal } from '@/components/common/assignment-terminal';
import { MetaList, type MetaItem } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { StatusBadge } from '@/components/common/status-badge';
import { ResultMarkdown } from '@/components/result-markdown';
import { Button } from '@/components/ui/button';
import { formatDuration, relativeTime, shorten } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';

import { isOpenStatus, type AssignmentRow } from './assignment-row';

const DRAWER_TITLE_LENGTH = 80;

/** What the row drawer shows: the whole record, without leaving the table. */
export function AssignmentRowDrawer({
  row: chosen,
  onOpenChange,
  onOpen,
  onCancel,
}: {
  row: AssignmentRow | null;
  onOpenChange: (open: boolean) => void;
  onOpen: (id: string) => void;
  onCancel: (row: AssignmentRow) => void;
}) {
  // The row stays until the drawer has slid shut, so `open` reports the real
  // state instead of a hard-wired `true`.
  const row = useDrawerSubject(chosen);
  if (!row) return null;

  return (
    <DetailDrawer
      open={chosen !== null}
      onOpenChange={onOpenChange}
      title={shorten(row.title, DRAWER_TITLE_LENGTH)}
      description={row.agentName + ' · ' + relativeTime(row.createdAt)}
      footer={
        <div className="flex flex-wrap gap-2">
          <Button className="flex-1" onClick={() => onOpen(row.id)}>
            Open assignment
          </Button>
          {isOpenStatus(row.status) ? (
            <Button variant="outline" onClick={() => onCancel(row)}>
              <BanIcon data-icon="inline-start" />
              Cancel
            </Button>
          ) : null}
        </div>
      }
    >
      {row.status === 'running' ? (
        // The run is happening now, one drawer away from the table: watch it
        // live instead of waiting for the row to change. No status override -
        // the terminal reads `org.live`, which keeps moving after the table's
        // copy was taken. Live-only: the moment the run ends, the buffer is
        // gone and this collapses to the facts below.
        <AssignmentTerminal assignmentId={row.id} />
      ) : null}

      <MetaList columns={1} items={rowFacts(row)} />

      {/* The whole brief stays here, only rendered: what an agent was told
          is written in markdown, and `##` in plain sight is a display bug. */}
      <DrawerSection label="Brief">
        <ResultMarkdown text={row.task} preview />
      </DrawerSection>

      {row.error ? (
        <DrawerSection label="Error">
          {/* Paragraphs keep their line breaks: a stack trace is markdown
              too, but its shape carries as much as its words. */}
          <ResultMarkdown
            text={row.error}
            preview
            className="text-destructive [&_p]:whitespace-pre-wrap"
          />
        </DrawerSection>
      ) : null}
    </DetailDrawer>
  );
}

function rowFacts(row: AssignmentRow): MetaItem[] {
  return [
    { label: 'Status', value: <StatusBadge kind="assignment" status={row.status} /> },
    { label: 'Agent', value: row.agentName, to: '/org/agents/' + row.agentId },
    {
      label: 'Provider',
      value: row.provider ? (
        <ProviderCell
          provider={row.provider}
          {...(row.model ? { model: row.model } : {})}
          layout="inline"
        />
      ) : null,
    },
    { label: 'Characters', value: row.chars > 0 ? formatNumber(row.chars) : null },
    { label: 'Duration', value: formatDuration(row.durationMs) || null },
    { label: 'Level', value: row.depth > 0 ? String(row.depth) : null },
    { label: 'Created', value: formatDateTime(row.createdAt) },
  ];
}

function DrawerSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
