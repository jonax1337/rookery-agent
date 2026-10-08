import { useCallback, useEffect, useRef, useState } from 'react';
import { deepEqual } from '@/lib/deep-equal';
import { reportFailure } from '@/lib/errors';
import type { PublicConfig, TelegramGatewayConfig, TelegramPushConfig } from '@/lib/types';

function makeDraft(config: TelegramGatewayConfig): TelegramGatewayConfig {
  return { ...config, push: { ...config.push } };
}

export interface GatewayDraft {
  draft: TelegramGatewayConfig | null;
  saving: boolean;
  /** Whether the draft differs from the saved config. */
  dirty: boolean;
  set(patch: Partial<TelegramGatewayConfig>): void;
  setPush(patch: Partial<TelegramPushConfig>): void;
  addAllowedId(value: number): void;
  /** Also drops the id from the push recipients, which may only name allowed ids. */
  removeAllowedId(value: number): void;
  toggleRecipient(value: number, on: boolean): void;
  discard(): void;
  submit(): Promise<void>;
}

/**
 * The editable copy of the Telegram gateway config and the save/discard flow
 * around it.
 *
 * The page mirrors `SettingsPage`: this is the same kind of write - a `PATCH
 * /api/config` deep merge, not a record of its own with a `PUT`. There is no
 * `useDraft` here for exactly that reason: that hook's dirty flag is "was
 * anything touched", and this page needs "does the draft still match the
 * server".
 */
export function useGatewayDraft(
  config: PublicConfig | null,
  save: (patch: Partial<PublicConfig>) => Promise<boolean>,
  refresh: () => Promise<void>,
): GatewayDraft {
  const saved = config?.gateways.telegram ?? null;
  const [draft, setDraft] = useState<TelegramGatewayConfig | null>(saved ? makeDraft(saved) : null);
  const [saving, setSaving] = useState(false);

  // A socket-driven refetch must not overwrite a half-finished edit, so
  // `touched` is read synchronously and cannot be state.
  const touched = useRef(false);
  useEffect(() => {
    if (saved && !touched.current) setDraft(makeDraft(saved));
  }, [saved]);

  const update = useCallback((make: (current: TelegramGatewayConfig) => TelegramGatewayConfig) => {
    touched.current = true;
    setDraft((current) => (current ? make(current) : current));
  }, []);

  const set = useCallback(
    (patch: Partial<TelegramGatewayConfig>) => update((current) => ({ ...current, ...patch })),
    [update],
  );
  const setPush = useCallback(
    (patch: Partial<TelegramPushConfig>) =>
      update((current) => ({ ...current, push: { ...current.push, ...patch } })),
    [update],
  );

  const addAllowedId = useCallback(
    (value: number) =>
      // The first allowed id is what pairing mode was opened for, so it closes
      // itself here rather than waiting to be switched off and forgotten.
      update((current) => ({
        ...current,
        allowedUserIds: [...current.allowedUserIds, value],
        pairing: false,
      })),
    [update],
  );
  const removeAllowedId = useCallback(
    (value: number) =>
      update((current) => ({
        ...current,
        allowedUserIds: current.allowedUserIds.filter((entry) => entry !== value),
        push: {
          ...current.push,
          recipients: current.push.recipients.filter((entry) => entry !== value),
        },
      })),
    [update],
  );
  const toggleRecipient = useCallback(
    (value: number, on: boolean) =>
      update((current) => ({
        ...current,
        push: {
          ...current.push,
          recipients: on
            ? [...current.push.recipients, value]
            : current.push.recipients.filter((entry) => entry !== value),
        },
      })),
    [update],
  );

  const dirty = draft !== null && saved !== null && !deepEqual(draft, saved);

  const discard = useCallback(() => {
    touched.current = false;
    setDraft(saved ? makeDraft(saved) : null);
  }, [saved]);

  // Read through a ref so a save that is still out can tell whether the
  // person kept typing meanwhile - that edit must stay "touched", or the next
  // config refetch would overwrite it.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const submit = useCallback(async (): Promise<void> => {
    const pending = draftRef.current;
    if (!pending) return;
    setSaving(true);
    try {
      // The whole gateways object goes out, but PATCH merges deeply - the
      // config's other channels (once there are any) survive untouched.
      if (!(await save({ gateways: { telegram: pending } }))) return;
      if (draftRef.current === pending) touched.current = false;
      await refresh();
    } catch (caught) {
      reportFailure('Save', caught);
    } finally {
      setSaving(false);
    }
  }, [refresh, save]);

  return {
    draft,
    saving,
    dirty,
    set,
    setPush,
    addAllowedId,
    removeAllowedId,
    toggleRecipient,
    discard,
    submit,
  };
}
