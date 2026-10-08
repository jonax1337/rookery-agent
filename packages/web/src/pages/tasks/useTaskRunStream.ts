import { useCallback, useState } from 'react';
import { toast } from 'sonner';

import type { RookerySocket } from '@/lib/socket';
import type { AssignmentView } from '@/lib/types';
import { useOrgState, useTasksState } from '@/providers/rookery-provider';

interface UseTaskRunStreamOptions {
  taskId: string | undefined;
  socket: RookerySocket;
  /** Re-reads the task's own record once a run has ended. */
  reload(): Promise<void>;
  /** Called when a run is started from this page, before its first event. */
  onStarted(): void;
}

/** Merges a streamed assignment update into the list, appending unseen ones. */
function mergeAssignment(current: AssignmentView[], view: AssignmentView): AssignmentView[] {
  const index = current.findIndex((entry) => entry.id === view.id);
  if (index === -1) return [...current, view];
  const next = [...current];
  next[index] = { ...(next[index] as AssignmentView), ...view };
  return next;
}

/** Runs the task over the socket and holds what the stream says while it goes. */
export function useTaskRunStream({ taskId, socket, reload, onStarted }: UseTaskRunStreamOptions) {
  const tasks = useTasksState();
  const org = useOrgState();

  /** True only while *this page* holds a run's socket stream. */
  const [starting, setStarting] = useState(false);
  const [streamed, setStreamed] = useState<AssignmentView[]>([]);
  const [streamResult, setStreamResult] = useState('');
  const [streamError, setStreamError] = useState<string | null>(null);

  const run = useCallback((): void => {
    if (!taskId) return;
    setStarting(true);
    setStreamed([]);
    setStreamResult('');
    setStreamError(null);
    onStarted();

    socket.sendRunTask(
      { taskId },
      {
        onEvent: (event) => {
          if (event.type === 'assignment') {
            setStreamed((current) => mergeAssignment(current, event.assignment));
          } else if (event.type === 'text') {
            setStreamResult((current) => current + event.delta);
          } else if (event.type === 'error') {
            setStreamError(event.message);
          }
        },
        onDone: (text) => {
          if (text) setStreamResult(text);
          setStarting(false);
          // The finished run belongs in the table below; leaving it in the
          // live list as well would read as two runs having happened.
          setStreamed([]);
          void reload();
          void tasks.refresh();
          void org.refresh();
          toast('Task completed');
        },
        onError: (message) => {
          setStreamError(message);
          setStarting(false);
          toast.error('Run failed', { description: message });
        },
      },
    );
    toast('Task started');
  }, [taskId, onStarted, reload, org, socket, tasks]);

  return { starting, streamed, streamResult, streamError, run };
}
