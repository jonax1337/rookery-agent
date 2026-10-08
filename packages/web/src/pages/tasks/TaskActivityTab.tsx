import type { TaskEvent } from '@/lib/types';
import { TaskActivity } from '@/components/common/task-activity';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface TaskActivityTabProps {
  /** `null` until the first fetch answers. */
  events: TaskEvent[] | null;
  highlightId: string | undefined;
}

export function TaskActivityTab({ events, highlightId }: TaskActivityTabProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          Everything that happened on this task, oldest first: runs, questions, answers and status
          changes.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TaskActivity events={events} highlightId={highlightId} />
      </CardContent>
    </Card>
  );
}
