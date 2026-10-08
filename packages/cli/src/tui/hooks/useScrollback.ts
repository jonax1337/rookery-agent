/**
 * The committed scrollback: the entries `<Static>` has printed, plus the ids
 * the app mints for entries it creates itself.
 */

import { useCallback, useRef, useState } from 'react';
import { glyph } from '../theme.js';
import type { Entry } from '../types.js';

/** Erase the screen and its scrollback, then home the cursor. */
const CLEAR_SCREEN = '\x1B[2J\x1B[3J\x1B[H';

export interface ScrollbackApi {
  entries: Entry[];
  /** Changes on every `clear`, so a keyed `<Static>` starts over. */
  generation: number;
  append: (added: Entry[]) => void;
  /** Add one dim warning line. */
  warn: (text: string) => void;
  /** Wipe the entries and the terminal, the way `clear` does. */
  clear: () => void;
  nextId: () => string;
}

export function useScrollback(initial: Entry[]): ScrollbackApi {
  const [entries, setEntries] = useState<Entry[]>(initial);
  const [generation, setGeneration] = useState(0);
  const ids = useRef(0);

  const nextId = useCallback(() => 'x' + (ids.current += 1), []);

  const append = useCallback((added: Entry[]) => {
    if (added.length) setEntries((current) => [...current, ...added]);
  }, []);

  const warn = useCallback(
    (text: string) => {
      append([{ kind: 'activity', id: nextId(), icon: glyph.warn, text }]);
    },
    [append, nextId],
  );

  const clear = useCallback(() => {
    setEntries([]);
    setGeneration((value) => value + 1);
    // The <Static> lines Ink already committed would otherwise linger above us.
    process.stdout.write(CLEAR_SCREEN);
  }, []);

  return { entries, generation, append, warn, clear, nextId };
}
