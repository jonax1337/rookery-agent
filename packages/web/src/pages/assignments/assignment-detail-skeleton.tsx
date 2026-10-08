import { PageBody } from '@/components/blocks/page-body';
import { StatCardsSkeleton } from '@/components/blocks/stat-cards';
import { MetaListSkeleton } from '@/components/common/meta-list';
import { Skeleton } from '@/components/ui/skeleton';

/** The loading state in the geometry the loaded page will have. */
export function AssignmentDetailSkeleton() {
  return (
    <PageBody width="3xl">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-6 w-full max-w-xl" />

      <MetaListSkeleton rows={6} />
      <StatCardsSkeleton />

      <Skeleton className="h-9 w-72 max-w-full rounded-lg" />
      <Skeleton className="h-56 w-full rounded-lg" />
    </PageBody>
  );
}
