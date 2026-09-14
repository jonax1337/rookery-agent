import { ProviderIcon } from '@/components/provider-icon';
import { PROVIDER_LABEL } from '@/lib/format';
import type { ProviderId } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Who ran it and on what, as one table cell.
 *
 * Provider and model always travel together - a model name without its
 * provider is ambiguous and a provider without its model hides what actually
 * answered - so they get one component instead of two columns. It is also
 * the first use of `provider-icon.tsx`, which has been sitting unused
 * everywhere except the model picker.
 */

export interface ProviderCellProps {
  /** Unset means the row inherits the default - agents usually do. */
  provider?: ProviderId;
  /** Unset means the provider's own default model. */
  model?: string;
  /** What to print when no provider is pinned. */
  fallback?: string;
  /**
   * `stacked` is the table cell (provider over model), `inline` the one-line
   * form for a header strip or a `MetaList` value.
   */
  layout?: 'stacked' | 'inline';
  /**
   * Off where the model already has a row of its own - a `MetaList` that
   * labels "Anbieter" and "Modell" separately would otherwise print the model
   * twice.
   */
  showModel?: boolean;
  className?: string;
}

export function ProviderCell({
  provider,
  model,
  fallback = 'Default',
  layout = 'stacked',
  showModel = true,
  className,
}: ProviderCellProps) {
  if (!provider) {
    return <span className={cn('text-sm text-muted-foreground', className)}>{fallback}</span>;
  }

  const modelLabel = model || 'Default model';

  if (layout === 'inline') {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-sm', className)}>
        <ProviderIcon provider={provider} className="size-3.5 text-muted-foreground" />
        <span className="truncate">{PROVIDER_LABEL[provider] ?? provider}</span>
        {showModel && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">
              ·
            </span>
            <span className="truncate text-muted-foreground">{modelLabel}</span>
          </>
        )}
      </span>
    );
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <ProviderIcon provider={provider} className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <div className="truncate text-sm leading-snug">{PROVIDER_LABEL[provider] ?? provider}</div>
        {showModel && (
          <div className="truncate text-xs leading-snug text-muted-foreground">{modelLabel}</div>
        )}
      </div>
    </div>
  );
}
