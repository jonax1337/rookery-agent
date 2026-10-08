import { DataTable } from '@/components/blocks/data-table/data-table';
import { EmptyState } from '@/components/common/empty-state';
import { MEMORY_COLUMN_LABELS, buildMemoryColumns } from '@/components/common/memory-columns';
import { BrainIcon } from '@/components/icons';
import type { Agent, MemoryRecord } from '@/lib/types';

import { MEMORY_LIMIT, isAtLimit } from './agentLimits';

// The same table the memory list draws, in its short form.
const MEMORY_COLUMNS = buildMemoryColumns({ compact: true });

/** What the agent has learned from its own assignments, newest first. */
export function MemoriesTab({
  agent,
  memories,
  onAssign,
}: {
  agent: Agent;
  memories: MemoryRecord[];
  onAssign: () => void;
}) {
  return (
    <DataTable
      flush
      idPrefix="agent-memories"
      data={memories}
      columns={MEMORY_COLUMNS}
      searchable
      searchPlaceholder="Search memories"
      searchText={(row) => row.content + ' ' + row.tags.join(' ')}
      initialSorting={[{ id: 'createdAt', desc: true }]}
      groupTime={(row) => row.createdAt}
      groupSortId="createdAt"
      capped={isAtLimit(memories, MEMORY_LIMIT)}
      rowLabel={{ singular: 'Memory', plural: 'Memories' }}
      columnLabels={MEMORY_COLUMN_LABELS}
      empty={
        <EmptyState
          icon={BrainIcon}
          title="Nothing learned yet"
          description={agent.name + ' learns from its own assignments, not from this conversation.'}
          actionLabel="Hand over a task"
          onAction={onAssign}
          variant="plain"
          size="sm"
        />
      }
    />
  );
}
