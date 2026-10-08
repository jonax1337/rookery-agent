import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { cappedBadge } from '@/components/blocks/stat-cards';
import { TrendChartCard } from '@/components/blocks/trend-chart-card';
import { EmptyState } from '@/components/common/empty-state';

import { CHART_SERIES, type AssignmentsSummary } from './assignments-summary';
import { SendEmptyIcon } from './send-empty-icon';

/** Runs per day, stacked by their current outcome. */
export function AssignmentsTrendChart({
  chartData,
  basis,
  capped,
}: Pick<AssignmentsSummary, 'chartData' | 'basis' | 'capped'>) {
  return (
    <TrendChartCard
      title="Runs started per day"
      description={
        'Colored by their current outcome; runs still going are not included yet. ' + basis + '.'
      }
      descriptionShort="Created per day"
      data={chartData}
      series={CHART_SERIES}
      {...cappedBadge(capped)}
      empty={
        <Fade>
          <EmptyState
            icon={SendEmptyIcon}
            title="Nothing in this period"
            description="Nothing started during the selected days has finished yet."
            variant="plain"
            size="sm"
          />
        </Fade>
      }
    />
  );
}
