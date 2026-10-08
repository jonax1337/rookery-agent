import { PageBody } from '@/components/blocks/page-body';
import { StatCardsSkeleton } from '@/components/blocks/stat-cards';
import { MetaListSkeleton } from '@/components/common/meta-list';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The loading state, in the geometry the loaded page will have: the fact
 * rows, the four numbers, the tab bar and a table. Anything shorter would
 * make the header jump the moment the request comes back.
 */
export function AgentDetailSkeleton() {
  return (
    <PageBody>
      <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-24" />
      </div>

      <MetaListSkeleton className="px-4 lg:px-6" />
      <StatCardsSkeleton />

      <div className="flex flex-col gap-4 px-4 lg:px-6">
        <Skeleton className="h-9 w-96 max-w-full rounded-lg" />
        <Skeleton className="h-80 w-full rounded-lg" />
      </div>
    </PageBody>
  );
}
