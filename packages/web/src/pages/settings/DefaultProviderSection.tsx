import { useMemo } from 'react';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { ProviderIcon } from '@/components/provider-icon';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PROVIDER_LABEL } from '@/lib/format';
import type { ProviderId, ProviderStatus, PublicConfig } from '@/lib/types';
import { FADE_STEP_MS } from './fields';

export function DefaultProviderSection({
  draft,
  providers,
  set,
}: {
  draft: PublicConfig;
  providers: readonly ProviderStatus[];
  set(patch: Partial<PublicConfig>): void;
}) {
  const models = providers.find((entry) => entry.id === draft.defaultProvider)?.models ?? [];

  // A model pinned through the CLI or the environment is not necessarily in
  // the provider's list, and it must stay selectable all the same.
  const options = useMemo<EntityOption[]>(() => {
    const names =
      draft.defaultModel && !models.includes(draft.defaultModel)
        ? [draft.defaultModel, ...models]
        : models;
    return names.map((name) => ({ value: name, label: name }));
  }, [draft.defaultModel, models]);

  return (
    <>
      <Fade>
        <FieldSet>
          <FieldLegend variant="label">Provider</FieldLegend>
          <FieldDescription>
            Who responds when no other provider is selected in the composer.
          </FieldDescription>
          <RadioGroup
            value={draft.defaultProvider}
            onValueChange={(value) =>
              // A model name belongs to exactly one provider; it goes with the switch.
              set({ defaultProvider: value as ProviderId, defaultModel: '' })
            }
          >
            {providers.map((status) => (
              <ProviderChoice key={status.id} status={status} />
            ))}
          </RadioGroup>
        </FieldSet>
      </Fade>

      <Fade delay={FADE_STEP_MS}>
        <FieldSet>
          <Field>
            <FieldLabel htmlFor="set-model">Model</FieldLabel>
            <EntityCombobox
              id="set-model"
              options={options}
              value={draft.defaultModel || null}
              onChange={(value) => set({ defaultModel: value ?? '' })}
              placeholder="Provider default"
              emptyLabel="No model found"
            />
            <FieldDescription>
              Leave empty to use the provider default model.
            </FieldDescription>
          </Field>
        </FieldSet>
      </Fade>
    </>
  );
}

function ProviderChoice({ status }: { status: ProviderStatus }) {
  const label = PROVIDER_LABEL[status.id] ?? status.displayName;
  const inputId = 'set-provider-' + status.id;
  // A provider that cannot answer must not become the default: the
  // composer would show it while the runtime quietly fell back to
  // another one. Setting it up is a click away, in the section below.
  const ready = status.available && status.authenticated;

  return (
    <FieldLabel htmlFor={inputId}>
      <Field orientation="horizontal" data-disabled={!ready || undefined}>
        <ProviderIcon
          provider={status.id}
          label={status.displayName}
          className="size-5 text-muted-foreground"
        />
        <FieldContent>
          <FieldTitle>{label}</FieldTitle>
          {!ready ? <FieldDescription>{status.detail ?? 'Not ready yet.'}</FieldDescription> : null}
        </FieldContent>
        <RadioGroupItem value={status.id} id={inputId} aria-label={label} disabled={!ready} />
      </Field>
    </FieldLabel>
  );
}
