import { PenToolIcon as PencilIcon } from '@/components/icons';
import type { Task } from '@/lib/types';
import { EmptyState } from '@/components/common/empty-state';
import { ResultMarkdown } from '@/components/result-markdown';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** What the task was asked to do, and why the planner split it the way it did. */
export function TaskOverviewTab({ task }: { task: Task }) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Description</CardTitle>
          <CardDescription>The original task description, as entered.</CardDescription>
        </CardHeader>
        <CardContent>
          {task.description.trim() ? (
            <ResultMarkdown text={task.description} />
          ) : (
            <EmptyState
              icon={PencilIcon}
              title="No description"
              description="Without a description, the planner only has the title."
              actionLabel="Edit"
              actionTo={'/tasks/' + task.id + '/edit'}
              variant="plain"
              size="sm"
            />
          )}
        </CardContent>
      </Card>

      {task.planNote ? (
        <Card>
          <CardHeader>
            <CardTitle>Why this plan</CardTitle>
            <CardDescription>The planner’s reasoning for the breakdown and assignee.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResultMarkdown text={task.planNote} />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
