import { Badge } from '@/components/ui/badge';
import { TabsList, TabsTrigger } from '@/components/ui/tabs';

export type TaskTab = 'overview' | 'activity' | 'subtasks' | 'runs' | 'result';

interface TaskTabListProps {
  hasOpenQuestion: boolean;
  subtaskCount: number;
  runCount: number;
  openRunCount: number;
}

export function TaskTabList({
  hasOpenQuestion,
  subtaskCount,
  runCount,
  openRunCount,
}: TaskTabListProps) {
  return (
    <TabsList>
      <TabsTrigger value="overview">Overview</TabsTrigger>
      {/* A case is one page, not two: what was asked and answered
          about it belongs next to the task, not behind a link. */}
      <TabsTrigger value="activity">
        Activity
        {hasOpenQuestion ? <CountBadge>1</CountBadge> : null}
      </TabsTrigger>
      <TabsTrigger value="subtasks">
        Subtasks
        {subtaskCount > 0 ? <CountBadge>{subtaskCount}</CountBadge> : null}
      </TabsTrigger>
      <TabsTrigger value="runs">
        Runs
        {openRunCount > 0 ? (
          <CountBadge pulsing>{openRunCount}</CountBadge>
        ) : runCount > 0 ? (
          <CountBadge>{runCount}</CountBadge>
        ) : null}
      </TabsTrigger>
      <TabsTrigger value="result">Result</TabsTrigger>
    </TabsList>
  );
}

function CountBadge({ children, pulsing }: { children: number | string; pulsing?: boolean }) {
  return (
    <Badge variant="secondary" className={pulsing ? 'animate-pulse tabular-nums' : 'tabular-nums'}>
      {children}
    </Badge>
  );
}
