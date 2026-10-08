import { StatusBadge } from '@/components/common/status-badge';
import type { OrgPerformanceEntry } from '@/lib/types';

/** A healthy agent gets no badge; the cell says so in words instead of staying blank. */
export function StageCell({ stage }: { stage: OrgPerformanceEntry['performance']['stage'] }) {
  if (stage === 0) return <span className="text-muted-foreground">Normal</span>;
  return <StatusBadge kind="agentStage" status={stage} />;
}
