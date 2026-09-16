"use client";

import { useCallback, useRef } from "react";

/**
 * Animiert das Icon, sobald die Maus das umgebende interaktive Element
 * beruehrt (Button, Link, Menueeintrag, Option) - nicht nur das Icon selbst.
 * shadcn setzt auf SVGs in Triggern `pointer-events-none`, deshalb reicht
 * Self-Hover dort nicht; dieser Hook weitet ihn auf das gesamte Klick-Ziel
 * aus. Der Rueckgabewert ist ein Callback-Ref und sitzt direkt auf dem
 * SVG-Root des Icons (kein Wrapper-span: der wuerde shadcn-Direktkind-
 * Selektoren wie "[&>svg]:size-4" brechen). Icons ohne interaktiven
 * Vorfahren animieren weiterhin beim Hover ueber die SVG selbst - die
 * Handler in den Icon-Komponenten greift genau dafuer.
 */
export function useHostHover(
  isControlled: React.RefObject<boolean>,
  onEnter: () => void,
  onLeave: () => void
) {
  const cbRef = useRef({ onEnter, onLeave });
  cbRef.current = { onEnter, onLeave };
  const detachRef = useRef<(() => void) | null>(null);

  return useCallback(
    (node: Element | null) => {
      detachRef.current?.();
      detachRef.current = null;
      if (!node) return;
      const host = node.closest<HTMLElement>(
        "button, a, [role='button'], [role='menuitem'], [role='option'], [data-icon-hover-host]"
      );
      if (!host) return;
      const start = () => {
        if (!isControlled.current) cbRef.current.onEnter();
      };
      const stop = () => {
        if (!isControlled.current) cbRef.current.onLeave();
      };
      host.addEventListener("mouseenter", start);
      host.addEventListener("mouseleave", stop);
      detachRef.current = () => {
        host.removeEventListener("mouseenter", start);
        host.removeEventListener("mouseleave", stop);
      };
    },
    [isControlled]
  );
}
