import { useCallback, useState } from 'react';
import { useParams } from 'react-router';

import { BanIcon } from '@/components/icons';
import { useConnection, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { usePageMeta } from '@/components/shell/page-meta';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { useCancelAssignment } from '@/components/common/entity-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { TaskActivityTab } from '@/pages/tasks/TaskActivityTab';
import {
  TaskDetailSkeleton,
  TaskLoadFailure,
  TaskNotFound,
} from '@/pages/tasks/TaskDetailStates';
import { questionAskerName } from '@/pages/tasks/task-detail';
import { TaskFacts } from '@/pages/tasks/TaskFacts';
import { PlanPopover, RunButton, TaskMoreMenu } from '@/pages/tasks/TaskHeaderActions';
import { TaskOverviewTab } from '@/pages/tasks/TaskOverviewTab';
import { TaskQuestionCard } from '@/pages/tasks/TaskQuestionCard';
import { TaskResultTab } from '@/pages/tasks/TaskResultTab';
import { TaskRunsTab } from '@/pages/tasks/TaskRunsTab';
import { TaskStats } from '@/pages/tasks/TaskStats';
import { TaskSubtasksTab } from '@/pages/tasks/TaskSubtasksTab';
import { TaskTabList, type TaskTab } from '@/pages/tasks/TaskTabList';
import { useTaskDetail } from '@/pages/tasks/useTaskDetail';
import { useTaskPlanning } from '@/pages/tasks/useTaskPlanning';
import { useTaskRunStream } from '@/pages/tasks/useTaskRunStream';
import { useTaskRuns } from '@/pages/tasks/useTaskRuns';
import { useTaskStatusActions } from '@/pages/tasks/useTaskStatusActions';

/**
 * One task: what it is, who does it, and the two things you can do to it -
 * plan it and run it.
 *
 * The facts sit in a `MetaList`, the four numbers in `StatCards`, and the
 * four things worth reading - the text, the subtasks, the runs, the result -
 * live behind tabs that do not move each other, so a run streaming in never
 * scrolls the reader's place away.
 *
 * A reload does bring the transcript back. `run()` journals every event
 * under the assignment's own id, so `GET /api/org/assignments/:id/log`
 * serves it during the run and long after it. What the "Runs" tab
 * rehydrates from `TaskDetail.assignment` and `org.live` is the *status*
 * of open runs; the text itself lives one click away, on the run.
 */
export function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const org = useOrgState();
  const tasks = useTasksState();
  const { socket } = useConnection();
  // The stop button of `LiveRunList` asks the same question on every page that
  // renders it.
  const { dialog: cancelRunDialog, cancelAssignment } = useCancelAssignment();

  const [tab, setTab] = useState<TaskTab>('overview');

  const { detail, task, children, events, question, loading, missing, loadError, reload } =
    useTaskDetail(id, socket);

  const showRunsTab = useCallback(() => setTab('runs'), []);
  const { starting, streamed, streamResult, streamError, run } = useTaskRunStream({
    taskId: id,
    socket,
    reload,
    onStarted: showRunsTab,
  });
  const runs = useTaskRuns({ task, detail, children, streamed });

  const showSubtasksTab = useCallback((createdSubtasks: boolean) => {
    if (createdSubtasks) setTab('subtasks');
  }, []);
  const { planning, plan } = useTaskPlanning({
    taskId: id,
    reload,
    onPlanned: showSubtasksTab,
  });
  const { completeTask, cancelTask, dialog: cancelTaskDialog } = useTaskStatusActions({
    taskId: id,
    reload,
  });

  const cancelRun = useCallback(
    (assignmentId: string): void => {
      void cancelAssignment(assignmentId);
    },
    [cancelAssignment],
  );

  /** Every task by id, so a `dependsOn` entry can be shown by its title. */
  const titleOf = useCallback(
    (taskId: string): string | undefined =>
      tasks.tasks.find((entry) => entry.id === taskId)?.title ??
      children.find((entry) => entry.id === taskId)?.title,
    [children, tasks.tasks],
  );

  const isRunning = task?.status === 'running' || starting;
  const settled = task?.status === 'done' || task?.status === 'cancelled';
  const actionsDisabled = isRunning || settled;

  usePageMeta(
    {
      ...(task ? { title: task.title } : {}),
      breadcrumb: [{ label: 'Tasks', to: '/tasks' }, { label: task?.title ?? 'Task' }],
      actions: task ? (
        <>
          <RunButton running={isRunning} disabled={actionsDisabled} onRun={run} />
          <PlanPopover
            planning={planning}
            disabled={actionsDisabled}
            onPlan={plan}
          />
          <TaskMoreMenu
            taskId={task.id}
            completeDisabled={actionsDisabled}
            settled={settled}
            onComplete={() => void completeTask()}
            onCancel={() => void cancelTask()}
          />
        </>
      ) : null,
    },
    [task?.id, isRunning, settled, planning, cancelTask, completeTask, plan, run],
  );

  if (missing) return <TaskNotFound />;

  if (!task) {
    if (loading) return <TaskDetailSkeleton />;
    return loadError ? <TaskLoadFailure onRetry={() => void reload()} /> : <TaskNotFound />;
  }

  const assignee = org.agentById(task.assigneeId) ?? detail?.assignee ?? null;
  const project = org.projects.find((entry) => entry.id === task.projectId);
  const questionAsker = question ? questionAskerName(question, org.agentById) : '';
  const result = streamResult || task.result || '';
  const failure = streamError ?? task.error;

  return (
    <PageBody>
      {cancelTaskDialog}
      {cancelRunDialog}

      <Fade>
        <div className="px-4 lg:px-6">
          <TaskFacts task={task} assignee={assignee} project={project} titleOf={titleOf} />
        </div>
      </Fade>

      {failure ? (
        <Fade delay={50}>
          <div className="px-4 lg:px-6">
            <Alert variant="destructive">
              <BanIcon />
              <AlertTitle>The task failed</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">{failure}</AlertDescription>
            </Alert>
          </div>
        </Fade>
      ) : null}

      {question ? (
        <Fade delay={50}>
          <div className="px-4 lg:px-6">
            <TaskQuestionCard
              taskId={task.id}
              question={question}
              askedBy={questionAsker}
              onAnswered={() => void reload()}
            />
          </div>
        </Fade>
      ) : null}

      <Fade delay={100}>
        <TaskStats
          task={task}
          assignee={assignee}
          subtasks={children}
          runCount={runs.runIds.length}
          openRunCount={runs.openCount}
        />
      </Fade>

      <Fade delay={150}>
        <div className="px-4 lg:px-6">
          <Tabs value={tab} onValueChange={(value) => setTab(value as TaskTab)}>
            <TaskTabList
              hasOpenQuestion={question !== null}
              subtaskCount={children.length}
              runCount={runs.runIds.length}
              openRunCount={runs.openCount}
            />

            <TabsContent value="overview" className="mt-4 flex flex-col gap-4">
              <TaskOverviewTab task={task} />
            </TabsContent>

            <TabsContent value="activity" className="mt-4">
              <TaskActivityTab events={events} highlightId={question?.id} />
            </TabsContent>

            <TabsContent value="subtasks" className="mt-4">
              <TaskSubtasksTab
                subtasks={children}
                titleOf={titleOf}
                onPlan={() => void plan()}
              />
            </TabsContent>

            <TabsContent value="runs" className="mt-4 flex flex-col gap-4">
              <TaskRunsTab
                runs={runs}
                streamText={streamed.length > 0 ? streamResult : ''}
                onCancelRun={cancelRun}
                onRun={run}
              />
            </TabsContent>

            <TabsContent value="result" className="mt-4">
              <TaskResultTab result={result} onRun={run} />
            </TabsContent>
          </Tabs>
        </div>
      </Fade>
    </PageBody>
  );
}
