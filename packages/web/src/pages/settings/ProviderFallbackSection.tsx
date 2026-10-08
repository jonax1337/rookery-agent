import { ChevronDownIcon, ChevronUpIcon } from '@/components/icons';
import { SliderField } from '@/components/forms/form-kit';
import { ProviderIcon } from '@/components/provider-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { PROVIDER_LABEL } from '@/lib/format';
import type { ProviderId, ProviderStatus, PublicConfig } from '@/lib/types';
import { SwitchField } from './fields';

type ProviderFallback = NonNullable<PublicConfig['providerFallback']>;

const DEFAULT_THRESHOLD_PERCENT = 95;
const MIN_THRESHOLD_PERCENT = 50;
const MAX_THRESHOLD_PERCENT = 100;

const DEFAULT_FALLBACK: ProviderFallback = {
  enabled: true,
  thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
  order: [],
};

/**
 * What happens when a provider loses its quota: who is next, and at what
 * usage a provider counts as "nearly full". The order shows every known
 * provider - one that is added later is appended at the end instead of
 * staying invisible here.
 */
export function ProviderFallbackSection({
  draft,
  providers,
  set,
}: {
  draft: PublicConfig;
  providers: readonly ProviderStatus[];
  set(patch: Partial<PublicConfig>): void;
}) {
  const fallback = draft.providerFallback ?? DEFAULT_FALLBACK;
  // The saved order first, then whatever the registry knows and the file does
  // not: a new provider ends up last instead of missing.
  const ordered: ProviderId[] = [
    ...fallback.order.filter((id) => providers.some((status) => status.id === id)),
    ...providers.map((status) => status.id).filter((id) => !fallback.order.includes(id)),
  ];

  const setFallback = (patch: Partial<ProviderFallback>): void =>
    set({ providerFallback: { ...fallback, ...patch } });

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    const entry = ordered[index];
    const other = ordered[target];
    if (entry === undefined || other === undefined) return;
    const next = [...ordered];
    next[index] = other;
    next[target] = entry;
    setFallback({ order: next });
  };

  return (
    <FieldSet>
      <FieldLegend variant="label">Fallback</FieldLegend>
      <FieldDescription>
        When a provider runs out of quota, turns and assignments continue on another one instead of failing.
      </FieldDescription>

      <SwitchField
        id="set-fallback"
        label="Switch automatically"
        description="Route around a provider that hit its usage limit or is nearly spent."
        checked={fallback.enabled}
        onChange={(on) => setFallback({ enabled: on })}
      />

      <SliderField
        id="set-fallback-threshold"
        label="Threshold"
        value={fallback.thresholdPercent}
        min={MIN_THRESHOLD_PERCENT}
        max={MAX_THRESHOLD_PERCENT}
        step={1}
        fallback={DEFAULT_THRESHOLD_PERCENT}
        format={(value) => value + ' % used'}
        description="A provider whose window is this full is avoided while a roomier one is signed in."
        onChange={(value) => setFallback({ thresholdPercent: value })}
      />

      <Field>
        <FieldLabel>Fallback order</FieldLabel>
        <FieldDescription>Who a turn tries next when the preferred provider cannot serve it.</FieldDescription>
        <div className="flex flex-col gap-1">
          {ordered.map((id, index) => {
            const status = providers.find((entry) => entry.id === id);
            const label = PROVIDER_LABEL[id] ?? status?.displayName ?? id;
            return (
              <div key={id} className="flex items-center gap-2 rounded-lg border px-3 py-1.5">
                <ProviderIcon provider={id} label={label} className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
                {status?.usageBlocked ? <Badge variant="outline">Avoided</Badge> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={'Move ' + label + ' up'}
                >
                  <ChevronUpIcon className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={index === ordered.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={'Move ' + label + ' down'}
                >
                  <ChevronDownIcon className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
      </Field>
    </FieldSet>
  );
}
