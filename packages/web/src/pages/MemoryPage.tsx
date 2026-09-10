import type { ComponentProps } from 'react';
import { MemoryPanel } from '@/components/MemoryPanel';

type MemoryPageProps = ComponentProps<typeof MemoryPanel>;

export function MemoryPage(props: MemoryPageProps) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <div className="mx-auto h-full w-full max-w-3xl">
        <MemoryPanel {...props} />
      </div>
    </div>
  );
}
