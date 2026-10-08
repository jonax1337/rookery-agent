import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ImapListenerConfig,
  MemoryConfig,
  OrgConfig,
  PublicConfig,
  UpdatesConfig,
  VoiceConfig,
} from '@/lib/types';

/** What a server from before the updates setting sends nothing for. */
export const DEFAULT_UPDATES: UpdatesConfig = { mode: 'notify', channel: 'latest' };

/**
 * Structural equality for the config tree.
 *
 * `JSON.stringify` would do it only as long as every copy keeps its key
 * order, and a spread of a sub-object does not guarantee that. This does not
 * have to be fast: it runs once per keystroke over an object with about
 * thirty leaves.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

export interface SettingsDraft {
  draft: PublicConfig | null;
  saving: boolean;
  /** Whether the draft differs from the saved config. */
  dirty: boolean;
  set(patch: Partial<PublicConfig>): void;
  setVoice(patch: Partial<VoiceConfig>): void;
  setMemory(patch: Partial<MemoryConfig>): void;
  setOrg(patch: Partial<OrgConfig>): void;
  setUpdates(patch: Partial<UpdatesConfig>): void;
  setListeners(imap: ImapListenerConfig[]): void;
  discard(): void;
  submit(event?: FormEvent<HTMLFormElement>): Promise<void>;
}

/**
 * The editable copy of the server config that every section writes into, and
 * the save/discard flow around it.
 */
export function useSettingsDraft(
  config: PublicConfig | null,
  save: (patch: Partial<PublicConfig>) => Promise<boolean>,
): SettingsDraft {
  const [draft, setDraft] = useState<PublicConfig | null>(config);
  const [saving, setSaving] = useState(false);

  // Read synchronously by the effect below, so it cannot be state: the config
  // refetches on every socket reconnect, and a refetch must not wipe an edit
  // that is still in the middle of being typed.
  const touched = useRef(false);
  useEffect(() => {
    if (config && !touched.current) setDraft(config);
  }, [config]);

  const update = useCallback((make: (current: PublicConfig) => PublicConfig) => {
    touched.current = true;
    setDraft((currentDraft) => (currentDraft ? make(currentDraft) : currentDraft));
  }, []);

  const set = useCallback(
    (patch: Partial<PublicConfig>) => update((currentDraft) => ({ ...currentDraft, ...patch })),
    [update],
  );
  const setVoice = useCallback(
    (patch: Partial<VoiceConfig>) =>
      update((currentDraft) => ({ ...currentDraft, voice: { ...currentDraft.voice, ...patch } })),
    [update],
  );
  const setMemory = useCallback(
    (patch: Partial<MemoryConfig>) =>
      update((currentDraft) => ({ ...currentDraft, memory: { ...currentDraft.memory, ...patch } })),
    [update],
  );
  const setOrg = useCallback(
    (patch: Partial<OrgConfig>) =>
      update((currentDraft) => ({ ...currentDraft, org: { ...currentDraft.org, ...patch } })),
    [update],
  );
  const setUpdates = useCallback(
    (patch: Partial<UpdatesConfig>) =>
      update((currentDraft) => ({
        ...currentDraft,
        updates: { ...DEFAULT_UPDATES, ...currentDraft.updates, ...patch },
      })),
    [update],
  );
  // The whole list, every time: `listeners.imap` is an array, and a deep merge
  // cannot express "this one is gone".
  const setListeners = useCallback(
    (imap: ImapListenerConfig[]) =>
      update((currentDraft) => ({ ...currentDraft, listeners: { imap } })),
    [update],
  );

  // The deep comparison, not the "was touched" flag: typing a character and
  // deleting it again leaves nothing to save, and the footer should say so.
  const dirty = draft !== null && config !== null && !deepEqual(draft, config);

  const discard = useCallback(() => {
    touched.current = false;
    setDraft(config);
  }, [config]);

  // Read through a ref so a save that is still out can tell whether the
  // person kept typing meanwhile - that edit must stay "touched", or the next
  // config refetch would overwrite it.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const submit = useCallback(
    async (event?: FormEvent<HTMLFormElement>): Promise<void> => {
      event?.preventDefault();
      const pending = draftRef.current;
      if (!pending) return;
      setSaving(true);
      try {
        // The whole draft goes out: `PATCH /api/config` merges deeply, so the
        // sub-objects this dialog never shows survive untouched.
        const saved = await save(pending);
        if (saved && draftRef.current === pending) touched.current = false;
      } finally {
        setSaving(false);
      }
    },
    [save],
  );

  return { draft, saving, dirty, set, setVoice, setMemory, setOrg, setUpdates, setListeners, discard, submit };
}
