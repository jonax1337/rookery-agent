import type { ReactNode } from 'react';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import type { AgentAction, AgentDetail, AgentPerformance } from '@/lib/types';

import { AgentFacts } from './AgentFacts';
import { AgentHeaderLine } from './AgentHeaderLine';
import { AgentStatCards } from './AgentStatCards';
import { AgentTabs } from './AgentTabs';
import { AgentWorkLines } from './AgentWorkLines';
import { AssignmentDrawer } from './AssignmentDrawer';
import { HandoverCard } from './HandoverCard';
import { PerformanceCard } from './PerformanceCard';
import { PersonnelRecordCard } from './PersonnelRecordCard';
import { ReconfigProposalCard } from './ReconfigProposalCard';
import { ReplacementProposalCard } from './ReplacementProposalCard';
import type { AgentAssignmentHandle } from './useAgentAssignment';

/** The escalation stage at which a successor is drafted and a person has to confirm. */
const REPLACEMENT_PROPOSAL_STAGE = 3;

/**
 * Only the newest pending proposal ever matters: stage 3 with a `probation`
 * action on top means nothing since has moved the agent on.
 */
function findPendingReplacement(
  performance: AgentPerformance,
  actions: AgentAction[],
): AgentAction | undefined {
  const newest = actions[0];
  return performance.stage === REPLACEMENT_PROPOSAL_STAGE && newest?.kind === 'probation'
    ? newest
    : undefined;
}

/** A block of the page that fades in and keeps the page's side gutters. */
function GutteredFade({ delay, children }: { delay: number; children: ReactNode }) {
  return (
    <Fade delay={delay}>
      <div className="px-4 lg:px-6">{children}</div>
    </Fade>
  );
}

/**
 * One member of staff: who they are, what they are working on, what they know.
 *
 * The facts sit in a `MetaList`, the four numbers in `StatCards`, the four
 * lists behind tabs over one `DataTable`, and the assignment lives in a
 * drawer - the stream stays inside it and the page underneath does not move.
 */
export function AgentDetailBody({
  detail,
  assignment,
  onChanged,
}: {
  detail: AgentDetail;
  assignment: AgentAssignmentHandle;
  /** A proposal was decided: the record on screen is out of date. */
  onChanged: () => void;
}) {
  const { agent, performance, actions, handover, predecessor, pendingReconfig } = detail;
  const pendingReplacement = findPendingReplacement(performance, actions);

  return (
    <PageBody>
      <Fade>
        <AgentHeaderLine detail={detail} />
      </Fade>

      <GutteredFade delay={50}>
        <AgentFacts agent={agent} />
      </GutteredFade>

      <Fade delay={100}>
        <AgentStatCards assignments={detail.assignments} memories={detail.memories} />
      </Fade>

      <Fade delay={150}>
        <div className="grid gap-4 px-4 lg:px-6 lg:grid-cols-2">
          <PerformanceCard performance={performance} />
          <PersonnelRecordCard actions={actions} />
        </div>
      </Fade>

      {handover ? (
        <GutteredFade delay={150}>
          <HandoverCard text={handover} predecessorName={predecessor?.name} />
        </GutteredFade>
      ) : null}

      {/* A proposal card seeds its form once; the key restarts it for a newer proposal. */}
      {pendingReconfig ? (
        <GutteredFade delay={150}>
          <ReconfigProposalCard
            key={pendingReconfig.id}
            agent={agent}
            action={pendingReconfig}
            onDecided={onChanged}
          />
        </GutteredFade>
      ) : null}

      {pendingReplacement ? (
        <GutteredFade delay={150}>
          <ReplacementProposalCard
            key={pendingReplacement.id}
            agent={agent}
            action={pendingReplacement}
            onDecided={onChanged}
          />
        </GutteredFade>
      ) : null}

      <AgentWorkLines agent={agent} />

      <Fade delay={250} className="px-4 lg:px-6">
        <AgentTabs detail={detail} onAssign={() => assignment.setOpen(true)} />
      </Fade>

      <AssignmentDrawer agent={agent} assignment={assignment} />
    </PageBody>
  );
}
