import { EmptyState } from '@/components/common/empty-state';
import { ResultCard } from '@/components/common/result-card';
import { ClipboardEmptyIcon } from '@/pages/tasks/empty-state-icons';

interface TaskResultTabProps {
  result: string;
  onRun(): void;
}

export function TaskResultTab({ result, onRun }: TaskResultTabProps) {
  if (result) return <ResultCard text={result} description="What the run produced." />;

  return (
    <EmptyState
      icon={ClipboardEmptyIcon}
      title="No result yet"
      description="The response will appear here once the task has run."
      actionLabel="Run"
      onAction={onRun}
    />
  );
}
