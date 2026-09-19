import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';

import { MEMORY_KIND_LABEL } from '@/lib/format';
import type { MemoryGraph, MemoryKind, MemoryRecord, MemoryRelation } from '@/lib/types';

import type { CortexHit, CortexPalette } from './scene';

/**
 * The brain, as a component.
 *
 * Everything that draws lives in `scene.ts` and loads on demand along with
 * three.js, so only whoever opens this page pays for either. This file is
 * the hull: it owns the mount, feeds the scene its data and colours, turns a
 * hover into a floating name and a click into a callback, and tears the
 * whole thing down when the page goes.
 */

/* -------------------------------- palette -------------------------------- */

const KIND_VARIABLE: Record<MemoryKind, string> = {
  fact: '--graph-fact',
  preference: '--graph-preference',
  project: '--graph-project',
  event: '--graph-event',
  summary: '--graph-summary',
  insight: '--graph-insight',
};

const RELATION_VARIABLE: Record<MemoryRelation, string> = {
  refines: '--graph-refines',
  supersedes: '--graph-supersedes',
  contradicts: '--graph-contradicts',
  caused_by: '--graph-caused-by',
  co_occurs: '--graph-co-occurs',
};

/** What the palette falls back to before the stage is mounted. */
const FALLBACK: CortexPalette = {
  background: '#07080d',
  entity: '#eef1f6',
  mention: '#4a5568',
  tissue: '#22293a',
  dream: '#d8b4fe',
  kinds: {
    fact: '#5b9dff',
    preference: '#a98bff',
    project: '#f5a524',
    event: '#3fd18b',
    summary: '#8aa0b4',
    insight: '#ffffff',
  },
  relations: {
    refines: '#5b9dff',
    supersedes: '#6b7280',
    contradicts: '#ff5252',
    caused_by: '#3fd18b',
    co_occurs: '#3a4049',
  },
};

function readPalette(element: HTMLElement | null): CortexPalette {
  if (!element) return FALLBACK;
  const style = getComputedStyle(element);
  const read = (variable: string, fallback: string): string =>
    style.getPropertyValue(variable).trim() || fallback;

  const kinds = {} as Record<MemoryKind, string>;
  for (const kind of Object.keys(KIND_VARIABLE) as MemoryKind[]) {
    kinds[kind] = read(KIND_VARIABLE[kind], FALLBACK.kinds[kind]);
  }
  const relations = {} as Record<MemoryRelation, string>;
  for (const relation of Object.keys(RELATION_VARIABLE) as MemoryRelation[]) {
    relations[relation] = read(RELATION_VARIABLE[relation], FALLBACK.relations[relation]);
  }

  return {
    background: read('--graph-background', FALLBACK.background),
    entity: read('--graph-entity', FALLBACK.entity),
    mention: read('--graph-mention', FALLBACK.mention),
    tissue: read('--graph-tissue', FALLBACK.tissue),
    dream: read('--graph-dream', FALLBACK.dream),
    kinds,
    relations,
  };
}

function samePalette(a: CortexPalette, b: CortexPalette): boolean {
  if (
    a.background !== b.background ||
    a.entity !== b.entity ||
    a.mention !== b.mention ||
    a.tissue !== b.tissue ||
    a.dream !== b.dream
  ) {
    return false;
  }
  for (const kind of Object.keys(KIND_VARIABLE) as MemoryKind[]) {
    if (a.kinds[kind] !== b.kinds[kind]) return false;
  }
  for (const relation of Object.keys(RELATION_VARIABLE) as MemoryRelation[]) {
    if (a.relations[relation] !== b.relations[relation]) return false;
  }
  return true;
}

/**
 * The stage's colours, read off the `.graph-stage` element the page renders.
 *
 * The hex values live in `styles/index.css` because WebGL cannot parse
 * oklch, which is what every design token in this app is. The stage is dark
 * in both themes - a lit brain needs a night behind it - but the values are
 * still read back rather than copied, so there is exactly one place that
 * defines them and the legend and the canvas cannot drift apart.
 */
export function useCortexPalette(stage: RefObject<HTMLElement | null>): CortexPalette {
  const [palette, setPalette] = useState<CortexPalette>(FALLBACK);

  useLayoutEffect(() => {
    const update = (): void =>
      setPalette((current) => {
        const next = readPalette(stage.current);
        return samePalette(current, next) ? current : next;
      });
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', update);

    return () => {
      observer.disconnect();
      media?.removeEventListener('change', update);
    };
  }, [stage]);

  return palette;
}

/* --------------------------------- model --------------------------------- */

/**
 * The brain model's bytes, fetched once as soon as this module is loaded -
 * that is, as soon as the page is - and long before three.js and the scene
 * have arrived. `index.html` preloads the same file, so this usually reads
 * from the browser's memory and the scene never shows the formula first.
 */
let modelBytes: Promise<ArrayBuffer | null> | null = null;

function preloadModel(): Promise<ArrayBuffer | null> {
  modelBytes ??= fetch('/models/brain.glb')
    .then((response) => (response.ok ? response.arrayBuffer() : null))
    .catch(() => null);
  return modelBytes;
}

