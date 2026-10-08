import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AgentDetail } from '@/lib/types';

import { AssignmentsTab } from './AssignmentsTab';
import { InstructionsCard } from './InstructionsCard';
import { MemoriesTab } from './MemoriesTab';
import { ReportsTab } from './ReportsTab';

/** Four lists about the agent behind tabs, so the page above them stays short. */
export function AgentTabs({ detail, onAssign }: { detail: AgentDetail; onAssign: () => void }) {
  const { agent, assignments, reports, memories } = detail;

  return (
    <Tabs defaultValue="assignments">
      <TabsList>
        <TabsTrigger value="assignments">Runs</TabsTrigger>
        <TabsTrigger value="reports">Direct reports</TabsTrigger>
        <TabsTrigger value="memories">Memory</TabsTrigger>
        <TabsTrigger value="instructions">Instructions</TabsTrigger>
      </TabsList>

      <TabsContent value="assignments" className="mt-4">
        <AssignmentsTab agent={agent} assignments={assignments} onAssign={onAssign} />
      </TabsContent>

      <TabsContent value="reports" className="mt-4">
        <ReportsTab agent={agent} reports={reports} />
      </TabsContent>

      <TabsContent value="memories" className="mt-4">
        <MemoriesTab agent={agent} memories={memories} onAssign={onAssign} />
      </TabsContent>

      <TabsContent value="instructions" className="mt-4">
        <InstructionsCard agent={agent} />
      </TabsContent>
    </Tabs>
  );
}
