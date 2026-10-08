import { toast } from 'sonner';

import { BadgeAlertIcon as TriangleAlertIcon, PenToolIcon as PencilIcon } from '@/components/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { Agent, AgentAction } from '@/lib/types';

import { useProposalDecision } from './useProposalDecision';

/**
 * Stage 2, waiting for a person: the assistant drafted new standing
 * instructions and did not apply them.
 *
 * Both texts are shown because the whole point of not applying it is that
 * somebody reads what would change. There is no reject button - a proposal
 * that is never accepted simply never takes effect, and the agent's next
 * good stretch clears the stage by itself - so the only action here is the
 * one that has a consequence.
 */
export function ReconfigProposalCard({
  agent,
  action,
  onDecided,
}: {
  agent: Agent;
  action: AgentAction;
  onDecided: () => void;
}) {
  const { busy, error, submit: accept } = useProposalDecision(async () => {
    await api.applyReconfig(agent.id, action.id);
    toast('New instructions are in effect for ' + agent.name);
    onDecided();
  });

  return (
    <Alert role="group">
      <TriangleAlertIcon />
      <AlertTitle>New instructions proposed</AlertTitle>
      <AlertDescription>
        {agent.name}'s ratings have stayed weak, so the assistant drafted a replacement for their standing
        instructions. Nothing has changed yet — {agent.name} is still working to the current text.
      </AlertDescription>
      <div className="col-span-full mt-3 flex flex-col gap-4 text-card-foreground">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Why</p>
          <p className="text-sm whitespace-pre-wrap">{action.reason}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">Current</p>
            <p className="text-sm whitespace-pre-wrap">{action.beforeText || agent.instructions}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">Proposed</p>
            <p className="text-sm whitespace-pre-wrap">{action.afterText}</p>
          </div>
        </div>
        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>The change failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <div className="col-span-full mt-4">
        <Button disabled={busy} onClick={() => void accept()}>
          <PencilIcon data-icon="inline-start" />
          Apply these instructions
        </Button>
      </div>
    </Alert>
  );
}
