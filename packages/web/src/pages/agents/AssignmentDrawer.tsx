import { BadgeAlertIcon as TriangleAlertIcon, SendIcon } from '@/components/icons';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { ResultMarkdown } from '@/components/result-markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { NO_PROJECT, PERMISSION_HINT, PERMISSION_LABEL } from '@/lib/format';
import type { Agent } from '@/lib/types';
import { useOrgState } from '@/providers/rookery-provider';

import type { AgentAssignmentHandle } from './useAgentAssignment';
import { useEffectivePermission } from './useEffectivePermission';

/** The drawer where a task is handed to the agent and its answer streams back. */
export function AssignmentDrawer({
  agent,
  assignment,
}: {
  agent: Agent;
  assignment: AgentAssignmentHandle;
}) {
  const { open, setOpen, task, setTask, projectId, setProjectId, busy, result, error, start } =
    assignment;
  const org = useOrgState();
  const permission = useEffectivePermission(agent);

  return (
    <DetailDrawer
      open={open}
      onOpenChange={setOpen}
      title={'Assignment for ' + agent.name}
      description="Runs as a fresh process in the project directory or workspace."
      className="data-[vaul-drawer-direction=right]:sm:max-w-xl"
      footer={
        <Button onClick={start} disabled={busy || !task.trim()}>
          {/* Same as the header button: the svg gets no pointer events,
              so the trigger is the drawer opening, not a hover. */}
          <SendIcon data-icon="inline-start" />
          {busy ? 'Running…' : 'Start'}
        </Button>
      }
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="assign-task">Task</FieldLabel>
          <Textarea
            id="assign-task"
            rows={5}
            required
            placeholder={'What should ' + agent.name + ' do?'}
            value={task}
            onChange={(event) => setTask(event.target.value)}
            disabled={busy}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="assign-project">Project</FieldLabel>
          <Select value={projectId} onValueChange={setProjectId} disabled={busy}>
            <SelectTrigger id="assign-project" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT}>No project</SelectItem>
              {org.projects
                .filter((project) => !project.archived)
                .map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            {permission
              ? 'Permission ' + PERMISSION_LABEL[permission] + ': ' + PERMISSION_HINT[permission]
              : 'The run uses the permission level from Settings.'}
          </FieldDescription>
        </Field>
      </FieldGroup>

      {/* Same build as on /org/assignments/:id and in the form frame:
          `Alert` brings `role="alert"` with it, where a bare <p> told a
          screen reader nothing. */}
      {error ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>The run failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      ) : null}

      {result && (
        <div className="rounded-xl border p-4">
          <ResultMarkdown text={result} />
        </div>
      )}
    </DetailDrawer>
  );
}
