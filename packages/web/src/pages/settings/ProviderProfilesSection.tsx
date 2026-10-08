import { useCallback, useEffect, useState } from 'react';
import { ProviderIcon } from '@/components/provider-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { failureMessage } from '@/lib/errors';
import type { ProviderCatalogItem, ProviderStatus } from '@/lib/types';

/**
 * The providers Rookery can set up, one row each.
 *
 * Everything technical - endpoint, transport, model names - comes from the
 * catalogue on the server, so the only thing asked for here is the part that
 * is actually the user's: a key, or where a checkout lives.
 */
export function ProviderProfilesSection({ providers }: { providers: readonly ProviderStatus[] }) {
  const [items, setItems] = useState<ProviderCatalogItem[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const list = await api.providerCatalog();
    setItems(list);
    setValues(Object.fromEntries(list.map((item) => [item.id, ''])));
  }, []);
  useEffect(() => {
    load().catch((cause: unknown) => setError(failureMessage(cause)));
  }, [load]);

  /** Runs one change to a provider profile, then reloads the catalogue. */
  const change = async (id: string, apply: () => Promise<unknown>): Promise<void> => {
    setBusy(id);
    setError(null);
    try {
      await apply();
      await load();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  const connect = (item: ProviderCatalogItem): Promise<void> => {
    const value = (values[item.id] ?? '').trim();
    return change(item.id, () => api.saveProviderProfile(item.id, { authToken: value || undefined }));
  };

  const disconnect = (id: string): Promise<void> => change(id, () => api.deleteProviderProfile(id));

  if (!items) return error ? <FieldError>{error}</FieldError> : null;

  return (
    <FieldSet>
      <FieldLegend variant="label">More providers</FieldLegend>
      <FieldDescription>
        Other models, answered through Claude Code itself. Claude and ChatGPT are already built in.
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}

      {items.map((item) => {
        const status = providers.find((entry) => entry.id === item.id);
        const ready = Boolean(status?.available && status.authenticated);
        const badge = !item.configured
          ? { label: 'Not set up', variant: 'outline' as const }
          : ready
            ? { label: 'Ready', variant: 'default' as const }
            : { label: 'Needs attention', variant: 'secondary' as const };
        return (
          <Field key={item.id} className="gap-2 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <ProviderIcon provider={item.id} label={item.name} className="size-5 text-muted-foreground" />
              <FieldTitle className="flex-1">{item.name}</FieldTitle>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <FieldDescription>{item.description}</FieldDescription>
            {item.configured && !ready && status?.detail ? (
              <FieldDescription className="text-destructive">{status.detail}</FieldDescription>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label={item.name + ' API key'}
                value={values[item.id] ?? ''}
                placeholder={item.authTokenSet ? 'Saved — leave empty to keep it' : 'API key'}
                onChange={(event) => setValues((current) => ({ ...current, [item.id]: event.target.value }))}
              />
              <Button type="button" size="sm" disabled={busy === item.id} onClick={() => void connect(item)}>
                {item.configured ? 'Save' : 'Set up'}
              </Button>
              {item.configured ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy === item.id}
                  onClick={() => void disconnect(item.id)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
            <FieldDescription>{item.hint}</FieldDescription>
          </Field>
        );
      })}
    </FieldSet>
  );
}
