import { CircleHelpIcon } from '@/components/icons';
import { timeAgo } from '@/lib/format';
import type { TaskEvent } from '@/lib/types';
import { TaskAnswerBox } from '@/components/common/task-answer-box';
import { ResultMarkdown } from '@/components/result-markdown';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface TaskQuestionCardProps {
  taskId: string;
  question: TaskEvent;
  askedBy: string;
  onAnswered(): void;
}

/** The question a blocked task waits on, with the box that answers it. */
export function TaskQuestionCard({ taskId, question, askedBy, onAnswered }: TaskQuestionCardProps) {
  return (
    <Card className="border-amber-500/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleHelpIcon className="size-4 text-amber-500" aria-hidden="true" />
          Waiting for an answer
        </CardTitle>
        <CardDescription>
          {askedBy} asked {timeAgo(question.at)}. Your answer continues the task.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ResultMarkdown text={question.text} />
        <TaskAnswerBox
          key={question.id}
          taskId={taskId}
          askedBy={askedBy}
          onAnswered={onAnswered}
        />
      </CardContent>
    </Card>
  );
}
