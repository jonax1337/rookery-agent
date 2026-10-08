import { NavLink } from 'react-router';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import type { Agent, Task, TaskStatus } from '@/lib/types';
import { useConfig, useTasksState } from '@/providers/rookery-provider';

function tasksOf(tasks: Task[], agent: Agent, status: TaskStatus): Task[] {
  return tasks.filter((task) => task.status === status && task.assigneeId === agent.id);
}

/**
 * Where the agent is busy, as a pointer, not a stream. What runs through the
 * wire belongs to the case, and a case has exactly one page it happens on;
 * this says that somebody is busy and where the work is, and stops there.
 *
 * Nothing running and nothing waiting means no line at all: a page that
 * announces "idle" says less than one that keeps quiet.
 *
 * The list needs no invented cut-off: `org.maxConcurrentAssignments` caps how
 * many runs can exist at once, so only somebody raising that setting ever
 * sees a summary line instead of the rest.
 */
export function AgentWorkLines({ agent }: { agent: Agent }) {
  const { tasks } = useTasksState();
  const { config } = useConfig();

  const running = tasksOf(tasks, agent, 'running');
  const blocked = tasksOf(tasks, agent, 'blocked');
  if (running.length === 0 && blocked.length === 0) return null;

  const shown = running.slice(0, config?.org.maxConcurrentAssignments ?? running.length);
  const hiddenCount = running.length - shown.length;

  return (
    <Fade delay={200}>
      <div className="flex flex-col gap-1 px-4 text-sm lg:px-6">
        {shown.map((task) => (
          <p key={task.id} className="text-muted-foreground">
            Works on{' '}
            <NavLink to={'/tasks/' + task.id} className="text-foreground hover:underline">
              {task.title}
            </NavLink>
          </p>
        ))}
        {hiddenCount > 0 && (
          <NavLink
            to={'/tasks?assignee=' + agent.id + '&status=running'}
            className="text-muted-foreground hover:underline"
          >
            +{hiddenCount} more
          </NavLink>
        )}
        {blocked.length > 0 && (
          <NavLink
            to={'/tasks?assignee=' + agent.id + '&status=blocked'}
            className="text-muted-foreground hover:underline"
          >
            {blocked.length === 1
              ? '1 task waits for an answer'
              : blocked.length + ' tasks wait for an answer'}
          </NavLink>
        )}
      </div>
    </Fade>
  );
}
