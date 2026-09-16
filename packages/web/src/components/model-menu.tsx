import { LoaderCircleIcon, RefreshCwIcon } from "@/components/icons";
import { useEffect, useRef, useState } from 'react';

import { PROVIDER_BRAND, ProviderIcon } from '@/components/provider-icon';
import { ControlMenuButton } from '@/components/common/control-menu-button';
import { Button } from '@/components/ui/button';
import { ModelSelectorRoot, ModelSelectorTrigger, ModelSelectorValue, ModelSelectorContent,
  ModelSelectorSearch, ModelSelectorList, ModelSelectorEmpty, ModelSelectorGroup,
  ModelSelectorItem, ModelSelectorEffort } from '@/components/assistant-ui/elements/model-selector';
import { api } from '@/lib/api';
import { EFFORT_LABEL, EFFORT_LEVELS } from '@/lib/format';
import type { EffortLevel, ProviderId, ProviderStatus } from '@/lib/types';

interface ModelMenuProps {
  provider: ProviderId;
  model: string | undefined;
  providers: ProviderStatus[];
  effort: EffortLevel | undefined;
  onEffortSelect(effort: EffortLevel | undefined): void;
  disabled?: boolean;
  onSelect(provider: ProviderId, model: string | undefined): void;
}

export function ModelMenu({ provider, model, providers, effort, onEffortSelect, disabled, onSelect }: ModelMenuProps) {
  const [catalogue, setCatalogue] = useState(providers);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  useEffect(() => { setCatalogue(providers); }, [providers]);
  const current = catalogue.find((entry) => entry.id === provider);
  const defaultModel = current?.modelOptions?.find((entry) => entry.isDefault && entry.id !== 'default');
  const selected = model && model !== 'default'
    ? current?.modelOptions?.find((entry) => entry.id === model)
    : defaultModel;
  const label = selected?.name ?? (model && model !== 'default' ? model : 'Choose model');
  const options = catalogue.flatMap((status) => (status.modelOptions ?? []).filter((entry) => entry.id !== 'default').map((entry) => ({
    id: status.id + ':' + entry.id, sourceId: entry.id, provider: status.id, name: entry.name,
    icon: <ProviderIcon provider={status.id} label={status.displayName} />,
    keywords: [PROVIDER_BRAND[status.id] ?? status.displayName],
    disabled: !status.available || !status.authenticated,
    efforts: [{ id: 'auto', name: 'Auto' }, ...EFFORT_LEVELS.map((level) => ({ id: level, name: EFFORT_LABEL[level] }))],
  })));
  useEffect(() => {
    if ((!model || model === 'default') && defaultModel) onSelect(provider, defaultModel.id);
  }, [model, provider, defaultModel, onSelect]);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    setLoading(true);
    setError(undefined);
    try { setCatalogue(await api.providers()); }
    catch { setError('Could not load models. Try again.'); }
    finally { pending.current = false; setLoading(false); }
  };

  return (
    <ModelSelectorRoot models={options} value={selected ? provider + ':' + selected.id : undefined}
      onValueChange={(id) => {
        const choice = options.find((entry) => entry.id === id);
        if (choice) onSelect(choice.provider, choice.sourceId);
      }}
      effort={effort ?? 'auto'} onEffortChange={(value) => onEffortSelect(value === 'auto' ? undefined : value as EffortLevel)}
      onOpenChange={(open) => { if (open) void refresh(); }}>
      <ModelSelectorTrigger asChild disabled={disabled}
        aria-label={'Model and effort: ' + label + ', ' + (effort ? EFFORT_LABEL[effort] : 'Auto')}>
        <ControlMenuButton label="Model" value={<ModelSelectorValue placeholder={label} />}
          className="h-8 rounded-lg px-2" />
      </ModelSelectorTrigger>
      <ModelSelectorContent align="end" searchable className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="flex h-10 items-center justify-between px-3">
          <span className="text-xs font-medium">Model & effort</span>
          <Button variant="ghost" size="icon" className="size-7 rounded-lg" disabled={loading}
            aria-label={loading ? 'Loading models' : 'Refresh models'} aria-busy={loading} onClick={() => void refresh()}>
            {loading ? <LoaderCircleIcon className="size-3.5 motion-safe:animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
          </Button>
        </div>
        <ModelSelectorSearch />
        {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}
        <ModelSelectorList>
          <ModelSelectorEmpty>No matching models.</ModelSelectorEmpty>
          {catalogue.map((status) => (
            <ModelSelectorGroup key={status.id} heading={PROVIDER_BRAND[status.id] ?? status.displayName}>
              {options.filter((entry) => entry.provider === status.id).map((entry) => <ModelSelectorItem key={entry.id} model={entry} />)}
              {status.modelsError && <p className="px-3 py-2 text-xs text-muted-foreground">{status.modelsError}</p>}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
        <ModelSelectorEffort label="Reasoning effort" className="flex-col items-stretch gap-2 [&_[role=radiogroup]]:flex-wrap" />
      </ModelSelectorContent>
    </ModelSelectorRoot>
  );
}
