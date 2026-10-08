import { useParams } from 'react-router';

import { usePageMeta } from '@/components/shell/page-meta';
import { useRecord } from '@/hooks/useRecord';
import { api } from '@/lib/api';
import type { AgentDetail } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

import { AgentDetailBody } from './agents/AgentDetailBody';
import { AgentDetailSkeleton } from './agents/AgentDetailSkeleton';
import { AgentHeaderActions } from './agents/AgentHeaderActions';
import { AgentUnavailable } from './agents/AgentUnavailable';
import { useAgentAssignment } from './agents/useAgentAssignment';
import { useArchiveAgent } from './agents/useArchiveAgent';

/**
 * One member of staff, at `/org/agents/:id`.
 *
 * Keyed by the id because the predecessor/successor links and the manager
 * link lead from one agent to another without unmounting the route: without
 * the key the previous agent's record, drawer text and run output would stay
 * on screen until the next answer arrives.
 */
export function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <AgentDetailLoader key={id} id={id} />;
}

function AgentDetailLoader({ id }: { id: string | undefined }) {
  const org = useOrgState();

  // `missing` is what tells a deleted agent from a stopped server.
  const {
    record: detail,
    loading,
    missing,
    error: loadError,
    reload,
  } = useRecord<AgentDetail>(id, api.agent);

  const agent = detail?.agent ?? null;
  const assignment = useAgentAssignment(agent, () => {
    void reload();
    void org.refresh();
  });
  const { archive, dialog } = useArchiveAgent(agent, reload);

  usePageMeta(
    {
      ...(agent ? { title: agent.name } : {}),
      breadcrumb: [
        { label: 'Organization', to: '/org/agents' },
        { label: 'Agents', to: '/org/agents' },
        { label: agent?.name ?? 'Agent' },
      ],
      actions: agent ? (
        <AgentHeaderActions
          agent={agent}
          onAssign={() => assignment.setOpen(true)}
          onArchive={() => void archive()}
        />
      ) : null,
    },
    [agent?.id, agent?.archived, archive],
  );

  if (loading && !detail) return <AgentDetailSkeleton />;

  if (!detail) {
    return (
      <AgentUnavailable
        serverOffline={Boolean(loadError) && !missing}
        onRetry={() => void reload()}
      />
    );
  }

  return (
    <>
      {dialog}
      <AgentDetailBody detail={detail} assignment={assignment} onChanged={() => void reload()} />
    </>
  );
}
