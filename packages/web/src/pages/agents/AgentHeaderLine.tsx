import { NavLink } from 'react-router';

import { StatusBadge } from '@/components/common/status-badge';
import { ArrowRightIcon } from '@/components/icons';
import { Badge } from '@/components/ui/badge';
import type { AgentDetail } from '@/lib/types';

const LINK_CLASS = 'flex items-center gap-1 text-sm text-muted-foreground hover:underline';

/** Role, slug, state and the replacement chain, as one line of badges. */
export function AgentHeaderLine({ detail }: { detail: AgentDetail }) {
  const { agent, performance, predecessor, successor } = detail;

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
      <span className="text-sm text-muted-foreground">{agent.title}</span>
      <Badge variant="outline" className="font-mono font-normal">
        {agent.slug}
      </Badge>
      {agent.archived && <Badge variant="secondary">archived</Badge>}
      <StatusBadge kind="agentStage" status={performance.stage} />
      {predecessor ? (
        <NavLink to={'/org/agents/' + predecessor.id} className={LINK_CLASS}>
          Successor of {predecessor.name}
        </NavLink>
      ) : null}
      {successor ? (
        <NavLink to={'/org/agents/' + successor.id} className={LINK_CLASS}>
          Replaced by {successor.name}
          <ArrowRightIcon className="size-3.5" />
        </NavLink>
      ) : null}
    </div>
  );
}
