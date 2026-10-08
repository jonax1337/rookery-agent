import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import { openQuestion } from '@/lib/notifications';
import type { RookerySocket } from '@/lib/socket';
import type { Task, TaskDetail, TaskEvent } from '@/lib/types';
import { useTasksState } from '@/providers/rookery-provider';
import { useRecord } from '@/hooks/useRecord';

/**
 * Two sources feed a task page. `useTasks` is the live copy: it merges the
 * `task` broadcast, so a subtask moving from planned to running updates
 * without the page tracking it. The fetched `TaskDetail` fills in what the
 * broadcast does not carry - the assignee record and the assignment the task
 * ran as.
 */
export function useTaskDetail(id: string | undefined, socket: RookerySocket) {
  const tasks = useTasksState();
  const { record, loading, missing, error: loadError, reload } = useRecord<TaskDetail>(
    id,
    api.task,
  );
  // `useRecord` keeps the previous record until the next id has answered; it
  // must not stand in for a task it does not describe.
  const detail = record?.task.id === id ? record : null;

  // The board's copy is the one the socket keeps current.
  const boardTask = id ? tasks.tasks.find((entry) => entry.id === id) : undefined;
  const task: Task | null = boardTask ?? detail?.task ?? null;

  const children = useMemo<Task[]>(() => {
    if (!id) return [];
    const fromBoard = tasks.childrenOf(id);
    return fromBoard.length > 0 ? fromBoard : (detail?.children ?? []);
  }, [detail?.children, id, tasks]);

  const events = useTaskEvents(socket, id, detail);

  /** The question the card waits on - only while it is actually blocked. */
  const question = useMemo(
    () => (task?.status === 'blocked' && events ? openQuestion(events) : null),
    [task?.status, events],
  );

  return { detail, task, children, events, question, loading, missing, loadError, reload };
}

/**
 * The record brings the activity up to now; the socket appends what happens
 * while the page is open, so a question or a run's end shows up without a
 * reload. `null` until the first fetch answers.
 */
function useTaskEvents(
  socket: RookerySocket,
  id: string | undefined,
  detail: TaskDetail | null,
): TaskEvent[] | null {
  const [events, setEvents] = useState<TaskEvent[] | null>(null);

  useEffect(() => {
    setEvents(null);
  }, [id]);

  useEffect(() => {
    if (!detail) return;
    const loaded = detail.events ?? [];
    setEvents((current) => {
      if (!current) return loaded;
      // Keep anything the socket delivered that the fetch did not have yet.
      const known = new Set(loaded.map((event) => event.id));
      return [...loaded, ...current.filter((event) => !known.has(event.id))].sort(
        (a, b) => a.at - b.at,
      );
    });
  }, [detail]);

  useEffect(
    () =>
      socket.onTaskEvent((event) => {
        if (event.taskId !== id) return;
        setEvents((current) =>
          current === null || current.some((entry) => entry.id === event.id)
            ? current
            : [...current, event],
        );
      }),
    [socket, id],
  );

  return events;
}
