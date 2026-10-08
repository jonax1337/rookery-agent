import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';

import { SendIcon } from '@/components/icons';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { collectErrors, FormField, type FieldErrors } from '@/components/forms/form-kit';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import type { TurnHandlers } from '@/lib/socket';
import type { Agent, AssignPayload } from '@/lib/types';

import { OptionCombobox } from './option-combobox';

const assignSchema = z.object({
  agent: z.string().min(1, 'Select an agent.'),
  task: z.string().trim().min(3, 'The assignment needs at least one sentence.'),
});

/**
 * Hand an agent a job, from the page that lists what came of it.
 *
 * The turn runs over the socket exactly as it does in the chat - the drawer
 * only needs to know that it started; the row appears in the table as soon as
 * the first broadcast names it.
 */
export function AssignAgentDrawer({
  open,
  onOpenChange,
  agents,
  projects,
  onAssigned,
  assign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  projects: { id: string; name: string }[];
  onAssigned: () => void;
  assign: (payload: AssignPayload, handlers: TurnHandlers) => string;
}) {
  const [agentId, setAgentId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [task, setTask] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const agentOptions = useMemo(
    () =>
      agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ value: agent.id, label: agent.name + ' · ' + agent.slug })),
    [agents],
  );
  const projectOptions = useMemo(
    () => projects.map((project) => ({ value: project.id, label: project.name })),
    [projects],
  );

  const submit = (): void => {
    const parsed = assignSchema.safeParse({ agent: agentId ?? '', task });
    if (!parsed.success) {
      setErrors(collectErrors(parsed.error));
      return;
    }
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      setErrors({ agent: 'This agent is no longer available.' });
      return;
    }

    setErrors({});
    setBusy(true);
    assign(
      {
        agent: agent.slug,
        task: parsed.data.task,
        ...(projectId ? { projectId } : {}),
      },
      {
        // The live rows arrive on the org socket anyway; this turn's own
        // stream is only interesting for its end.
        onEvent: () => undefined,
        onDone: () => {
          setBusy(false);
          onAssigned();
          toast('Assignment completed');
        },
        onError: (message) => {
          setBusy(false);
          toast.error('Assignment failed', { description: message });
        },
      },
    );

    toast(agent.name + ' has been assigned');
    setTask('');
    onOpenChange(false);
    onAssigned();
  };

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Assign agent"
      description="The run starts immediately and appears in the table."
      closeLabel="Cancel"
      footer={
        <Button onClick={submit} disabled={busy}>
          {busy ? <Spinner aria-label="Starting" /> : <SendIcon data-icon="inline-start" />}
          Assign
        </Button>
      }
    >
      <FieldGroup>
        {/* FormField rather than a hand-wired Field: `data-invalid` alone only
            painted the group red, while the control itself carried neither
            `aria-invalid` nor a pointer to its message. */}
        <FormField id="assign-agent" label="Agent" error={errors.agent}>
          {(control) => (
            <OptionCombobox
              {...control}
              options={agentOptions}
              value={agentId}
              onChange={setAgentId}
              placeholder="Select agent"
            />
          )}
        </FormField>

        <FormField
          id="assign-project"
          label="Project"
          description="Determines which directory the agent works in."
        >
          {(control) => (
            <OptionCombobox
              {...control}
              options={projectOptions}
              value={projectId}
              onChange={setProjectId}
              placeholder="No project"
            />
          )}
        </FormField>

        <FormField id="assign-task" label="Task" error={errors.task}>
          {(control) => (
            <Textarea
              {...control}
              rows={6}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="What should be done?"
            />
          )}
        </FormField>
      </FieldGroup>
    </DetailDrawer>
  );
}
