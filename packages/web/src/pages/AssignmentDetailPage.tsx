import { useCallback } from 'react';
import { useParams } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { StatCards } from '@/components/blocks/stat-cards';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { MetaList } from '@/components/common/meta-list';
import { usePageMeta } from '@/components/shell/page-meta';
import { useOrgState } from '@/providers/rookery-provider';

import { AssignmentDetailSkeleton } from './assignments/assignment-detail-skeleton';
import { AssignmentDetailTabs } from './assignments/assignment-detail-tabs';
import { buildDetailCards } from './assignments/assignment-detail-cards';
import { buildDetailFacts } from './assignments/assignment-detail-facts';
import { AssignmentHeaderActions } from './assignments/assignment-header-actions';
import { AssignmentHeading } from './assignments/assignment-heading';
import { isOpenStatus, shortTitle } from './assignments/assignment-row';
import { SendEmptyIcon } from './assignments/send-empty-icon';
import { useAssignmentDetail } from './assignments/use-assignment-detail';

/**
 * One assignment: what was asked, who did it, what came back.
 *
 * The facts used to be a single muted line with `' · '` between them - seven
 * unlabelled fragments that could not be linked and stopped being readable at
 * the fourth. They are a two-column `MetaList` now, the four numbers a
 * `StatCards` row, and result, error and sub-assignments sit behind tabs
 * instead of stacking three cards down the page.
 */
export function AssignmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrgState();
  const { dialog, cancelAssignment } = useCancelAssignment();
  const { detail, loading, missing, loadError, reload, live, reviews, addReview } =
    useAssignmentDetail(id);

  const assignment = detail?.assignment;
  const status = live?.status ?? assignment?.status;
  const open = status !== undefined && isOpenStatus(status);

  const cancel = useCallback((): void => {
    if (id) void cancelAssignment(id);
  }, [cancelAssignment, id]);

  // The same question the stop button asks everywhere else - the child table
  // used to cancel a run without a word.
  const cancelRun = useCallback(
    (runId: string): void => {
      void cancelAssignment(runId);
    },
    [cancelAssignment],
  );

  /**
   * The board task this run belongs to, when one points at it. Comes from the
   * server's `task_assignments` history, not from scanning the currently
   * loaded task list for `assignmentId === id` - that scan broke the moment a
   * task was rerun, since only the newest assignment kept the backlink.
   */
  const taskId = detail?.taskId ?? null;

  const title = assignment ? shortTitle(assignment.title) : 'Run';

  usePageMeta(
    {
      ...(assignment ? { title } : {}),
      breadcrumb: [{ label: 'Runs', to: '/assignments' }, { label: title }],
      actions: assignment ? (
        <AssignmentHeaderActions
          open={open}
          agentId={assignment.agentId}
          taskId={taskId}
          onCancel={cancel}
        />
      ) : null,
    },
    [assignment?.id, open, taskId, cancel, title],
  );

  if (!detail || !assignment || !status) {
    if (loading) return <AssignmentDetailSkeleton />;
    return (
      <PageBody width="3xl">
        <RunUnavailable failed={Boolean(loadError) && !missing} onRetry={() => void reload()} />
      </PageBody>
    );
  }

  const agent = detail.agent ?? org.agentById(assignment.agentId) ?? null;
  const delegated = detail.children;

  return (
    <PageBody width="3xl">
      {dialog}

      <AssignmentHeading assignment={assignment} status={status} agent={agent} />

      <Fade delay={100}>
        <MetaList
          columns={2}
          items={buildDetailFacts({
            assignment,
            agent,
            project: org.projects.find((entry) => entry.id === assignment.projectId),
            requesterAgent: org.agentById(assignment.requesterAgentId),
          })}
        />
      </Fade>

      {/* The stat row brings its own `px-4 lg:px-6`, which would sit on top of
          the measure's padding and shift the cards against everything else. */}
      <Fade delay={150}>
        <StatCards
          items={buildDetailCards({
            assignment,
            status,
            agent,
            // The live view wins where it has something to say: while a run
            // streams, its character count and duration are newer than the
            // stored row.
            chars: live?.chars ?? assignment.chars,
            durationMs: live?.durationMs ?? assignment.durationMs,
            delegatedCount: delegated.length,
          })}
          className="px-0 lg:px-0"
        />
      </Fade>

      <AssignmentDetailTabs
        key={assignment.id}
        assignmentId={assignment.id}
        status={status}
        result={assignment.result ?? ''}
        error={assignment.error ?? live?.error}
        delegated={delegated}
        reviews={reviews}
        onReviewSaved={addReview}
        onCancelRun={cancelRun}
      />
    </PageBody>
  );
}

/** Either the server did not answer (retry makes sense) or the run is gone (it does not). */
function RunUnavailable({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  if (failed) return <ServerOffline onRetry={onRetry} />;

  return (
    <EmptyState
      icon={SendEmptyIcon}
      title="This run does not exist"
      description="The entry was deleted, or the address is incorrect."
      actionLabel="View all runs"
      actionTo="/assignments"
    />
  );
}
