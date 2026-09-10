import { createContext, useContext, type ReactNode } from 'react';

/**
 * App-provided controls rendered inside the stock composer action row:
 * `left` sits next to the attachment button (things that go into the chat),
 * `right` sits next to dictation and send (per-chat settings).
 */
export interface ComposerSlots {
  left?: ReactNode;
  right?: ReactNode;
}

const ComposerSlotsContext = createContext<ComposerSlots>({});

export function ComposerSlotsProvider({ left, right, children }: ComposerSlots & { children: ReactNode }) {
  return <ComposerSlotsContext.Provider value={{ left, right }}>{children}</ComposerSlotsContext.Provider>;
}

export const useComposerSlots = (): ComposerSlots => useContext(ComposerSlotsContext);
