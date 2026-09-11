import { useCallback, useEffect, useId, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ArchiveIcon, ArchiveRestoreIcon, UsersRoundIcon } from 'lucide-react';
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
import { formatNumber } from '@/lib/stats';
import type { Agent, ProviderId } from '@/lib/types';
import { useConfig, useOrgState } from '@/providers/rookery-provider';
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
  name: z.string().trim().min(1, 'Ein Name ist Pflicht.'),
  title: z.string().trim().min(1, 'Ohne Titel weiß niemand, wofür der Agent da ist.'),
  slug: z
    .string()
    .trim()
    .regex(/^$|^[a-z0-9][a-z0-9-]*$/, 'Nur Kleinbuchstaben, Ziffern und Bindestriche.'),
  instructions: z.string().trim().min(1, 'Die Anweisungen sind die Rolle. Sie sind Pflicht.'),
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
 * What the server would derive from the name when the Kürzel is left empty.
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
        label: 'Standard',
        description: config
          ? 'Derzeit ' + PROVIDER_LABEL[config.defaultProvider] + '.'
          : 'Was in den Einstellungen als Vorgabe steht.',
      },
      ...(['claude', 'codex'] as ProviderId[]).map((provider) => {
        const status = providers.find((entry) => entry.id === provider);
        return {
          value: provider as ProviderChoice,
          label: PROVIDER_LABEL[provider],
          icon: <ProviderIcon provider={provider} className="size-4 text-muted-foreground" />,
          ...(status && !status.available
            ? { description: 'Nicht installiert. Aufträge dieses Agenten scheitern.' }
            : {}),
        };
      }),
    ],
    [config, providers],
  );

  // Only `GET /api/providers` carries `models[]`; the health payload does not.
  const effectiveProvider: ProviderId =
    draft.provider === STANDARD_CHOICE ? (config?.defaultProvider ?? 'claude') : draft.provider;
  const models = providers.find((entry) => entry.id === effectiveProvider)?.models ?? [];

  const modelOptions = useMemo<EntityOption[]>(() => {
    const options: EntityOption[] = models.map((model) => ({ value: model, label: model }));
    // A model the provider no longer lists still has to be visible, or an
    // edit would silently drop it the moment anything else is saved.
    if (draft.model && !models.includes(draft.model)) {
      options.unshift({ value: draft.model, label: draft.model, hint: 'unbekannt' });
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
    toast(editing ? 'Agent gespeichert' : saved.name + ' eingestellt');
    void navigate('/org/agents/' + saved.id);
  });

  const setArchived = useCallback(
    async (archived: boolean): Promise<void> => {
      if (!id || !agent) return;
      if (archived) {
        const ok = await confirm({
          title: 'Agent archivieren?',
          description:
            agent.name +
            ' bekommt keine neuen Aufträge mehr und verschwindet aus den Auswahllisten. Bisherige Aufträge und Erinnerungen bleiben erhalten.',
          confirmLabel: 'Archivieren',
          destructive: true,
        });
        if (!ok) return;
      }
      try {
        await api.updateAgent(id, { archived });
        await org.refresh();
        toast(archived ? agent.name + ' archiviert' : agent.name + ' ist wieder im Dienst');
        if (archived) void navigate('/org/agents');
      } catch (caught) {
        reportFailure('Änderung', caught);
      }
    },
    [agent, confirm, id, navigate, org],
  );

  /* --------------------------------- Kopf --------------------------------- */

  const leaf = editing ? (agent?.name ?? 'Agent bearbeiten') : 'Agent einstellen';

  usePageMeta(
    {
      breadcrumb: [
        { label: 'Firma', to: '/org/agents' },
        { label: 'Agenten', to: '/org/agents' },
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
                        label: 'Zurückholen',
                        icon: ArchiveRestoreIcon,
                        onSelect: () => void setArchived(false),
                      }
                    : {
                        label: 'Archivieren',
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
        <EmptyState
          icon={UsersRoundIcon}
          title="Diesen Agenten gibt es nicht mehr"
          description="Er wurde entlassen oder hat nie existiert."
          actionLabel="Zu den Agenten"
          actionTo="/org/agents"
        />
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
    ? 'Kleinbuchstaben, Ziffern, Bindestriche.'
    : 'Leer lassen: der Server bildet es aus dem Namen, hier voraussichtlich „' +
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
          editing
            ? 'Rolle, Anweisungen und Gedächtnis bleiben bestehen; jeder Auftrag startet trotzdem einen frischen Prozess.'
            : 'Ein Agent ist fest angestellt: Rolle, Anweisungen und eigenes Gedächtnis bleiben bestehen.'
        }
      >
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
            <FieldLabel htmlFor="agent-title">Titel</FieldLabel>
            <Input
              id="agent-title"
              placeholder="z. B. Backend-Entwicklerin"
              value={draft.title}
              aria-invalid={Boolean(errors.title)}
              onChange={(event) => set({ title: event.target.value })}
            />
            <FieldError>{errors.title}</FieldError>
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-slug">Kürzel</FieldLabel>
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

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="agent-team">Team</FieldLabel>
            <EntityCombobox
              id="agent-team"
              options={teamOptions}
              value={draft.teamId}
              onChange={(teamId) => set({ teamId })}
              placeholder="Ohne Team"
              emptyLabel="Kein Team gefunden"
            />
            <FieldDescription>
              Ohne Team steht der Agent für sich. Die Zuordnung lässt sich auch vom Team aus ändern.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-manager">Vorgesetzter</FieldLabel>
            <EntityCombobox
              id="agent-manager"
              options={managerOptions}
              value={draft.managerId}
              onChange={(managerId) => set({ managerId })}
              placeholder="Der Assistent"
              emptyLabel="Kein Agent gefunden"
            />
            <FieldDescription>
              Ohne Vorgesetzten berichtet der Agent an den Assistenten.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-permission-standard">Zugriff</FieldLabel>
            <ChoiceField
              id="agent-permission"
              options={PERMISSION_CHOICES}
              value={draft.permission}
              onChange={(permission) => set({ permission })}
            />
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="agent-provider-standard">Anbieter</FieldLabel>
            <ChoiceField
              id="agent-provider"
              options={providerOptions}
              value={draft.provider}
              onChange={(provider) => set({ provider, model: null })}
            />
            <FieldDescription>
              Der Wechsel setzt das Modell zurück, damit kein Name bei seinem alten Anbieter
              zurückbleibt.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="agent-model">Modell</FieldLabel>
            <EntityCombobox
              id="agent-model"
              options={modelOptions}
              value={draft.model}
              onChange={(model) => set({ model })}
              placeholder="Standardmodell"
              emptyLabel="Kein Modell gefunden"
            />
            <FieldDescription>
              {modelOptions.length
                ? 'Modelle von ' +
                  PROVIDER_LABEL[effectiveProvider] +
                  (draft.provider === STANDARD_CHOICE ? ' (Vorgabe)' : '') +
                  '. Leer heißt: was der Anbieter selbst wählt.'
                : PROVIDER_LABEL[effectiveProvider] +
                  ' meldet derzeit keine Modelle. Leer heißt: was der Anbieter selbst wählt.'}
            </FieldDescription>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <Field>
            <FieldLabel htmlFor="agent-instructions">Anweisungen</FieldLabel>
            <Textarea
              id="agent-instructions"
              rows={12}
              placeholder="Die feste Rollenbeschreibung. Nie die Stimme des Assistenten."
              value={draft.instructions}
              aria-invalid={Boolean(errors.instructions)}
              onChange={(event) => set({ instructions: event.target.value })}
            />
            <FieldDescription>
              {formatNumber(draft.instructions.length)} Zeichen. Sie stehen bei jedem Auftrag
              wörtlich im Systemprompt.
            </FieldDescription>
            <FieldError>{errors.instructions}</FieldError>
          </Field>
        </FieldSet>
      </FormPage>
    </PageBody>
  );
}
