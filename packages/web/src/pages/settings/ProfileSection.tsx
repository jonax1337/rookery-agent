import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { AssistantProfile } from '@/components/forms/assistant-profile';
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { PublicConfig } from '@/lib/types';
import { FADE_STEP_MS, SwitchField } from './fields';

export function ProfileSection({
  draft,
  set,
}: {
  draft: PublicConfig;
  set(patch: Partial<PublicConfig>): void;
}) {
  return (
    <>
      <IdentityFields draft={draft} set={set} />
      <Fade delay={FADE_STEP_MS}>
        <AssistantProfile />
      </Fade>
    </>
  );
}

function IdentityFields({
  draft,
  set,
}: {
  draft: PublicConfig;
  set(patch: Partial<PublicConfig>): void;
}) {
  return (
    <Fade>
      <FieldSet>
        <Field>
          <FieldLabel htmlFor="set-name">Assistant name</FieldLabel>
          <Input
            id="set-name"
            value={draft.assistantName}
            onChange={(event) => set({ assistantName: event.target.value })}
          />
          <FieldDescription>
            Display name in the sidebar and spoken replies. Also used by default profile templates; imported Markdown keeps its own identity.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="set-user">User name</FieldLabel>
          <Input
            id="set-user"
            value={draft.userName ?? ''}
            placeholder="optional"
            onChange={(event) => set({ userName: event.target.value })}
          />
        </Field>

        <SwitchField
          id="set-formal"
          label="Formal address"
          description="Use a formal register in both chat and voice conversations."
          checked={draft.formalAddress}
          onChange={(on) => set({ formalAddress: on })}
        />

        <Field>
          <FieldLabel htmlFor="set-honorific">Honorific</FieldLabel>
          <Input
            id="set-honorific"
            value={draft.honorific}
            placeholder="optional"
            onChange={(event) => set({ honorific: event.target.value })}
          />
          <FieldDescription>
            An occasional form of address, such as “Sir”. Leave empty to use the user name above.
          </FieldDescription>
        </Field>
      </FieldSet>
    </Fade>
  );
}
