import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { NO_PROJECT, isSettableTaskStatus } from '@/lib/format';
import { countSince, formatNumber } from '@/lib/stats';
import { useConnection, useOrgState, useTasksState } from '@/providers/rookery-provider';
import { useStatsTotals } from '@/hooks/useStatsTotals';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { usePageMeta } from '@/components/shell/page-meta';
import { PageBody } from '@/components/blocks/page-body';
import { DataTable } from '@/components/blocks/data-table/data-table';
import { useBulkAction } from '@/components/common/confirm-dialog';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { FilterCombobox } from '@/components/common/filter-combobox';
import {
  buildTaskColumns,
  TASK_COLUMN_LABELS,
  TASK_SORTING,
  TASK_UNASSIGNED,
} from '@/components/common/task-columns';
import { TaskBoard } from '@/components/common/task-board';
import { BoardWatchLine } from '@/pages/tasks/BoardWatchLine';
import { BulkCancelButton } from '@/pages/tasks/BulkCancelButton';
import { ClipboardEmptyIcon } from '@/pages/tasks/empty-state-icons';
import { TaskDrawer } from '@/pages/tasks/TaskDrawer';
import {
  ALL_TAB,
  buildStatusTabs,
  filterByTab,
  filterTasks,
  startOfWeek,
  tallyByStatus,
  UNASSIGNED,
  withPendingStatus,
} from '@/pages/tasks/task-list';
import { TaskRowMenu } from '@/pages/tasks/TaskRowMenu';
import { TasksHeaderActions, type TasksView } from '@/pages/tasks/TasksHeaderActions';
import { TasksStatCards } from '@/pages/tasks/TasksStatCards';
import { TasksTrendCard } from '@/pages/tasks/TasksTrendCard';
import { useBlockedTaskQuestions } from '@/pages/tasks/useBlockedTaskQuestions';
import { useTaskActions } from '@/pages/tasks/useTaskActions';

/**
 * Everything the company has been asked to get done.
 *
 * The Kanban board this replaces looked like it could be reordered and could
 * not: there is no `sort_order` anywhere in the API (see serverGaps), so a
 * drag handle would only ever have reshuffled the current render. What the
 * board was actually good at - seeing the states side by side - is now the
 * facet tabs with their counts, and the state change it never really offered
 * lives in the row menu.
 *
 * Nothing polls: `useTasks` merges the `task` broadcast, so a task the
 * assistant files during a turn, or a subtask the runner moves, appears here
 * while it happens.
 *
 * The columns come from `buildTaskColumns`, shared with the subtask table on a
 * task's detail page and with the dashboard.
 */
