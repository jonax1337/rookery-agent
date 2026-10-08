import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { StatusBadge } from '@/components/common/status-badge';
import { ResultMarkdown } from '@/components/result-markdown';
import { Badge } from '@/components/ui/badge';
import type { Agent, Assignment, AssignmentStatus } from '@/lib/types';

/**
 * The run's status badges, its name and, underneath, the brief it was given.
 *
 * The name leads: a name replaces the prompt in a list, never in the file
 * (concept 7.2).
 */
export function AssignmentHeading({
  assignment,
  status,
  agent,
}: {
  assignment: Assignment;
  status: AssignmentStatus;
  agent: Agent | null;
}) {
  return (
    <>
      <Fade>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="assignment" status={status} />
          {agent ? (
            <Badge variant="outline" className="font-mono font-normal">
              {agent.slug}
            </Badge>
          ) : null}
          {assignment.depth > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              Level {assignment.depth}
            </Badge>
          ) : null}
        </div>
      </Fade>

      <Blur delay={50}>
        <div className="flex flex-col gap-2">
          <h1 className="text-lg leading-snug font-semibold">{assignment.title}</h1>
          <ResultMarkdown text={assignment.task} preview className="text-muted-foreground" />
        </div>
      </Blur>
    </>
  );
}
