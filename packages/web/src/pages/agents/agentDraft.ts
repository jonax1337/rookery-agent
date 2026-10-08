import { z } from 'zod';

import type { DraftHandle, FieldErrors } from '@/components/forms/form-kit';
import type { AgentInput, AgentPatch } from '@/lib/api';
import { STANDARD_CHOICE, type PermissionChoice } from '@/lib/format';
import type { Agent, ProviderId } from '@/lib/types';

/**
 * What the agent form edits, and how it becomes an API call.
 *
 * Create and edit go through one `buildPatch()` instead of the two drifting
 * object literals the page used to carry - the old create path quietly left
 * out fields the edit path sent.
 *
 * `null` is a real value here: `AgentPatch` clears a column with it and
 * leaves it alone with `undefined`, which is exactly what the comboboxes
 * produce. That is why there are no `'__none__'` sentinels any more.
 */

/** The provider picker needs the same "leave it to the settings" entry. */
export type ProviderChoice = typeof STANDARD_CHOICE | ProviderId;

export interface AgentDraft {
  name: string;
  title: string;
  slug: string;
  instructions: string;
  voice: string;
  teamId: string | null;
  managerId: string | null;
  permission: PermissionChoice;
  provider: ProviderChoice;
  model: string | null;
}

export const EMPTY_DRAFT: AgentDraft = {
  name: '',
  title: '',
  slug: '',
  instructions: '',
  voice: '',
  teamId: null,
  managerId: null,
  permission: STANDARD_CHOICE,
  provider: STANDARD_CHOICE,
  model: null,
};

/** Only the typed fields are validated; the pickers cannot produce rubbish. */
export const agentSchema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
  title: z.string().trim().min(1, 'A title is required to explain what the agent does.'),
  slug: z
    .string()
    .trim()
    .regex(/^$|^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers, and hyphens only.'),
  instructions: z.string().trim().min(1, 'Instructions define the role and are required.'),
});

export interface AgentFieldsProps {
  draft: AgentDraft;
  set: DraftHandle<AgentDraft>['set'];
}

export interface ValidatedAgentFieldsProps extends AgentFieldsProps {
  errors: FieldErrors;
}

export function draftOf(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    title: agent.title,
    slug: agent.slug,
    instructions: agent.instructions,
    voice: agent.voice ?? '',
    teamId: agent.teamId ?? null,
    managerId: agent.managerId ?? null,
    permission: agent.permission ?? STANDARD_CHOICE,
    provider: agent.provider ?? STANDARD_CHOICE,
    model: agent.model ?? null,
  };
}

export function buildPatch(draft: AgentDraft): AgentPatch {
  return {
    name: draft.name.trim(),
    title: draft.title.trim(),
    instructions: draft.instructions.trim(),
    voice: draft.voice.trim() || null,
    ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
    teamId: draft.teamId,
    managerId: draft.managerId,
    permission: draft.permission === STANDARD_CHOICE ? null : draft.permission,
    provider: draft.provider === STANDARD_CHOICE ? null : draft.provider,
    model: draft.model,
  };
}

/**
 * `AgentInput` has no notion of `null` to clear a column, so the empty
 * entries of the patch are dropped instead of being sent.
 */
export function toInput(patch: AgentPatch): AgentInput {
  return {
    name: patch.name ?? '',
    title: patch.title ?? '',
    instructions: patch.instructions ?? '',
    ...(patch.voice ? { voice: patch.voice } : {}),
    ...(patch.slug ? { slug: patch.slug } : {}),
    ...(patch.teamId ? { teamId: patch.teamId } : {}),
    ...(patch.managerId ? { managerId: patch.managerId } : {}),
    ...(patch.permission ? { permission: patch.permission } : {}),
    ...(patch.provider ? { provider: patch.provider } : {}),
    ...(patch.model ? { model: patch.model } : {}),
  };
}

const SUGGESTED_SLUG_MAX_LENGTH = 40;
const SUGGESTED_SLUG_FALLBACK = 'agent';

/**
 * What the server would derive from the name when the Slug is left empty.
 *
 * A preview, not a promise: `slugify` on the server also has to make the
 * result unique, so a second "Anna" becomes `anna-2` there. Showing the
 * likely value still beats leaving the field unexplained.
 */
export function suggestSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, SUGGESTED_SLUG_MAX_LENGTH) || SUGGESTED_SLUG_FALLBACK
  );
}
