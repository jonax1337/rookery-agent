import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { StatCards } from '@/components/blocks/stat-cards';
import { ServerOffline } from '@/components/common/empty-state';

import { AssignmentsTrendChart } from './assignments-trend-chart';
import type { AssignmentsSummary } from './assignments-summary';

/**
 * Headline numbers and the day curve above the table - or, when even the
 * unfiltered window failed to load, the offline notice with its retry.
 */
export function AssignmentsOverview({
  failed,
  summary,
  onRetry,
}: {
  failed: boolean;
  summary: AssignmentsSummary;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <Fade>
        <div className="px-4 lg:px-6">
          <ServerOffline onRetry={onRetry} />
        </div>
      </Fade>
    );
  }

  return (
    <>
      <Fade>
        <StatCards items={summary.cards} />
      </Fade>

      <Fade delay={50}>
        <div className="px-4 lg:px-6">
          <AssignmentsTrendChart
            chartData={summary.chartData}
            basis={summary.basis}
            capped={summary.capped}
          />
        </div>
      </Fade>
    </>
  );
}
