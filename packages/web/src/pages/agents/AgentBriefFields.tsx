import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { Field, FieldDescription, FieldError, FieldLabel, FieldSet } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

import type { ValidatedAgentFieldsProps } from './agentDraft';

/** The standing brief: what the agent does, and how it writes. */
export function AgentBriefFields({ draft, set, errors }: ValidatedAgentFieldsProps) {
  return (
    <FieldSet>
      <Field>
        <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
        <Textarea
          id="agent-instructions"
          rows={12}
          placeholder="The permanent role description. Never the assistant’s persona."
          value={draft.instructions}
          aria-invalid={Boolean(errors.instructions)}
          onChange={(event) => set({ instructions: event.target.value })}
        />
        <FieldDescription>
          <SlidingNumber number={draft.instructions.length} thousandSeparator="," />{' '}
          characters. Included verbatim in every assignment system prompt.
        </FieldDescription>
        <FieldError>{errors.instructions}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-voice">Voice</FieldLabel>
        <Textarea
          id="agent-voice"
          rows={4}
          placeholder="How this person writes - two to four sentences. Leave empty for a neutral, unstyled voice."
          value={draft.voice}
          onChange={(event) => set({ voice: event.target.value })}
        />
        <FieldDescription>
          How they write, not what they can do - that stays in Instructions. Colours their reports and questions; empty stays neutral.
        </FieldDescription>
      </Field>
    </FieldSet>
  );
}
