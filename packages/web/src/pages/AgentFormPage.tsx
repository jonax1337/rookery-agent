import { useCallback, useEffect, useId, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArchiveIcon, ArchiveIcon as ArchiveRestoreIcon, UsersRoundIcon } from "@/components/icons";
import { toast } from 'sonner';
import { z } from 'zod';

import { api, type AgentInput, type AgentPatch } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import {
  PERMISSION_CHOICES,
  PROVIDER_LABEL,
  STANDARD_CHOICE,
  type PermissionChoice,
} from '@/lib/format';
import type { Agent, ProviderId } from '@/lib/types';
import { useConfig, useOrgState } from '@/providers/rookery-provider';
import { Blur } from '@/components/animate-ui/primitives/effects/blur';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { PageBody } from '@/components/blocks/page-body';
import { FormPage } from '@/components/blocks/form-page';
import { usePageMeta } from '@/components/shell/page-meta';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import {
  ChoiceField,
  FormFieldsSkeleton,
  FormHeaderActions,
  useDraft,
  useFormSubmit,
  type ChoiceOption,
} from '@/components/forms/form-kit';
import { ProviderIcon } from '@/components/provider-icon';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * Hiring and re-briefing, as one page.
 *
 * Create and edit are the same form because the fields are identical; only
 * the starting point and the destination differ. Both go through one
 * `buildPatch()` instead of the two drifting object literals the page used to
 * carry - the old create path quietly left out fields the edit path sent.
 *
 * `null` is a real value here: `AgentPatch` clears a column with it and
 * leaves it alone with `undefined`, which is exactly what the comboboxes
 * produce. That is why there are no `'__none__'` sentinels any more.
 */

/** The provider picker needs the same "leave it to the settings" entry. */
type ProviderChoice = typeof STANDARD_CHOICE | ProviderId;

interface AgentDraft {
  name: string;
  title: string;
  slug: string;
  instructions: string;
  teamId: string | null;
  managerId: string | null;
  permission: PermissionChoice;
  provider: ProviderChoice;
  model: string | null;
}

const EMPTY: AgentDraft = {
  name: '',
  title: '',
  slug: '',
  instructions: '',
  teamId: null,
  managerId: null,
  permission: STANDARD_CHOICE,
  provider: STANDARD_CHOICE,
  model: null,
};

/** Only the typed fields are validated; the pickers cannot produce rubbish. */
const schema = z.object({
  name: z.string().trim().min(1, 'A name is required.'),
  title: z.string().trim().min(1, 'A title is required to explain what the agent does.'),
  slug: z
    .string()
    .trim()
    .regex(/^$|^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers, and hyphens only.'),
  instructions: z.string().trim().min(1, 'Instructions define the role and are required.'),
});

function draftOf(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    title: agent.title,
    slug: agent.slug,
    instructions: agent.instructions,
    teamId: agent.teamId ?? null,
    managerId: agent.managerId ?? null,
    permission: agent.permission ?? STANDARD_CHOICE,
    provider: agent.provider ?? STANDARD_CHOICE,
    model: agent.model ?? null,
  };
}

/**
 * One shape for both calls. `AgentPatch` accepts `null` to clear a column;
 * `AgentInput` has no such notion, so `toInput` drops the empty entries
 * instead of sending them.
 */
function buildPatch(draft: AgentDraft): AgentPatch {
  return {
    name: draft.name.trim(),
    title: draft.title.trim(),
    instructions: draft.instructions.trim(),
    ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
    teamId: draft.teamId,
    managerId: draft.managerId,
    permission: draft.permission === STANDARD_CHOICE ? null : draft.permission,
    provider: draft.provider === STANDARD_CHOICE ? null : draft.provider,
    model: draft.model,
  };
}

function toInput(patch: AgentPatch): AgentInput {
  return {
    name: patch.name ?? '',
    title: patch.title ?? '',
    instructions: patch.instructions ?? '',
    ...(patch.slug ? { slug: patch.slug } : {}),
    ...(patch.teamId ? { teamId: patch.teamId } : {}),
    ...(patch.managerId ? { managerId: patch.managerId } : {}),
    ...(patch.permission ? { permission: patch.permission } : {}),
    ...(patch.provider ? { provider: patch.provider } : {}),
    ...(patch.model ? { model: patch.model } : {}),
  };
}

/**
 * What the server would derive from the name when the Slug is left empty.
 *
 * A preview, not a promise: `slugify` on the server also has to make the
 * result unique, so a second "Anna" becomes `anna-2` there. Showing the
 * likely value still beats leaving the field unexplained.
 */
function suggestSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

export function AgentFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const org = useOrgState();
  const { config, providers } = useConfig();
  const { confirm, dialog } = useConfirm();

  const editing = Boolean(id);
  const agent = org.agents.find((entry) => entry.id === id);

  const formId = useId();
  const { draft, dirty, set, hydrate, markSaved } = useDraft<AgentDraft>(EMPTY);

  // Filled once per agent: the company refetches on every socket broadcast,
  // and a refetch must not throw away what is being typed.
  useEffect(() => {
    if (!agent) return;
    hydrate(agent.id, () => draftOf(agent));
  }, [agent, hydrate]);

  /* -------------------------------- Auswahl ------------------------------- */

  const teamOptions = useMemo<EntityOption[]>(
    () => org.teams.map((team) => ({ value: team.id, label: team.name })),
    [org.teams],
  );

  // An agent cannot report to itself, and an archived one cannot lead.
  const managerOptions = useMemo<EntityOption[]>(
    () =>
      org.agents
        .filter((entry) => entry.id !== id && !entry.archived)
        .map((entry) => ({ value: entry.id, label: entry.name, hint: entry.title })),
    [id, org.agents],
  );

  const providerOptions = useMemo<ChoiceOption<ProviderChoice>[]>(
    () => [
      {
        value: STANDARD_CHOICE,
        label: 'Default',
        description: config
          ? 'Currently ' + (PROVIDER_LABEL[config.defaultProvider] ?? config.defaultProvider) + '.'
          : 'Uses the default from Settings.',
      },
      ...providers.map((status) => ({
        value: status.id as ProviderChoice,
        label: PROVIDER_LABEL[status.id] ?? status.displayName,
        icon: <ProviderIcon provider={status.id} label={status.displayName} className="size-4 text-muted-foreground" />,
        ...(!status.available ? { description: 'Not installed. Work for this agent will fail.' } : {}),
      })),
    ],
    [config, providers],
  );

  // Only `GET /api/providers` carries `models[]`; the health payload does not.
  const effectiveProvider: ProviderId =
    draft.provider === STANDARD_CHOICE ? (config?.defaultProvider ?? 'claude') : draft.provider;
  const models = providers.find((entry) => entry.id === effectiveProvider)?.models ?? [];
  // A configured profile has no hardcoded label here, only the name its
  // catalogue entry gave it - without which the sentence below reads
  // "Models from undefined".
  const effectiveLabel =
    PROVIDER_LABEL[effectiveProvider] ??
    providers.find((entry) => entry.id === effectiveProvider)?.displayName ??
    effectiveProvider;

  const modelOptions = useMemo<EntityOption[]>(() => {
    const options: EntityOption[] = models.map((model) => ({ value: model, label: model }));
    // A model the provider no longer lists still has to be visible, or an
    // edit would silently drop it the moment anything else is saved.
    if (draft.model && !models.includes(draft.model)) {
      options.unshift({ value: draft.model, label: draft.model, hint: 'unknown' });
    }
    return options;
  }, [draft.model, models]);

  /* -------------------------------- Sichern ------------------------------- */

  const { errors, failure, saving, submit } = useFormSubmit(schema, draft, async () => {
    const patch = buildPatch(draft);
    const saved =
      editing && id ? await api.updateAgent(id, patch) : await api.createAgent(toInput(patch));
    markSaved();
    await org.refresh();
    toast(editing ? 'Agent saved' : saved.name + ' hired');
    void navigate('/org/agents/' + saved.id);
  });

  const setArchived = useCallback(
    async (archived: boolean): Promise<void> => {
      if (!id || !agent) return;
      if (archived) {
        const ok = await confirm({
          title: 'Agent archive?',
          description:
            agent.name +
            ' will no longer receive new assignments and will disappear from selection lists. Previous assignments and memories will remain.',
          confirmLabel: 'Archive',
          destructive: true,
        });
        if (!ok) return;
      }
      try {
        await api.updateAgent(id, { archived });
        await org.refresh();
        toast(archived ? agent.name + ' archived' : agent.name + ' is active again');
        if (archived) void navigate('/org/agents');
      } catch (caught) {
        reportFailure('Update', caught);
      }
    },
    [agent, confirm, id, navigate, org],
  );

  /* --------------------------------- Kopf --------------------------------- */

  const leaf = editing ? (agent?.name ?? 'Edit agent') : 'Hire agent';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Organization', to: '/org/agents' },
        { label: 'Agents', to: '/org/agents' },
        { label: leaf },
      ],
      actions: (
        <FormHeaderActions
          form={formId}
          cancelTo="/org/agents"
          submitting={saving}
          submitDisabled={!dirty || saving}
          menu={
            editing && agent
              ? [
                  agent.archived
                    ? {
                        label: 'Restore',
                        icon: ArchiveRestoreIcon,
                        onSelect: () => void setArchived(false),
                      }
                    : {
                        label: 'Archive',
                        icon: ArchiveIcon,
                        destructive: true,
                        onSelect: () => void setArchived(true),
                      },
                ]
              : []
          }
        />
      ),
    },
    [agent, dirty, editing, formId, saving, setArchived],
  );

  /* ------------------------------- Zustände ------------------------------- */

  if (editing && !agent && !org.loading) {
    return (
      <PageBody width="3xl">
        {/* The flex classes keep the empty state stretching the page the way
            it did as a direct child of the rhythm container. */}
        <Fade className="flex flex-1 flex-col">
          <EmptyState
            icon={UsersRoundIcon}
            title="This agent no longer exists"
            description="The agent was removed or never existed."
            actionLabel="View agents"
            actionTo="/org/agents"
          />
        </Fade>
      </PageBody>
    );
  }

  if (editing && !agent) {
    return (
      <PageBody width="3xl">
        <FormFieldsSkeleton fields={5} />
      </PageBody>
    );
  }

  const slugHint = draft.slug.trim()
    ? 'Lowercase letters, numbers, and hyphens.'
    : 'Leave empty and the server will derive it from the name, likely “' +
      suggestSlug(draft.name || 'Agent') +
      '“.';

  return (
    <PageBody width="3xl">
      {dialog}
      <FormPage
        formId={formId}
        showActions={false}
        onSubmit={submit}
        error={failure}
        description={
          <Blur>
            {editing
              ? 'Role, instructions, and Memory persist; every run still starts a fresh process.'
              : 'An agent is a permanent team member: role, instructions, and personal Memory persist.'}
          </Blur>
        }
      >
        <Fade>
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
                placeholder={suggestSlug(draft.name || 'Agent')}
                value={draft.slug}
                aria-invalid={Boolean(errors.slug)}
                onChange={(event) => set({ slug: event.target.value })}
              />
              <FieldDescription>{slugHint}</FieldDescription>
              <FieldError>{errors.slug}</FieldError>
            </Field>
          </FieldSet>
        </Fade>

        <FieldSeparator />

        <Fade delay={50}>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="agent-team">Team</FieldLabel>
              <EntityCombobox
                id="agent-team"
                options={teamOptions}
                value={draft.teamId}
                onChange={(teamId) => set({ teamId })}
                placeholder="No team"
                emptyLabel="No team found"
              />
              <FieldDescription>
                Without a team, the agent works independently. You can also change the assignment
                from the team page.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-manager">Manager</FieldLabel>
              <EntityCombobox
                id="agent-manager"
                options={managerOptions}
                value={draft.managerId}
                onChange={(managerId) => set({ managerId })}
                placeholder="The assistant"
                emptyLabel="No agent found"
              />
              <FieldDescription>
                Without a manager, the agent reports to the assistant.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-permission-standard">Permission</FieldLabel>
              <ChoiceField
                id="agent-permission"
                options={PERMISSION_CHOICES}
                value={draft.permission}
                onChange={(permission) => set({ permission })}
              />
            </Field>
          </FieldSet>
        </Fade>

        <FieldSeparator />

        <Fade delay={100}>
          <FieldSet>
            <Field>
              <FieldLabel htmlFor="agent-provider-standard">Provider</FieldLabel>
              <ChoiceField
                id="agent-provider"
                options={providerOptions}
                value={draft.provider}
                onChange={(provider) => set({ provider, model: null })}
              />
              <FieldDescription>
                Changing provider resets the model selection.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-model">Model</FieldLabel>
              <EntityCombobox
                id="agent-model"
                options={modelOptions}
                value={draft.model}
                onChange={(model) => set({ model })}
                placeholder="Default model"
                emptyLabel="No model found"
              />
              <FieldDescription>
                {modelOptions.length
                  ? 'Models from ' +
                    effectiveLabel +
                    (draft.provider === STANDARD_CHOICE ? ' (Default)' : '') +
                    '. Empty means the provider chooses.'
                  : effectiveLabel +
                    ' currently reports no models. Empty means the provider chooses.'}
              </FieldDescription>
            </Field>
          </FieldSet>
        </Fade>

        <FieldSeparator />

        <Fade delay={150}>
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
          </FieldSet>
        </Fade>
      </FormPage>
    </PageBody>
  );
}
