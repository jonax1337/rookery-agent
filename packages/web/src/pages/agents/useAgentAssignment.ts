import { useState } from 'react';
import { toast } from 'sonner';

import { NO_PROJECT } from '@/lib/format';
import type { Agent } from '@/lib/types';
import { useConnection } from '@/providers/rookery-provider';

export interface AgentAssignmentHandle {
  open: boolean;
  setOpen(open: boolean): void;
  task: string;
  setTask(task: string): void;
  projectId: string;
  setProjectId(projectId: string): void;
  busy: boolean;
  /** What the run said so far, or all of it once it is done. */
  result: string;
  error: string | null;
  start(): void;
}

/**
 * Hands the agent a task over the socket and keeps what comes back.
 *
 * The assignment talks to the socket directly rather than through the chat
 * hook: handing an agent a task from their own page is not a turn in the
 * conversation and must not land in the transcript.
 *
 * Only the text of the run is kept here. The run itself is a case on the
 * board, and a case is watched where it happens.
 */
export function useAgentAssignment(
  agent: Agent | null,
  onCompleted: () => void,
): AgentAssignmentHandle {
  const { socket } = useConnection();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState('');
  const [projectId, setProjectId] = useState<string>(NO_PROJECT);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [error, setError] = useState<string | null>(null);

  const start = (): void => {
    if (!agent || busy) return;
    const trimmed = task.trim();
    if (!trimmed) return;

    setBusy(true);
    setResult('');
    setError(null);

    socket.sendAssign(
      {
        agent: agent.slug,
        task: trimmed,
        ...(projectId !== NO_PROJECT ? { projectId } : {}),
      },
      {
        onEvent: (event) => {
          if (event.type === 'text') {
            setResult((current) => current + event.delta);
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        onDone: (text) => {
          if (text) setResult(text);
          setBusy(false);
          setTask('');
          onCompleted();
          toast('Assignment completed');
        },
        onError: (message) => {
          setError(message);
          setBusy(false);
        },
      },
    );
  };

  return {
    open,
    setOpen,
    task,
    setTask,
    projectId,
    setProjectId,
    busy,
    result,
    error,
    start,
  };
}
