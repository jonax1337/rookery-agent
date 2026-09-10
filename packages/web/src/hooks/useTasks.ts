import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { TASK_PRIORITY_RANK } from '../lib/format';
import type { RookerySocket } from '../lib/socket';
import type { Task, TaskStatus } from '../lib/types';

/**
 * The company's task board, kept fresh.
 *
 * Everything is fetched at once (`?all=1`), subtasks included, because the
 * board needs a subtask count per card and the detail page needs the children
 * anyway; the list is small enough that one call beats a request per row.
 *
 * A `task` broadcast arrives whenever anything anywhere changes a task - the
 * user here, the assistant during a turn, or the runner while a task executes -
 * so those are merged in memory by id instead of triggering a refetch.
 */

export interface TasksState {
  /** Every task in the company, subtasks included. */
  tasks: Task[];
  /** Board cards: tasks without a parent, highest priority first. */
  topLevel: Task[];
  loading: boolean;
  error: string | null;
  childrenOf(id: string): Task[];
  countByStatus: Record<TaskStatus, number>;
  refresh(): Promise<void>;
}

const EMPTY_COUNTS: Record<TaskStatus, number> = {
  open: 0,
  planned: 0,
  running: 0,
  done: 0,
  failed: 0,
  cancelled: 0,
};

function byBoardOrder(a: Task, b: Task): number {
  const rank = TASK_PRIORITY_RANK[a.priority] - TASK_PRIORITY_RANK[b.priority];
  return rank !== 0 ? rank : a.createdAt - b.createdAt;
}

export function useTasks(socket: RookerySocket): TasksState {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setTasks(await api.tasks({ all: true, limit: 300 }));
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.offline) {
        setError('Keine Verbindung zum Rookery-Server.');
      } else {
        setError((caught as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      socket.onTask((task) => {
        setTasks((current) => {
          const index = current.findIndex((entry) => entry.id === task.id);
          if (index === -1) return [...current, task];
          const next = [...current];
          next[index] = task;
          return next;
        });
      }),
    [socket],
  );

  const topLevel = useMemo(
    () => tasks.filter((task) => !task.parentId).sort(byBoardOrder),
    [tasks],
  );

  const childrenById = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (!task.parentId) continue;
      const list = map.get(task.parentId);
      if (list) list.push(task);
      else map.set(task.parentId, [task]);
    }
    for (const list of map.values()) list.sort(byBoardOrder);
    return map;
  }, [tasks]);

  const childrenOf = useCallback(
    (id: string): Task[] => childrenById.get(id) ?? [],
    [childrenById],
  );

  const countByStatus = useMemo(() => {
    const counts = { ...EMPTY_COUNTS };
    for (const task of topLevel) counts[task.status] += 1;
    return counts;
  }, [topLevel]);

  return { tasks, topLevel, loading, error, childrenOf, countByStatus, refresh };
}
