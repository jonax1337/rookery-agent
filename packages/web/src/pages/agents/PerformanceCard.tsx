import { CountingNumber } from '@/components/animate-ui/primitives/texts/counting-number';
import { EMPTY_CELL } from '@/components/blocks/data-table/table-columns';
import { TrendIndicator } from '@/components/common/trend-indicator';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AgentPerformance } from '@/lib/types';

/**
 * The rolling average, its trend, the escalation stage and the failure rate
 * kept apart from it - a technical failure rate has nothing to do with
 * quality, so showing it folded into the average would blame an agent for
 * infrastructure (docs/concepts/agent-performance-management.md).
 */
export function PerformanceCard({ performance }: { performance: AgentPerformance }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Performance</CardTitle>
        <CardDescription>
          Rolling average over the last {performance.count} reviews, judged against the role, never against other staff.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <span className="numeric text-3xl font-semibold">
            {performance.average !== null ? (
              <CountingNumber number={performance.average} decimalPlaces={1} />
            ) : (
              EMPTY_CELL
            )}
          </span>
          <span className="text-sm text-muted-foreground">/ 5</span>
          <TrendIndicator trend={performance.trend} />
        </div>
        {performance.average === null ? (
          <p className="text-sm text-muted-foreground">Not enough reviewed runs yet.</p>
        ) : null}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Failure rate (last 20)</span>
          <span className="numeric">
            <CountingNumber number={Math.round(performance.failureRate * 100)} />%
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
