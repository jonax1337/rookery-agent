import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { PageBody } from '@/components/blocks/page-body';
import { EmptyState, ServerOffline } from '@/components/common/empty-state';
import { MetaListSkeleton } from '@/components/common/meta-list';
import { StatCardsSkeleton } from '@/components/blocks/stat-cards';
import { Skeleton } from '@/components/ui/skeleton';
import { ClipboardEmptyIcon } from '@/pages/tasks/empty-state-icons';

export function TaskNotFound() {
  return (
    <PageBody width="3xl">
      <Fade className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={ClipboardEmptyIcon}
          title="This task does not exist"
          description="The entry was deleted, or the address is incorrect."
          actionLabel="View tasks"
          actionTo="/tasks"
        />
      </Fade>
    </PageBody>
  );
}

export function TaskLoadFailure({ onRetry }: { onRetry(): void }) {
  return (
    <PageBody width="3xl">
      <Fade className="flex min-w-0 flex-1 flex-col">
        <ServerOffline onRetry={onRetry} />
      </Fade>
    </PageBody>
  );
}

/**
 * The loading state in the geometry the loaded page will have - facts, four
 * numbers, a tab bar, a panel - so nothing jumps when the request lands.
 */
export function TaskDetailSkeleton() {
  return (
    <PageBody>
      <MetaListSkeleton className="px-4 lg:px-6" />
      <StatCardsSkeleton />

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <Skeleton className="h-9 w-96 max-w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    </PageBody>
  );
}
