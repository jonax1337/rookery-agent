import type { ReactNode } from 'react';

import { relativeTimeCell } from '@/components/blocks/data-table/table-columns';
import { EmptyState } from '@/components/common/empty-state';
import { ClipboardCheckIcon } from '@/components/icons';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AgentAction } from '@/lib/types';

const ACTION_KIND_LABEL: Record<AgentAction['kind'], string> = {
  note: 'Note',
  reconfig: 'Reconfigured',
  'reconfig-proposal': 'Instructions proposed',
  probation: 'Replacement proposed',
  replace: 'Replaced',
};

/**
 * The personnel record, most recent first, with a reconfig's before/after
 * expandable. The agent's own `agentNote` text is marked as seen by the
 * agent - everything else here never reaches its prompt (decision E2).
 */
export function PersonnelRecordCard({ actions }: { actions: AgentAction[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Personnel record</CardTitle>
        <CardDescription>Notes, reconfigs and proposals, most recent first.</CardDescription>
      </CardHeader>
      <CardContent>
        {actions.length === 0 ? (
          <EmptyState
            icon={ClipboardCheckIcon}
            title="Nothing on record"
            description="No development note, reconfig or proposal has been logged yet."
            variant="plain"
            size="sm"
          />
        ) : (
          <Accordion type="single" collapsible className="w-full">
            {actions.map((action) => (
              <AccordionItem key={action.id} value={action.id}>
                <AccordionTrigger className="text-sm">
                  <span className="flex flex-1 items-center gap-2 text-left">
                    <Badge variant="outline">{ACTION_KIND_LABEL[action.kind]}</Badge>
                    <span className="text-muted-foreground">{relativeTimeCell(action.createdAt)}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="flex flex-col gap-3">
                  <ActionDetails action={action} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}

function ActionDetails({ action }: { action: AgentAction }) {
  const showsDiff = action.kind === 'reconfig' && action.beforeText && action.afterText;
  const showsReason = action.kind !== 'reconfig' || !action.agentNote;

  return (
    <>
      {action.agentNote ? (
        <LabelledText label="Feedback shown to the agent" textClassName="text-sm">
          {action.agentNote}
        </LabelledText>
      ) : null}
      {showsDiff ? (
        <div className="flex flex-col gap-2">
          <LabelledText
            label="Before"
            textClassName="text-sm whitespace-pre-wrap text-muted-foreground line-through decoration-muted-foreground/40"
          >
            {action.beforeText}
          </LabelledText>
          <LabelledText label="After" textClassName="text-sm whitespace-pre-wrap">
            {action.afterText}
          </LabelledText>
        </div>
      ) : null}
      {showsReason ? (
        <LabelledText
          label="Internal reason"
          textClassName="text-sm whitespace-pre-wrap text-muted-foreground"
        >
          {action.reason}
        </LabelledText>
      ) : null}
    </>
  );
}

function LabelledText({
  label,
  textClassName,
  children,
}: {
  label: string;
  textClassName: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={textClassName}>{children}</p>
    </div>
  );
}