export function TasksPage() {
  const tasks = useTasksState();
  const org = useOrgState();
  const { socket } = useConnection();
  const navigate = useNavigate();
  const bulk = useBulkAction();
  const actions = useTaskActions(socket);
  const { setStatus, cancelTask, planTask, runTask, selectStatus } = actions;

  // Deep links from elsewhere: the agent page points at "the board, filtered
  // by this person", so `?assignee=` and `?status=` arrive as the filters they
  // name. Read once - after that the page's own controls own the state, and a
  // re-read would fight them.
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState(() => searchParams.get('status') || ALL_TAB);
  const [assignee, setAssignee] = useState<string | null>(() => searchParams.get('assignee') || null);
  const [project, setProject] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  /** Table keeps the status tabs and bulk actions; board owns status via columns instead. */
  const [view, setView] = useState<TasksView>('table');

  // `view` has to be in the deps: without it the header keeps the action row
  // it was published with, the toggle stays stuck on `table`, and clicking
  // "Table" while the board is up only deselects an already-selected item -
  // Radix reports `''`, the guard drops it, and the board never gives way.
  usePageMeta(
    {
      breadcrumb: [{ label: 'Tasks' }],
      actions: <TasksHeaderActions view={view} onViewChange={setView} />,
    },
    [view],
  );

  // The only real total in this API. `countByStatus` rests on a capped list,
  // so without this the page could not tell "12 open" from "12 open of the
  // 300 we happen to have loaded"; `totals.tasks` is a `COUNT(*)` and settles
  // it. The shared hook keeps the number in step with every other list.
  const totals = useStatsTotals(socket);
  const loaded = tasks.tasks.length;
  const capped = totals !== null && totals.tasks > loaded;

  const rows = useMemo(
    () => withPendingStatus(tasks.topLevel, actions.pending),
    [tasks.topLevel, actions.pending],
  );
  const filtered = useMemo(
    () => filterTasks(rows, { assignee, project }),
    [rows, assignee, project],
  );
  // The counts belong to what the filters left standing, not to the whole
  // board: a tab reading "7" that shows three rows is worse than no count.
  const tabs = useMemo(
    () => buildStatusTabs(filtered.length, tallyByStatus(filtered)),
    [filtered],
  );
  const visible = useMemo(() => filterByTab(filtered, tab), [filtered, tab]);

  const questionByTask = useBlockedTaskQuestions(socket, tasks.tasks);

  const columns = useMemo(
    () =>
      buildTaskColumns({
        agentById: org.agentById,
        selectable: true,
        onOpenDetail: (task) => setDrawerId(task.id),
        projectName: (task) =>
          org.projects.find((entry) => entry.id === task.projectId)?.name ?? '',
        childrenOf: tasks.childrenOf,
        showCreatedAt: true,
        rowActions: (task) => (
          <TaskRowMenu
            task={task}
            onOpen={() => void navigate('/tasks/' + task.id)}
            onEdit={() => void navigate('/tasks/' + task.id + '/edit')}
            onPlan={() => void planTask(task)}
            onRun={() => runTask(task)}
            onStatus={(status) => selectStatus(task, status)}
            onCancel={() => void cancelTask(task)}
          />
        ),
      }),
    [cancelTask, navigate, org, planTask, runTask, selectStatus, tasks],
  );

  const doneThisWeek = countSince(tasks.topLevel, (task) => task.finishedAt, startOfWeek());
  const basis = capped
    ? 'counts top-level tasks only · ' +
      formatNumber(loaded) +
      ' of ' +
      formatNumber(totals?.tasks ?? loaded) +
      ' loaded'
    : 'counts top-level tasks only';

  const drawerTask = rows.find((task) => task.id === drawerId) ?? null;

  return (
    <PageBody>
      {actions.dialog}
      {bulk.dialog}

      <BoardWatchLine socket={socket} />

      <Fade>
        <TasksStatCards board={tasks.countByStatus} doneThisWeek={doneThisWeek} basis={basis} />
      </Fade>

      <Fade delay={50}>
        <div className="px-4 lg:px-6">
          <TasksTrendCard tasks={tasks.tasks} capped={capped} />
        </div>
      </Fade>

      <Fade delay={100} key={view}>
        {view === 'board' ? (
          <div className="px-4 lg:px-6">
            <TaskBoard
              tasks={filtered}
              agentById={org.agentById}
              onOpenDetail={(task) => setDrawerId(task.id)}
              onStatusChange={(task, status) => {
                if (isSettableTaskStatus(status)) void setStatus(task, status);
              }}
              onReorder={actions.reorderTask}
              questionByTask={questionByTask}
            />
          </div>
        ) : (
          <DataTable
            data={visible}
            columns={columns}
            getRowId={(task) => task.id}
            tabs={tabs}
            tab={tab}
            onTabChange={setTab}
            tabLabel="Status"
            searchable
            searchPlaceholder="Search tasks"
            searchText={(task) => task.title + ' ' + task.description}
            columnLabels={TASK_COLUMN_LABELS}
            rowLabel={{ singular: 'task', plural: 'tasks' }}
            capped={capped}
            loading={tasks.loading && tasks.topLevel.length === 0}
            error={tasks.error ? <ServerOffline onRetry={() => void tasks.refresh()} /> : undefined}
            initialSorting={TASK_SORTING}
            onRowClick={(task) => setDrawerId(task.id)}
            rowClickIgnoreColumns={['select', 'title', 'actions']}
            filters={
              <>
                <FilterCombobox
                  label="Assignee"
                  placeholder="Assignee"
                  value={assignee}
                  onChange={setAssignee}
                  options={[
                    { value: UNASSIGNED, label: TASK_UNASSIGNED },
                    ...org.agents.map((agent) => ({ value: agent.id, label: agent.name })),
                  ]}
                />
                <FilterCombobox
                  label="Project"
                  placeholder="Project"
                  value={project}
                  onChange={setProject}
                  options={[
                    { value: NO_PROJECT, label: 'No project' },
                    ...org.projects.map((entry) => ({ value: entry.id, label: entry.name })),
                  ]}
                />
              </>
            }
            // The primary action lives in the page header, not in the table.
            bulkActions={(selected, clear) => (
              <BulkCancelButton
                selected={selected}
                bulk={bulk}
                onCancelled={tasks.refresh}
                clearSelection={clear}
              />
            )}
            empty={
              <Fade>
                <EmptyState
                  icon={ClipboardEmptyIcon}
                  title="No tasks yet"
                  description="Larger goals start here before they are planned and run. The assistant can add tasks too."
                  actionLabel="Create task"
                  actionTo="/tasks/new"
                  variant="plain"
                />
              </Fade>
            }
          />
        )}
      </Fade>

      <TaskDrawer task={drawerTask} onClose={() => setDrawerId(null)} />
    </PageBody>
  );
}
