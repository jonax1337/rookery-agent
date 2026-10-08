import { useMemo } from 'react';

import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { ChoiceField, type ChoiceOption } from '@/components/forms/form-kit';
import { ProviderIcon } from '@/components/provider-icon';
import { Field, FieldDescription, FieldLabel, FieldSet } from '@/components/ui/field';
import { PROVIDER_LABEL, STANDARD_CHOICE } from '@/lib/format';
import type { ProviderId } from '@/lib/types';
import { useConfig } from '@/providers/rookery-provider';

import type { AgentFieldsProps, ProviderChoice } from './agentDraft';

/** Which provider "Default" means while the settings have not loaded yet. */
const FALLBACK_DEFAULT_PROVIDER: ProviderId = 'claude';

const NO_MODELS: string[] = [];

/** Provider and model, where the model list follows the provider. */
export function AgentModelFields({ draft, set }: AgentFieldsProps) {
  const { config, providers } = useConfig();

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
    draft.provider === STANDARD_CHOICE
      ? (config?.defaultProvider ?? FALLBACK_DEFAULT_PROVIDER)
      : draft.provider;
  const effectiveStatus = providers.find((entry) => entry.id === effectiveProvider);
  const models = effectiveStatus?.models ?? NO_MODELS;
  // A configured profile has no hardcoded label here, only the name its
  // catalogue entry gave it - without which the sentence below reads
  // "Models from undefined".
  const effectiveLabel =
    PROVIDER_LABEL[effectiveProvider] ?? effectiveStatus?.displayName ?? effectiveProvider;

  const modelOptions = useMemo<EntityOption[]>(() => {
    const options: EntityOption[] = models.map((model) => ({ value: model, label: model }));
    // A model the provider no longer lists still has to be visible, or an
    // edit would silently drop it the moment anything else is saved.
    if (draft.model && !models.includes(draft.model)) {
      options.unshift({ value: draft.model, label: draft.model, hint: 'unknown' });
    }
    return options;
  }, [draft.model, models]);

  const modelHint = modelOptions.length
    ? 'Models from ' +
      effectiveLabel +
      (draft.provider === STANDARD_CHOICE ? ' (Default)' : '') +
      '. Empty means the provider chooses.'
    : effectiveLabel + ' currently reports no models. Empty means the provider chooses.';

  return (
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
        <FieldDescription>{modelHint}</FieldDescription>
      </Field>
    </FieldSet>
  );
}
