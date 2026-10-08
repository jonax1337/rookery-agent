import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { ArchiveIcon, BadgeAlertIcon as TriangleAlertIcon } from '@/components/icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import type { Agent, AgentAction } from '@/lib/types';

import { parseReplacementDraft } from './replacementDraft';
import { useProposalDecision } from './useProposalDecision';

/**
 * Stage 4's confirmation: not a modal, but a handled-in-place action item on
 * the agent's own page (docs/concepts/agent-performance-management.md,
 * section 6) - the reasoning, the drafted successor, and the editable
 * handover, with the approval right below.
 *
 * The form is seeded from the proposal once; mount it with the action's id
 * as `key` so a newer proposal starts from its own draft.
 */
export function ReplacementProposalCard({
  agent,
  action,
  onDecided,
}: {
  agent: Agent;
  action: AgentAction;
  onDecided: () => void;
}) {
  const draft = useMemo(() => parseReplacementDraft(action.reason), [action.reason]);
  const [name, setName] = useState(draft?.name ?? '');
  const [title, setTitle] = useState(draft?.title ?? agent.title);
  const [instructions, setInstructions] = useState(draft?.instructions ?? '');

  const { busy, error, submit: approve } = useProposalDecision(async () => {
    await api.replaceAgent(agent.id, { name, title, instructions });
    toast(name + ' hired in place of ' + agent.name);
    onDecided();
  });

  return (
    // No alert role here: the panel stays on the page and contains the draft
    // form, so assertive live-region semantics would re-announce every
    // keystroke; only the transient failure alert below keeps them.
    <Alert variant="destructive" role="group">
      <TriangleAlertIcon />
      <AlertTitle>Replacement proposed</AlertTitle>
      <AlertDescription>
        {agent.name} has been reconfigured and is still performing weakly. Review the successor draft below,
        adjust anything, and approve to archive {agent.name} and hire the successor in their place.
      </AlertDescription>
      {/* The alert's icon grid ends at the description; the draft form spans
          it below and drops the destructive tint so the editable fields stay
          neutral - only the framing is a warning, not the form itself. */}
      <div className="col-span-full mt-3 flex flex-col gap-4 text-card-foreground">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Why</p>
          <p className="text-sm whitespace-pre-wrap">{draft?.rationale ?? action.reason}</p>
        </div>
        <FieldGroup>
          <SuccessorInput
            id="successor-name"
            label="Successor name"
            value={name}
            onChange={setName}
            disabled={busy}
          />
          <SuccessorInput
            id="successor-title"
            label="Title"
            value={title}
            onChange={setTitle}
            disabled={busy}
          />
          <Field>
            <FieldLabel htmlFor="successor-instructions">Standing instructions</FieldLabel>
            <Textarea
              id="successor-instructions"
              rows={4}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              disabled={busy}
            />
          </Field>
        </FieldGroup>
        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>The replacement failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <div className="col-span-full mt-4">
        <Button
          variant="destructive"
          disabled={busy || !name.trim() || !title.trim() || !instructions.trim()}
          onClick={() => void approve()}
        >
          <ArchiveIcon data-icon="inline-start" />
          Archive {agent.name} and hire {name || 'successor'}
        </Button>
      </div>
    </Alert>
  );
}

function SuccessorInput({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input
        id={id}
        className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </Field>
  );
}
