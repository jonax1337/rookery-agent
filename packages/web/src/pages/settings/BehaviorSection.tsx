import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import { RadioGroup } from '@/components/ui/radio-group';
import {
  EFFORT_HINT,
  EFFORT_LABEL,
  EFFORT_LEVELS,
  PERMISSION_HINT,
  PERMISSION_LABEL,
} from '@/lib/format';
import type { EffortLevel, PermissionLevel, PublicConfig } from '@/lib/types';
import { DEFAULT_OPTION_VALUE, FADE_STEP_MS, RadioOptionField, SwitchField } from './fields';

const PERMISSION_LEVELS = Object.keys(PERMISSION_LABEL) as PermissionLevel[];

export function BehaviorSection({
  draft,
  set,
}: {
  draft: PublicConfig;
  set(patch: Partial<PublicConfig>): void;
}) {
  return (
    <>
      <Fade>
        <FieldSet>
          <FieldLegend variant="label">Effort</FieldLegend>
          <FieldDescription>How much reasoning effort the model uses before responding.</FieldDescription>
          <RadioGroup
            value={draft.defaultEffort || DEFAULT_OPTION_VALUE}
            onValueChange={(value) =>
              // Empty rather than undefined: the server's merge skips undefined,
              // so only '' actually clears a stored value.
              set({ defaultEffort: value === DEFAULT_OPTION_VALUE ? '' : (value as EffortLevel) })
            }
          >
            <RadioOptionField
              id="set-effort-default"
              value={DEFAULT_OPTION_VALUE}
              title="Provider default"
              hint="Use the provider default."
            />
            {EFFORT_LEVELS.map((level) => (
              <RadioOptionField
                key={level}
                id={'set-effort-' + level}
                value={level}
                title={EFFORT_LABEL[level]}
                hint={EFFORT_HINT[level]}
              />
            ))}
          </RadioGroup>
        </FieldSet>
      </Fade>

      <Fade delay={FADE_STEP_MS}>
        <FieldSet>
          <FieldLegend variant="label">Permissions</FieldLegend>
          <FieldDescription>
            The default permission level for each conversation.
          </FieldDescription>
          <RadioGroup
            value={draft.defaultPermission}
            onValueChange={(value) => set({ defaultPermission: value as PermissionLevel })}
          >
            {PERMISSION_LEVELS.map((level) => (
              <RadioOptionField
                key={level}
                id={'set-permission-' + level}
                value={level}
                title={PERMISSION_LABEL[level]}
                hint={PERMISSION_HINT[level]}
              />
            ))}
          </RadioGroup>
        </FieldSet>
      </Fade>

      <Fade delay={2 * FADE_STEP_MS}>
        <FieldSet>
          <FieldLegend variant="label">Conversations</FieldLegend>
          <SwitchField
            id="set-chat-terminal"
            label="Chat in Claude Code's terminal"
            description="Every conversation runs in one Claude Code terminal: messages from the chat and from Telegram are typed into it, and the terminal view shows the same session. Slash commands and background agents behave exactly as in Claude Code. Off answers each message headless."
            checked={draft.turns?.terminal ?? true}
            onChange={(on) => set({ turns: { ...draft.turns, terminal: on } })}
          />
        </FieldSet>
      </Fade>
    </>
  );
}
