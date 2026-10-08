import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FieldSet } from '@/components/ui/field';
import type { OrgConfig, PublicConfig } from '@/lib/types';
import { NumberField, SwitchField } from './fields';

export function OrgSection({
  draft,
  setOrg,
}: {
  draft: PublicConfig;
  setOrg(patch: Partial<OrgConfig>): void;
}) {
  const org = draft.org;

  return (
    <Fade>
      <FieldSet>
        <NumberField
          id="set-concurrency"
          label="Concurrent runs"
          value={org.maxConcurrentAssignments}
          min={1}
          max={16}
          suffix="processes"
          description="Maximum number of agent processes running at once."
          onChange={(value) => setOrg({ maxConcurrentAssignments: value })}
        />

        <NumberField
          id="set-depth"
          label="Delegation depth"
          value={org.maxDelegationDepth}
          min={1}
          max={6}
          suffix="levels"
          description="How many levels agents can delegate below the assistant."
          onChange={(value) => setOrg({ maxDelegationDepth: value })}
        />

        <SwitchField
          id="set-lazy"
          label="Keep code minimal"
          description="Agents receive Ponytail instructions: understand the task, check what already exists, and use the smallest working solution. Validation, error handling, security and accessibility remain required."
          checked={org.lazyCoding}
          onChange={(on) => setOrg({ lazyCoding: on })}
        />

        <NumberField
          id="set-max-task-runs"
          label="Automatic retries per task"
          value={org.maxTaskRuns}
          min={1}
          max={20}
          suffix="runs"
          description="How often work may re-run one task on its own initiative. Running a task yourself is never counted against this."
          onChange={(value) => setOrg({ maxTaskRuns: value })}
        />

        <SwitchField
          id="set-auto-review"
          label="Judge finished runs"
          description="After a run finishes, the assistant rates it in the background and files the rating in that agent's record. One model call per run. Off leaves only the note a hard failure writes by itself, which costs nothing."
          checked={org.autoReview}
          onChange={(on) => setOrg({ autoReview: on })}
        />

        <SwitchField
          id="set-auto-reconfig"
          label="Rewrite instructions without asking"
          description="When an agent's ratings stay weak, the assistant drafts new standing instructions for it. Off, the draft waits on the agent's page for you to accept, and the agent keeps working to its current instructions. On, it takes effect the moment it is written."
          checked={org.autoReconfig}
          disabled={!org.autoReview}
          onChange={(on) => setOrg({ autoReconfig: on })}
        />

        <SwitchField
          id="set-interactive-runs"
          label="Visible Claude Code terminal"
          description="Agents work in Claude Code's full terminal, which you can watch and type into from the run page. When the work is done it stays open for ten minutes, then only the transcript remains. Off runs them headless."
          checked={org.interactiveRuns}
          onChange={(on) => setOrg({ interactiveRuns: on })}
        />
      </FieldSet>
    </Fade>
  );
}
