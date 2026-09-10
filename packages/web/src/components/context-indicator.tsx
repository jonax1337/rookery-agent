import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { ProviderId, ProviderQuota } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PROVIDER_PLAN_LABEL, ProviderIcon } from '@/components/provider-icon';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';

export interface ContextUsage {
  /** Tokens the model had in front of it on the last request. */
  tokens: number;
  /** The window those tokens sit in, when the provider said. */
  window?: number;
}

/** Claude Code reports its window per turn; before the first one this is it. */
const DEFAULT_WINDOW: Record<ProviderId, number | undefined> = {
  claude: 200_000,
  codex: undefined,
};

const QUOTA_STALE_MS = 60_000;

const fmt = (value: number): string => value.toLocaleString('de-DE');

function tone(percent: number | null): string {
  if (percent === null) return 'text-muted-foreground';
  if (percent >= 90) return 'text-destructive';
  if (percent >= 70) return 'text-amber-600 dark:text-amber-400';
  return 'text-foreground';
}

function barTone(percent: number): string {
  if (percent >= 90) return 'bg-destructive';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-primary';
}

/** Same-day resets show the time, later ones the weekday too. */
function formatReset(resetsAt: string | undefined): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const farAway = date.getTime() - Date.now() > 20 * 60 * 60 * 1000;
  return (
    'Reset ' +
    date.toLocaleString('de-DE', {
      ...(farAway ? { weekday: 'short' } : {}),
      hour: '2-digit',
      minute: '2-digit',
    }) +
    ' Uhr'
  );
}

/** Track plus progress arc, coloured by fill. */
function UsageRing({ percent, className }: { percent: number; className?: string }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const filled = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  return (
    <svg viewBox="0 0 20 20" className={cn('size-4 shrink-0 -rotate-90', className)} aria-hidden="true">
      <circle cx="10" cy="10" r={radius} fill="none" strokeWidth="2.5" className="stroke-current opacity-20" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="stroke-current"
        strokeDasharray={filled + ' ' + (circumference - filled)}
      />
    </svg>
  );
}

/**
 * The provider's subscription windows: fetched when the provider changes and
 * again when the panel opens after a minute; a quota the running turn
 * reported itself wins while it is newer.
 */
function useQuota(provider: ProviderId, open: boolean, live: ProviderQuota | null): ProviderQuota | null {
  const [fetched, setFetched] = useState<ProviderQuota | null>(null);
  const lastLoad = useRef<{ provider: ProviderId; at: number } | null>(null);
  // Only a provider switch or unmount may discard an answer in flight; the
  // panel opening while the first load runs must not.
  const wanted = useRef(provider);
  wanted.current = provider;

  useEffect(() => {
    const previous = lastLoad.current;
    const stale = !previous || previous.provider !== provider || Date.now() - previous.at > QUOTA_STALE_MS;
    if (!stale) return;
    lastLoad.current = { provider, at: Date.now() };
    void api
      .providerUsage(provider)
      .then((quota) => {
        if (wanted.current === provider) setFetched(quota);
      })
      .catch(() => {
        if (wanted.current === provider) {
          setFetched({ provider, windows: [], fetchedAt: Date.now(), error: 'Kontingent derzeit nicht abrufbar.' });
        }
      });
  }, [provider, open]);

  return useMemo(() => {
    const candidates = [fetched, live].filter(
      (entry): entry is ProviderQuota => entry !== null && entry.provider === provider,
    );
    if (!candidates.length) return null;
    return candidates.reduce((best, entry) => (entry.fetchedAt > best.fetchedAt ? entry : best));
  }, [fetched, live, provider]);
}

interface ContextIndicatorProps {
  provider: ProviderId;
  context: ContextUsage | null;
  /** Quota the current turn's stream reported, if any. */
  live: ProviderQuota | null;
}

/**
 * Always-visible context gauge in the composer: ring plus percentage of the
 * model window, in the tokens the provider reported for the last request.
 * The panel adds the numbers and the subscription's limit windows.
 */
export function ContextIndicator({ provider, context, live }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);
  const quota = useQuota(provider, open, live);

  const window = context?.window ?? DEFAULT_WINDOW[provider];
  const percent = context && window ? Math.min(100, Math.round((context.tokens / window) * 100)) : null;
  const ringTone = tone(percent);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Kontext und Kontingent anzeigen"
          className="h-7 gap-1.5 rounded-full px-2 text-xs font-medium text-muted-foreground tabular-nums hover:text-foreground"
        >
          <UsageRing percent={percent ?? 0} className={ringTone} />
          <span>{percent !== null ? percent + ' %' : context ? fmt(context.tokens) : '–'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-80 p-0">
        <PopoverHeader className="gap-2 p-3.5">
          <div className="flex items-center justify-between gap-4">
            <PopoverTitle className="text-sm font-semibold">Kontext</PopoverTitle>
            {percent !== null && (
              <span className={cn('text-xl font-semibold tabular-nums', ringTone)}>
                {percent}
                <span className="ml-0.5 text-sm font-medium">%</span>
              </span>
            )}
          </div>
          {percent !== null && (
            <div
              role="meter"
              aria-label="Belegtes Kontextfenster"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div className={cn('h-full rounded-full', barTone(percent))} style={{ width: percent + '%' }} />
            </div>
          )}
          <PopoverDescription className="text-xs tabular-nums">
            {context ? (
              <>
                <span className="font-medium text-foreground">{fmt(context.tokens)}</span>
                {window ? ' / ' + fmt(window) + ' Tokens' : ' Tokens'}
                {' · letzte Antwort'}
              </>
            ) : window ? (
              fmt(window) + ' Tokens verfügbar. Gemessen wird nach der ersten Antwort.'
            ) : (
              'Gemessen wird nach der ersten Antwort.'
            )}
          </PopoverDescription>
        </PopoverHeader>

        <div className="border-t bg-muted/25 p-3.5">
          <p className="flex items-center gap-2 text-xs font-semibold">
            <ProviderIcon provider={provider} className="size-3.5" />
            {PROVIDER_PLAN_LABEL[provider]}
            {quota?.plan && <span className="font-normal text-muted-foreground">· {quota.plan}</span>}
          </p>
          {quota === null ? (
            <p className="mt-2 text-xs text-muted-foreground" role="status">
              Lädt …
            </p>
          ) : (
            <>
              {quota.windows.length > 0 && (
                <div className="mt-2.5 flex flex-col gap-3">
                  {quota.windows.map((entry) => (
                    <div key={entry.kind} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-muted-foreground">{entry.label}</span>
                        <span className={cn('font-medium tabular-nums', tone(entry.percent))}>
                          {entry.percent} % verbraucht
                        </span>
                      </div>
                      <div
                        role="meter"
                        aria-label={entry.label + ': Kontingent verbraucht'}
                        aria-valuenow={entry.percent}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        className="h-1 w-full overflow-hidden rounded-full bg-muted"
                      >
                        <div className={cn('h-full rounded-full', barTone(entry.percent))} style={{ width: entry.percent + '%' }} />
                      </div>
                      {formatReset(entry.resetsAt) && (
                        <p className="text-[11px] text-muted-foreground">{formatReset(entry.resetsAt)}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {quota.error && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{quota.error}</p>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
