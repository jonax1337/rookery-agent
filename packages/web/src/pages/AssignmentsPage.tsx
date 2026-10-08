import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { SendIcon } from '@/components/icons';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { usePageMeta } from '@/components/shell/page-meta';
import { Button } from '@/components/ui/button';
import { useStatsTotals } from '@/hooks/useStatsTotals';
import { useConnection, useOrgState } from '@/providers/rookery-provider';

import { AgentFilter } from './assignments/agent-filter';
import { AssignAgentDrawer } from './assignments/assign-agent-drawer';
import {
  ASSIGNMENT_COLUMN_LABELS,
  ASSIGNMENT_HIDDEN_COLUMNS,
  ASSIGNMENT_ROW_LABEL,
  ASSIGNMENT_SORTING,
  buildAssignmentColumns,
} from './assignments/assignment-columns';
import { AssignmentRowDrawer } from './assignments/assignment-row-drawer';
import type { AssignmentRow } from './assignments/assignment-row';
import { buildDataTableTabs, DEFAULT_TAB, statusFilterOf } from './assignments/assignment-tabs';
import { AssignmentsOverview } from './assignments/assignments-overview';
import { useAssignmentsSummary } from './assignments/assignments-summary';
import { BulkCancelButton } from './assignments/bulk-cancel-button';
import { SendEmptyIcon } from './assignments/send-empty-icon';
import { useAssignmentRows } from './assignments/use-assignment-rows';
import { ASSIGNMENT_LIMIT, useAssignmentsData } from './assignments/use-assignments-data';

const TABLE_PAGE_SIZE = 20;

/**
 * Every single run an agent was ever asked to do.
 *
 * The page is the full `dashboard-01` triple - headline numbers, a stacked
 * day curve, one big table - because assignments are the one thing in this
 * app that exists in the thousands and carries a status, a duration and a
 * size. Everything a card or a curve shows rests on the same loaded window,
 * and each of them says so.
 *
 * Two honesty rules shape what is here. Nothing claims a total the API cannot
 * prove: the only real totals come from `GET /api/stats`, everything else
 * names the latest runs it is based on in its footnote and wears "capped"
 * once the list hangs exactly at the cap. And the cards that count states
 * count them over the *unfiltered* window, never over whatever the status tab
 * narrowed the request to - otherwise "Completed" would read 500 on the
 * "Done" tab.
 */
export function AssignmentsPage() {
  const navigate = useNavigate();
  const { socket } = useConnection();
  const org = useOrgState();
  // One confirmation for all six places in the app that can cancel a run -
  // including the bulk action below, which used to be the only one that
  // did not ask.
  const { dialog, cancelAssignment, cancelAssignments } = useCancelAssignment();
  const totals = useStatsTotals(socket);

  const [tab, setTab] = useState(DEFAULT_TAB);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [detailRow, setDetailRow] = useState<AssignmentRow | null>(null);

  const { base, baseState, list, listState, retry, refresh } = useAssignmentsData(
    { status: statusFilterOf(tab), agentId },
    org.live,
  );
  const rows = useAssignmentRows(list);
  const summary = useAssignmentsSummary({
    base,
    live: org.live,
    running: org.running.length,
    totals,
  });

  const cancel = useCallback(
    (row: AssignmentRow): void => {
      void cancelAssignment(row.id);
    },
    [cancelAssignment],
  );

  const columns = useMemo(
    () => buildAssignmentColumns({ onOpenDetail: setDetailRow, onCancel: cancel }),
    [cancel],
  );

  const agentOptions = useMemo(
    () =>
      org.agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name })),
    [org.agents],
  );

  usePageMeta({
    breadcrumb: [{ label: 'Runs' }],
    actions: (
      <Button size="sm" onClick={() => setAssignOpen(true)}>
        {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
        <SendIcon data-icon="inline-start" />
        Assign agent
      </Button>
    ),
  });

  return (
    <PageBody>
      {dialog}

      <AssignmentsOverview failed={baseState === 'error'} summary={summary} onRetry={retry} />

      <Fade delay={100}>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          tabs={buildDataTableTabs(summary.counts, base.length, summary.capped)}
          tab={tab}
          onTabChange={setTab}
          tabLabel="Status"
          searchable
          searchPlaceholder="Search runs"
          searchText={(row) => row.title + ' ' + row.task}
          filters={<AgentFilter options={agentOptions} value={agentId} onChange={setAgentId} />}
          columnLabels={ASSIGNMENT_COLUMN_LABELS}
          initialSorting={ASSIGNMENT_SORTING}
          initialColumnVisibility={ASSIGNMENT_HIDDEN_COLUMNS}
          pageSize={TABLE_PAGE_SIZE}
          capped={list.length >= ASSIGNMENT_LIMIT}
          rowLabel={ASSIGNMENT_ROW_LABEL}
          loading={listState === 'loading' && rows.length === 0}
          idPrefix="assignments"
          // The whole row opens the drawer, as on /chats and /tasks; the
          // checkbox and menu columns are shielded by the table itself.
          onRowClick={setDetailRow}
          bulkActions={(selected, clearSelection) => (
            <BulkCancelButton
              selected={selected}
              clearSelection={clearSelection}
              cancelAssignments={cancelAssignments}
            />
          )}
          error={listState === 'error' ? <ServerOffline onRetry={retry} size="sm" /> : undefined}
          empty={
            <Fade>
              <EmptyState
                icon={SendEmptyIcon}
                title="Nothing has run yet"
                description="Each agent run appears here with its result, duration, and reported usage."
                actionLabel="Assign agent"
                onAction={() => setAssignOpen(true)}
                variant="plain"
                size="sm"
              />
            </Fade>
          }
        />
      </Fade>

      <AssignAgentDrawer
        open={assignOpen}
        onOpenChange={setAssignOpen}
        agents={org.agents}
        projects={org.projects.filter((project) => !project.archived)}
        onAssigned={refresh}
        assign={(payload, handlers) => socket.sendAssign(payload, handlers)}
      />

      <AssignmentRowDrawer
        row={detailRow}
        onOpenChange={(open) => {
          if (!open) setDetailRow(null);
        }}
        onOpen={(id) => {
          setDetailRow(null);
          void navigate('/assignments/' + id);
        }}
        onCancel={cancel}
      />
    </PageBody>
  );
}
