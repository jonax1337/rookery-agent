import { Field, FieldDescription, FieldError, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

import { suggestSlug, type ValidatedAgentFieldsProps } from './agentDraft';

/** Name, title and the slug the agent is addressed by. */
export function AgentIdentityFields({ draft, set, errors }: ValidatedAgentFieldsProps) {
  const slugSuggestion = suggestSlug(draft.name);
  const slugHint = draft.slug.trim()
    ? 'Lowercase letters, numbers, and hyphens.'
    : 'Leave empty and the server will derive it from the name, likely “' + slugSuggestion + '”.';

  return (
    <FieldSet>
      <Field>
        <FieldLabel htmlFor="agent-name">Name</FieldLabel>
        <Input
          id="agent-name"
          value={draft.name}
          aria-invalid={Boolean(errors.name)}
          onChange={(event) => set({ name: event.target.value })}
        />
        <FieldError>{errors.name}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-title">Title</FieldLabel>
        <Input
          id="agent-title"
          placeholder="e.g. Backend engineer"
          value={draft.title}
          aria-invalid={Boolean(errors.title)}
          onChange={(event) => set({ title: event.target.value })}
        />
        <FieldError>{errors.title}</FieldError>
      </Field>

      <Field>
        <FieldLabel htmlFor="agent-slug">Slug</FieldLabel>
        <Input
          id="agent-slug"
          className="font-mono"
          placeholder={slugSuggestion}
          value={draft.slug}
          aria-invalid={Boolean(errors.slug)}
          onChange={(event) => set({ slug: event.target.value })}
        />
        <FieldDescription>{slugHint}</FieldDescription>
        <FieldError>{errors.slug}</FieldError>
      </Field>
    </FieldSet>
  );
}
