import { useState } from 'react';
import type { ComponentProps } from 'react';
import { MemoryPanel } from '@/components/MemoryPanel';
import { MemoryGraph3D } from '@/components/MemoryGraph3D';
import { MemoryDetail } from '@/components/MemoryDetail';
import { MemoryTimeline } from '@/components/MemoryTimeline';
import { SleepCard } from '@/components/SleepCard';
import type { useMemoryGraph, useSleep } from '@/hooks/useMemories';
import type { MemoryRecord } from '@/lib/types';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type MemoryPanelProps = ComponentProps<typeof MemoryPanel>;

interface MemoryPageProps extends MemoryPanelProps {
  graph: ReturnType<typeof useMemoryGraph>;
  sleep: ReturnType<typeof useSleep>;
  onPatch(id: string, changes: { pinned?: boolean; dormant?: boolean }): void;
}

/**
 * The memory, three ways.
 *
 * The graph shows the shape of what is known, the timeline shows how it got
 * that way, and the list is still the fastest route to one specific fact.
 * None of the three replaces the others, so all three stay.
 */
export function MemoryPage({ graph, sleep, onPatch, ...panel }: MemoryPageProps) {
  const [selected, setSelected] = useState<MemoryRecord | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4">
        <SleepCard
          status={sleep.status}
          runs={sleep.runs}
          phase={sleep.phase}
          cycle={sleep.cycle}
          busy={sleep.busy}
          onStart={() => void sleep.start()}
          onCancel={() => void sleep.cancel()}
          onUndo={sleep.undo}
        />

        <Tabs defaultValue="graph" className="min-h-0 flex-1">
          <TabsList>
            <TabsTrigger value="graph">Netz</TabsTrigger>
            <TabsTrigger value="list">Liste</TabsTrigger>
            <TabsTrigger value="timeline">Zeitachse</TabsTrigger>
          </TabsList>

          <TabsContent value="graph" className="h-[680px] flex-none">
            <MemoryGraph3D
              graph={graph.graph}
              entities={graph.entities}
              entity={graph.entity}
              onEntity={graph.setEntity}
              includeDormant={graph.includeDormant}
              onIncludeDormant={graph.setIncludeDormant}
              loading={graph.loading}
              onSelect={setSelected}
            />
          </TabsContent>

          <TabsContent value="list" className="h-[640px] flex-none">
            <MemoryPanel {...panel} />
          </TabsContent>

          <TabsContent value="timeline" className="h-[640px] flex-none">
            <MemoryTimeline memories={graph.graph?.memories ?? []} runs={sleep.runs} onSelect={setSelected} />
          </TabsContent>
        </Tabs>
      </div>

      <MemoryDetail
        memory={selected}
        onClose={() => setSelected(null)}
        onPin={(id, pinned) => {
          onPatch(id, { pinned });
          setSelected((current) => (current && current.id === id ? { ...current, pinned } : current));
        }}
        onWake={(id) => {
          onPatch(id, { dormant: false });
          setSelected((current) => (current && current.id === id ? { ...current, dormantAt: undefined } : current));
        }}
        onForget={(id) => {
          panel.onForget(id);
          setSelected(null);
        }}
      />
    </div>
  );
}
