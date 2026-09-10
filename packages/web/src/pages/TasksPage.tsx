import { useMemo } from 'react';
import { NavLink } from 'react-router';
import { PlusIcon } from 'lucide-react';
import {
  TASK_PRIORITY_LABEL,
  TASK_PRIORITY_VARIANT,
  TASK_STATUS_LABEL,
  TASK_STATUS_VARIANT,
} from '@/lib/format';
import type { Task, TaskStatus } from '@/lib/types';
import type { OrgState } from '@/hooks/useOrg';
import type { TasksState } from '@/hooks/useTasks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * The board's columns.
 *
 * Failed and cancelled share one column: both mean "did not get done", and
 * splitting them would leave two nearly always empty lanes on the screen.
 */
const COLUMNS: { label: string; statuses: TaskStatus[] }[] = [
  { label: 'Offen', statuses: ['open'] },
  { label: 'Geplant', statuses: ['planned'] },
  { label: 'Läuft', statuses: ['running'] },
  { label: 'Fertig', statuses: ['done'] },
  { label: 'Nicht erledigt', statuses: ['failed', 'cancelled'] },
];

interface TasksPageProps {
  tasks: TasksState;
  org: OrgState;
}

/**
 * Everything the company has been asked to get done.
 *
 * The board never polls: `useTasks` merges the `task` broadcast, so a task the
 * assistant files during a turn, or a subtask the runner moves, appears here
 * while it happens.
 */
export function TasksPage({ tasks, org }: TasksPageProps) {
  const columns = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        items: tasks.topLevel.filter((task) => column.statuses.includes(task.status)),
      })),
    [tasks.topLevel],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Aufgaben</h1>
            <p className="text-sm text-muted-foreground">
              Das Board: größere Vorhaben, geplant und in Teilaufgaben verteilt. Ausgeführt wird eine
              Aufgabe als ein oder mehrere Aufträge. Der Assistent trägt hier selbst ein.
            </p>
          </div>
          <Button asChild>
            <NavLink to="/tasks/new">
              <PlusIcon />
              Aufgabe anlegen
            </NavLink>
          </Button>
        </div>

        {tasks.error && <p className="text-sm text-destructive">{tasks.error}</p>}

        {tasks.loading && tasks.topLevel.length === 0 ? (
          <p className="text-sm text-muted-foreground">Wird geladen …</p>
        ) : tasks.topLevel.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Noch keine Aufgaben. Leg eine an, oder bitte den Assistenten darum.
            </CardContent>
          </Card>
        ) : (
          // One row of lanes, like any board: it scrolls sideways on a narrow
          // screen rather than wrapping the last lanes underneath the first.
          <div className="-mx-6 flex gap-4 overflow-x-auto px-6 pb-2 [scrollbar-width:thin]">
            {columns.map((column) => (
              <Card key={column.label} className="w-64 shrink-0 self-start xl:w-auto xl:flex-1">
                <CardHeader className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-sm">{column.label}</CardTitle>
                  <Badge variant="secondary" className="tabular h-4 px-1.5 text-[10px]">
                    {column.items.length}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-2">
                  {column.items.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nichts hier.</p>
                  ) : (
                    column.items.map((task) => (
                      <TaskCard key={task.id} task={task} tasks={tasks} org={org} />
                    ))
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TaskCard({ task, tasks, org }: { task: Task; tasks: TasksState; org: OrgState }) {
  const assignee = org.agentById(task.assigneeId);
  const project = org.projects.find((entry) => entry.id === task.projectId);
  const subtasks = tasks.childrenOf(task.id).length;

  return (
    <NavLink
      to={'/tasks/' + task.id}
      className="block rounded-lg border bg-background/40 p-2.5 hover:bg-muted/60"
    >
      <p className="text-sm font-medium leading-snug">{task.title}</p>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge variant={TASK_STATUS_VARIANT[task.status]} className="h-4 px-1.5 text-[10px]">
          {TASK_STATUS_LABEL[task.status]}
        </Badge>
        <Badge variant={TASK_PRIORITY_VARIANT[task.priority]} className="h-4 px-1.5 text-[10px]">
          {TASK_PRIORITY_LABEL[task.priority]}
        </Badge>
        {subtasks > 0 && (
          <Badge variant="outline" className="tabular h-4 px-1.5 text-[10px]">
            {subtasks} {subtasks === 1 ? 'Teilaufgabe' : 'Teilaufgaben'}
          </Badge>
        )}
      </div>

      <p className="mt-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-muted-foreground">
        {assignee ? assignee.name : 'Niemand zugewiesen'}
        {project && ' · ' + project.name}
      </p>

      {task.error && (
        <p className="mt-1.5 text-[11px] leading-snug text-destructive">{task.error}</p>
      )}
    </NavLink>
  );
}
