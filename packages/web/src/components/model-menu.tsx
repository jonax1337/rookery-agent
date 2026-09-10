import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { PROVIDER_BRAND, PROVIDER_PLAN_LABEL, ProviderIcon } from '@/components/provider-icon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProviderId, ProviderStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const PROVIDERS: ProviderId[] = ['claude', 'codex'];

interface ModelMenuProps {
  provider: ProviderId;
  /** Undefined means the provider's own default model. */
  model: string | undefined;
  providers: ProviderStatus[];
  disabled?: boolean;
  onSelect(provider: ProviderId, model: string | undefined): void;
}

/**
 * Provider and model in one picker, grouped by the subscription that pays
 * for them: the first level stays two entries short, the models live one
 * level down. Choosing a model chooses its provider with it, so the two can
 * never disagree.
 */
export function ModelMenu({ provider, model, providers, disabled, onSelect }: ModelMenuProps) {
  const groups = PROVIDERS.map((id) => ({
    id,
    status: providers.find((entry) => entry.id === id),
  }));
  const label = model ?? 'Standard';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={'Modell wählen, aktuell ' + PROVIDER_BRAND[provider] + ' ' + label}
          className="h-7 gap-1.5 rounded-full px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ProviderIcon provider={provider} className="size-3.5" />
          <span className="max-w-36 truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-center gap-2.5 px-1.5 py-1.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <ProviderIcon provider={provider} className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{label}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {PROVIDER_PLAN_LABEL[provider]}
              {model ? '' : ' · Standardmodell'}
            </span>
          </span>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Modell wählen</DropdownMenuLabel>
          {groups.map((group) => {
            const unavailable = group.status ? !group.status.available : false;
            const models = group.status?.models ?? [];
            return (
              <DropdownMenuSub key={group.id}>
                <DropdownMenuSubTrigger disabled={unavailable} className="gap-2">
                  <ProviderIcon provider={group.id} className="size-3.5" />
                  <span className="truncate">{PROVIDER_PLAN_LABEL[group.id]}</span>
                  {group.status && !group.status.authenticated && (
                    <span className="ml-auto text-xs text-muted-foreground">nicht angemeldet</span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64">
                  <DropdownMenuItem
                    onSelect={() => onSelect(group.id, undefined)}
                    className="gap-2"
                  >
                    <ProviderIcon provider={group.id} className="size-3.5" />
                    <span className="truncate">Standard</span>
                    <span className="truncate text-xs text-muted-foreground">
                      was {PROVIDER_BRAND[group.id]} vorsieht
                    </span>
                    {group.id === provider && !model && <CheckIcon className="ml-auto size-4 shrink-0" />}
                  </DropdownMenuItem>
                  {models.map((name) => {
                    const active = group.id === provider && name === model;
                    return (
                      <DropdownMenuItem
                        key={name}
                        onSelect={() => onSelect(group.id, name)}
                        className={cn('gap-2', active && 'font-medium')}
                      >
                        <ProviderIcon provider={group.id} className="size-3.5" />
                        <span className="truncate">{name}</span>
                        {active && <CheckIcon className="ml-auto size-4 shrink-0" />}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
