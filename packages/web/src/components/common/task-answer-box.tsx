import { useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { failureMessage } from '@/lib/errors';
import type { Task } from '@/lib/types';
import { cn } from '@/lib/utils';
import { SendIcon } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * The answer to a blocked card's question, as the user gives it.
 *
 * One component for both doors to it - the notification that asked and the
 * card's own Activity tab - so the answer goes the same way from either:
 * `POST /api/org/tasks/:id/answer`, which records it on the card and runs the
 * task on. A refusal (the card is not waiting any more, it is running) is
 * shown under the field rather than only as a toast, because the field is
 * still there and the reader needs to know why nothing happened.
 */

export interface TaskAnswerBoxProps {
  taskId: string;
  /** Who is waiting on it, for the placeholder ("Answer Mara…"). */
  askedBy?: string | undefined;
  onAnswered?: ((task: Task) => void) | undefined;
  className?: string;
}

export function TaskAnswerBox({ taskId, askedBy, onAnswered, className }: TaskAnswerBoxProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState(false);

  const submit = async (): Promise<void> => {
    const answer = draft.trim();
    if (!answer || sending) return;
    setSending(true);
    setError(null);
    try {
      const { task } = await api.answerTask(taskId, answer);
      setDraft('');
      setAnswered(true);
      toast('Answer sent', { description: 'The task continues with your answer.' });
      onAnswered?.(task);
    } catch (caught) {
      setError(failureMessage(caught));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn('grid gap-3', className)}>
      <Textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          if (answered) setAnswered(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={askedBy ? 'Answer ' + askedBy + '…' : 'Write your answer…'}
        className="min-h-20 resize-none p-4"
        aria-invalid={error ? true : undefined}
      />
      <div className="flex items-center gap-2">
        <span
          className={cn('min-w-0 truncate text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
          role={error ? 'alert' : undefined}
        >
          {error ?? (answered ? 'Answer sent - the task runs on.' : 'Your answer continues the task.')}
        </span>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => void submit()}
          disabled={sending || !draft.trim()}
        >
          <SendIcon />
          Answer
        </Button>
      </div>
    </div>
  );
}
