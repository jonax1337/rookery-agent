import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { UserIcon } from '@/components/icons';

/**
 * What stands where the agent should be: a stopped server and a deleted
 * agent are not the same news, and only the first has a retry that can work.
 */
export function AgentUnavailable({
  serverOffline,
  onRetry,
}: {
  serverOffline: boolean;
  onRetry: () => void;
}) {
  return (
    <PageBody width="3xl">
      {serverOffline ? (
        <ServerOffline onRetry={onRetry} />
      ) : (
        <EmptyState
          icon={UserIcon}
          title="This agent does not exist"
          description="The entry was deleted, or the address is incorrect."
          actionLabel="View agents"
          actionTo="/org/agents"
        />
      )}
    </PageBody>
  );
}
