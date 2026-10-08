import { EmptyState } from '@/components/common/empty-state';
import { PenToolIcon as PencilIcon } from '@/components/icons';
import { ResultMarkdown } from '@/components/result-markdown';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { shorten } from '@/lib/format';
import type { Agent } from '@/lib/types';

/** Past this many characters the instructions get a fold instead of a wall. */
const INSTRUCTIONS_FOLD = 1200;

/** The standing instructions every run of the agent starts with. */
export function InstructionsCard({ agent }: { agent: Agent }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Instructions</CardTitle>
        <CardDescription>
          The exact assignment text that {agent.name} starts every run with.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <InstructionsBody agent={agent} />
      </CardContent>
    </Card>
  );
}

function InstructionsBody({ agent }: { agent: Agent }) {
  const instructions = agent.instructions.trim();

  if (instructions === '') {
    return (
      <EmptyState
        icon={PencilIcon}
        title="No instructions provided"
        description="Without custom instructions, the agent works only from the brief."
        actionLabel="Edit"
        actionTo={'/org/agents/' + agent.id + '/edit'}
        variant="plain"
        size="sm"
      />
    );
  }

  if (instructions.length <= INSTRUCTIONS_FOLD) {
    return <ResultMarkdown text={instructions} />;
  }

  return (
    <>
      <ResultMarkdown text={shorten(instructions, INSTRUCTIONS_FOLD)} />
      {/* The fold, not a truncation: the whole text stays one
          click away instead of being cut off for good. */}
      <Accordion type="single" collapsible>
        <AccordionItem value="full" className="border-b-0">
          <AccordionTrigger>Show full text</AccordionTrigger>
          <AccordionContent>
            <ResultMarkdown text={instructions} />
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
}
