import { useEffect, useMemo, useState } from 'react';

import { api } from '@/lib/api';
import type { Assignment, AssignmentView, Task, TaskDetail } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { toAssignmentRow, type AssignmentRow } from '@/pages/assignments/assignment-row';
import { isOpenRun, viewOf } from '@/pages/tasks/task-detail';

interface UseTaskRunsOptions {
  task: Task | null;
  detail: TaskDetail | null;
  children: readonly Task[];
  /** Runs this page started and is streaming right now. */
  streamed: AssignmentView[];
}

export interface TaskRuns {
  runIds: string[];
  rows: AssignmentRow[];
  /** What is in flight right now. */
  liveViews: AssignmentView[];
  /** The live rows were rebuilt, not streamed - so their text is missing. */
  rehydrated: boolean;
  openCount: number;
  /** The open run whose terminal is mounted, if any. */
  watched: AssignmentView | undefined;
  watch(assignmentId: string): void;
}

/**
 * The assignments this task and its subtasks ran as.
 *
 * `GET /api/org/tasks/:id` names only the task's own run, a subtask carries
 * nothing but its `assignmentId`, and no endpoint lists assignments by task.
 * So the ids are fetched one by one - there are as many of them as there are
 * subtasks, never a list that would need paging.
 */
export function useTaskRuns({ task, detail, children, streamed }: UseTaskRunsOptions): TaskRuns {
  const org = useOrgState();

  // The live terminal of one of the open runs - mounted only while the run
  // actually goes, because the log it reads is live-only by design.
  const [watchId, setWatchId] = useState<string | null>(null);

  const runIds = useMemo(() => {
    const own = task?.assignmentId ?? detail?.assignment?.id;
    const ids = own ? [own] : [];
    for (const child of children) if (child.assignmentId) ids.push(child.assignmentId);
    return [...new Set(ids)];
  }, [children, detail?.assignment?.id, task?.assignmentId]);

  const records = useAssignmentRecords(runIds, org.live);

  /** Which subtask a run belongs to, for the row menu's way back. */
  const taskOfRun = useMemo(() => {
    const map = new Map<string, string>();
    for (const child of children) if (child.assignmentId) map.set(child.assignmentId, child.id);
    return map;
  }, [children]);

  const rows = useMemo(
    () =>
      runIds.flatMap((runId) => {
        const record = records[runId];
        if (!record) return [];
        return [
          toAssignmentRow(record, org.agentById(record.agentId), org.live[runId], taskOfRun.get(runId)),
        ];
      }),
    [org, runIds, records, taskOfRun],
  );

  // A run this page started wins outright - that is the real stream. Without
  // one, the open runs are rebuilt from the socket's newest word and, failing
  // that, from the fetched record, so a reload still shows that something is
  // working even though its text is gone.
  const liveViews = useMemo<AssignmentView[]>(() => {
    if (streamed.length > 0) return streamed;
    const open: AssignmentView[] = [];
    for (const runId of runIds) {
      const view = org.live[runId];
      if (view) {
        if (isOpenRun(view.status)) open.push(view);
        continue;
      }
      const record = records[runId];
      if (record && isOpenRun(record.status)) {
        open.push(viewOf(record, org.agentById(record.agentId)));
      }
    }
    return open;
  }, [org, runIds, records, streamed]);

  return {
    runIds,
    rows,
    liveViews,
    rehydrated: streamed.length === 0 && liveViews.length > 0,
    openCount: liveViews.filter((view) => isOpenRun(view.status)).length,
    watched: liveViews.find((view) => view.id === watchId && isOpenRun(view.status)),
    watch: setWatchId,
  };
}

/**
 * Reads each assignment record by id. The key holds the ids plus their live
 * status: a run that just finished has to be read again, because the record
 * carries the result and the duration the socket view does not.
 */
function useAssignmentRecords(
  runIds: readonly string[],
  live: Record<string, AssignmentView | undefined>,
): Record<string, Assignment> {
  const [records, setRecords] = useState<Record<string, Assignment>>({});

  const readKey = runIds.map((runId) => runId + ':' + (live[runId]?.status ?? '')).join(',');

  useEffect(() => {
    if (runIds.length === 0) {
      setRecords({});
      return;
    }
    let alive = true;
    void Promise.all(runIds.map(readAssignment)).then((list) => {
      if (!alive) return;
      const next: Record<string, Assignment> = {};
      for (const entry of list) if (entry) next[entry.id] = entry;
      setRecords(next);
    });
    return () => {
      alive = false;
    };
    // `readKey` carries both the ids and their live states; `runIds` itself is
    // a fresh array on every render and would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readKey]);

  return records;
}

async function readAssignment(runId: string): Promise<Assignment | null> {
  try {
    return (await api.assignment(runId)).assignment;
  } catch {
    // A run that cannot be read is left out of the table; the others still render.
    return null;
  }
}
