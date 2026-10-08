import type { MetaItem } from '@/components/common/meta-list';
import { ProviderCell } from '@/components/common/provider-cell';
import { REQUESTER_LABEL } from '@/lib/format';
import { formatDateTime } from '@/lib/stats';
import type { Agent, Assignment, Project } from '@/lib/types';

interface DetailFactsInput {
  assignment: Assignment;
  agent: Agent | null;
  project: Project | undefined;
  /** The agent that delegated this run, when one did. */
  requesterAgent: Agent | undefined;
}

/** The labelled facts of one run, for the two-column list under the title. */
export function buildDetailFacts({
  assignment,
  agent,
  project,
  requesterAgent,
}: DetailFactsInput): MetaItem[] {
  return [
    {
      label: 'Agent',
      value: agent?.name ?? 'Unknown',
      ...(agent ? { to: '/org/agents/' + agent.id } : {}),
    },
    {
      label: 'Provider',
      value: (
        <ProviderCell
          layout="inline"
          showModel={false}
          {...(assignment.provider ? { provider: assignment.provider } : {})}
        />
      ),
    },
    { label: 'Model', value: assignment.model ?? 'Default model', mono: true },
    { label: 'Project', value: project?.name ?? 'No project' },
    { label: 'Level', value: assignment.depth > 0 ? String(assignment.depth) : 'Direct' },
    { label: 'Requested by', value: requesterLabel(assignment, requesterAgent) },
    { label: 'Created', value: formatDateTime(assignment.createdAt) },
    { label: 'Started', value: assignment.startedAt ? formatDateTime(assignment.startedAt) : null },
    {
      label: 'Finished',
      value: assignment.finishedAt ? formatDateTime(assignment.finishedAt) : null,
    },
  ];
}

function requesterLabel(assignment: Assignment, requesterAgent: Agent | undefined): string {
  const kind = REQUESTER_LABEL[assignment.requesterKind];
  if (!assignment.requesterAgentId) return kind;
  return kind + ' · ' + (requesterAgent?.name ?? 'Unknown');
}
