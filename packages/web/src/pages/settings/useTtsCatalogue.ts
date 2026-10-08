import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { TtsCatalogue } from '@/lib/types';

export interface TtsCatalogueState {
  catalogue: TtsCatalogue | null;
  /** True when the last load failed; the catalogue is then null. */
  failed: boolean;
  reload(): Promise<void>;
}

/** The voices each speech engine offers, loaded once and reloadable on demand. */
export function useTtsCatalogue(): TtsCatalogueState {
  const [catalogue, setCatalogue] = useState<TtsCatalogue | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      setCatalogue(await api.ttsVoices());
      setFailed(false);
    } catch {
      // Not swallowed: `failed` makes the voice section show its
      // "catalogue unavailable" state with a retry.
      setCatalogue(null);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { catalogue, failed, reload };
}
