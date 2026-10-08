import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router';

import { NAVIGATE_CALLBACK } from './hierarchy-diagram';

export interface DiagramPalette {
  line: string;
  text: string;
  muted: string;
  nodeBg: string;
  rootBg: string;
  rootBorder: string;
  warn: string;
  critical: string;
}

export type DiagramStatus = 'loading' | 'ready' | 'unavailable';

function readPalette(stage: HTMLElement | null): DiagramPalette {
  const style = stage ? getComputedStyle(stage) : null;
  const read = (name: string, fallback: string): string => {
    const value = style?.getPropertyValue(name).trim();
    return value || fallback;
  };
  return {
    line: read('--chart-line', '#3a4049'),
    text: read('--chart-text', '#f2f0ea'),
    muted: read('--chart-muted', '#8aa0b4'),
    nodeBg: read('--chart-node-bg', '#1f2226'),
    rootBg: read('--chart-root-bg', '#1e2240'),
    rootBorder: read('--chart-root-border', '#818cf8'),
    warn: read('--chart-stage-warn', '#f59e0b'),
    critical: read('--chart-stage-critical', '#ef4444'),
  };
}

/**
 * Reads the theme's literal colours off `.org-hierarchy-stage` and re-reads
 * them whenever the root class changes (light/dark toggle) - see the page
 * comment and `useCortexPalette` in `components/memory-cortex` for why this
 * cannot just be the app's oklch tokens.
 */
export function useDiagramPalette(stage: RefObject<HTMLElement | null>): DiagramPalette {
  const [palette, setPalette] = useState<DiagramPalette>(() => readPalette(null));

  useEffect(() => {
    const update = (): void => setPalette(readPalette(stage.current));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [stage]);

  return palette;
}

/**
 * The one function `click ... call orgHierarchyNavigate(...)` in the diagram
 * resolves against - kept current via a ref so the diagram never has to
 * be re-rendered just because `navigate` itself got a new identity.
 */
export function useAgentNavigationCallback(): void {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const target = window as unknown as Record<string, unknown>;
    target[NAVIGATE_CALLBACK] = (agentId: string): void => {
      void navigateRef.current('/org/agents/' + agentId);
    };
    return () => {
      delete target[NAVIGATE_CALLBACK];
    };
  }, []);
}

interface MermaidDiagramOptions {
  /** The node the SVG is written into; it must be mounted whenever `enabled`. */
  container: RefObject<HTMLElement | null>;
  definition: string;
  palette: DiagramPalette;
  /** Nothing to draw yet: skip the library altogether. */
  enabled: boolean;
}

/**
 * Renders the flowchart into `container`.
 *
 * The library is a dynamic `import('mermaid')`, so a visitor who never opens
 * the page never downloads it.
 */
export function useMermaidDiagram({
  container,
  definition,
  palette,
  enabled,
}: MermaidDiagramOptions): DiagramStatus {
  const renderId = useId().replace(/:/g, '');
  const [status, setStatus] = useState<DiagramStatus>('loading');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          fontFamily: 'inherit',
          theme: 'base',
          themeVariables: {
            primaryColor: palette.nodeBg,
            primaryTextColor: palette.text,
            primaryBorderColor: palette.line,
            lineColor: palette.line,
            background: 'transparent',
          },
        });
        const result = await mermaid.render(
          'org-hierarchy-' + renderId,
          [
            definition,
            'classDef rootNode fill:' + palette.rootBg + ',stroke:' + palette.rootBorder + ',stroke-width:2px;',
            'classDef stageWarn stroke:' + palette.warn + ',stroke-width:2px;',
            'classDef stageCritical stroke:' + palette.critical + ',stroke-width:2px;',
          ].join('\n'),
        );
        if (cancelled || !container.current) return;
        // Set directly rather than through `dangerouslySetInnerHTML` and
        // `bindFunctions` on the next frame: that round-trip through React
        // state raced the DOM node's own mount (the container only exists
        // once `svg` is set, so the ref could still be null when the
        // deferred call ran) and silently never wired up a single `click`
        // directive - no error, the diagram just stopped being clickable.
        // The container div is unconditional for exactly this reason: the
        // ref is guaranteed to already be attached when this effect runs.
        container.current.innerHTML = result.svg;
        result.bindFunctions?.(container.current);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [container, definition, enabled, palette, renderId]);

  return status;
}