void preloadModel();

/* -------------------------------- component ------------------------------ */

/** What the page's "Fit to view" button reaches into the scene for. */
export interface CortexHandle {
  fit(): void;
}

export interface MemoryCortexProps {
  /** What is drawn: the net as filtered on the page. */
  graph: MemoryGraph | null;
  /**
   * What decides where things go: the whole net, unfiltered. With it a
   * filter only removes bodies; without it the survivors would spread out
   * and every fibre would jump.
   */
  layoutGraph?: MemoryGraph | null;
  palette: CortexPalette;
  /** A night is running: the cortex fires harder, in the night's colour. */
  dreaming: boolean;
  /** The memory whose ring stays on, if any. */
  selectedId: string | null;
  /** Clicking a neuron. */
  onSelectMemory(memory: MemoryRecord): void;
  /** Clicking a core filters the net down to that topic. */
  onSelectEntity(entityId: string): void;
  /** WebGL is missing or the library failed to load - the page says so. */
  onUnavailable?(): void;
  ref?: Ref<CortexHandle>;
}

export function MemoryCortex({
  graph,
  layoutGraph = null,
  palette,
  dreaming,
  selectedId,
  onSelectMemory,
  onSelectEntity,
  onUnavailable,
  ref,
}: MemoryCortexProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // The scene's class comes from the same on-demand chunk as three.js, so
  // the ref is typed by its shape rather than by an import that would pull
  // the whole library into the page bundle.
  const sceneRef = useRef<{
    setGraph(graph: MemoryGraph | null, atlas: MemoryGraph | null): void;
    setPalette(palette: CortexPalette): void;
    setDreaming(dreaming: boolean): void;
    setSelected(key: string | null): void;
    fit(): void;
    dispose(): void;
  } | null>(null);
  const [ready, setReady] = useState(false);
  const [hover, setHover] = useState<CortexHit | null>(null);

  // Read through refs so a new handler identity never rebuilds the scene.
  const graphRef = useRef(graph);
  const selectRef = useRef(onSelectMemory);
  const entityRef = useRef(onSelectEntity);
  const failedRef = useRef(onUnavailable);
  graphRef.current = graph;
  selectRef.current = onSelectMemory;
  entityRef.current = onSelectEntity;
  failedRef.current = onUnavailable;

  useImperativeHandle(ref, () => ({ fit: () => sceneRef.current?.fit() }), []);

  // Build once, then only feed it.
  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return;

    void (async () => {
      try {
        const { CortexScene } = await import('./scene');
        if (cancelled || !mountRef.current) return;
        const scene = new CortexScene(
          mountRef.current,
          palette,
          {
            onHover: (hit) => setHover(hit),
            onClick: (hit) => {
              if (hit.type === 'entity') {
                entityRef.current(hit.id);
                return;
              }
              const memory = graphRef.current?.memories.find((item) => item.id === hit.id);
              if (memory) selectRef.current(memory);
            },
          },
          { model: preloadModel() },
        );
        sceneRef.current = scene;
        setReady(true);
      } catch {
        if (!cancelled) failedRef.current?.();
      }
    })();

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      setReady(false);
      mount.replaceChildren();
    };
    // The palette in the closure is only the first one; later ones flow in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) sceneRef.current?.setPalette(palette);
  }, [palette, ready]);

  useEffect(() => {
    if (ready) sceneRef.current?.setGraph(graph, layoutGraph);
  }, [graph, layoutGraph, ready]);

  useEffect(() => {
    if (ready) sceneRef.current?.setDreaming(dreaming);
  }, [dreaming, ready]);

  useEffect(() => {
    if (ready) sceneRef.current?.setSelected(selectedId ? 'm:' + selectedId : null);
  }, [selectedId, ready]);

  return (
    <>
      <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />
      {/*
        The name of whatever is under the pointer, hung beside it. A topic
        shows its name; a memory its first line and its kind. It sits above
        the body when there is room and below it near the top edge, and it
        never takes the pointer, so the brain underneath keeps turning.
      */}
      {hover ? (
        <div
          className="pointer-events-none absolute z-10 max-w-xs rounded-md border border-white/10 bg-black/70 px-2.5 py-1.5 text-xs text-white shadow-lg backdrop-blur"
          style={{
            left: hover.x,
            top: hover.y,
            transform: hover.y < 72 ? 'translate(-50%, 18px)' : 'translate(-50%, calc(-100% - 18px))',
          }}
        >
          {hover.type === 'entity' ? (
            <span className="font-medium">{hover.label}</span>
          ) : (
            <>
              <span className="mr-1.5 text-white/60">{MEMORY_KIND_LABEL[hover.memoryKind ?? 'fact']}</span>
              <span className="line-clamp-2">{hover.label}</span>
            </>
          )}
          <span className="mt-0.5 block text-[10px] tracking-wide text-white/45 uppercase">{hover.region}</span>
        </div>
      ) : null}
    </>
  );
}
