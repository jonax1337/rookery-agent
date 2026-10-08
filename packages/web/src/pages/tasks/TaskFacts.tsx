import {
  FolderOpenIcon as FolderIcon,
  LinkIcon,
  PenToolIcon as PencilLineIcon,
  UserIcon as UserRoundIcon,
} from '@/components/icons';
import { taskOriginLabel } from '@/lib/format';
import type { Agent, Project, Task } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';
import { MetaList } from '@/components/common/meta-list';
import { Badge } from '@/components/ui/badge';

interface TaskFactsProps {
  task: Task;
  assignee: Agent | null;
  project: Project | undefined;
  /** Resolves a `dependsOn` id to a title, when that task is loaded. */
  titleOf(taskId: string): string | undefined;
}

export function TaskFacts({ task, assignee, project, titleOf }: TaskFactsProps) {
  const org = useOrgState();
  const creatorName = task.createdByAgentId
    ? (org.agentById(task.createdByAgentId)?.name ?? 'Unknown')
    : null;

  return (
    <MetaList
      columns={2}
      items={[
        {
          label: 'Project',
          value: project?.name ?? 'No project',
          icon: FolderIcon,
        },
        {
          label: 'Assignee',
          value: assignee?.name ?? 'Unassigned',
          icon: UserRoundIcon,
          ...(assignee ? { to: '/org/agents/' + assignee.id } : {}),
        },
        {
          label: 'Created by',
          value: taskOriginLabel(task) + (creatorName ? ' · ' + creatorName : ''),
          icon: PencilLineIcon,
          // A card a schedule produced links back to the schedule, so
          // "why does this exist?" is one click rather than a guess.
          ...(task.scheduleId ? { to: '/cron/' + task.scheduleId } : {}),
        },
        {
          label: 'Dependencies',
          icon: LinkIcon,
          value:
            task.dependsOn.length === 0 ? null : (
              <DependencyBadges dependsOn={task.dependsOn} titleOf={titleOf} />
            ),
        },
      ]}
    />
  );
}

function DependencyBadges({
  dependsOn,
  titleOf,
}: {
  dependsOn: readonly string[];
  titleOf(taskId: string): string | undefined;
}) {
  return (
    <span className="flex flex-wrap gap-1">
      {dependsOn.map((dependency) => {
        const label = titleOf(dependency);
        return (
          <Badge
            key={dependency}
            variant="outline"
            className={label ? 'font-normal' : 'font-mono text-2xs font-normal'}
          >
            {label ?? dependency}
          </Badge>
        );
      })}
    </span>
  );
}
