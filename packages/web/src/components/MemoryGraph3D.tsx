import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Ref, RefObject } from 'react';

import type {
  MemoryEntity,
  MemoryGraph as Graph,
  MemoryKind,
  MemoryRecord,
  MemoryRelation,
} from '@/lib/types';

/**
 * The brain, in space.
 *
 * Entities are the labelled hubs, memories the smaller bodies around them,
 * and a line is either "this memory is about that thing" or a relation the
 * night drew between two memories. A flat drawing of this kept collapsing
 * into a knot; in three dimensions the clusters pull themselves apart and
 * the shape of what the assistant knows is actually visible.
 *
 * The library and the WebGL renderer behind it load on demand, so only
 * whoever opens this page pays for them.
 *
 * What changed with the block rebuild: the component is now only the canvas.
 * Its filter bar, its legend and its frame moved out to `MemoryGraphPage`,
 * where they can be the same `ButtonGroup` and `ItemGroup` every other page
 * uses. The palette moved out too - see `useGraphPalette` below.
 */

/* -------------------------------- palette -------------------------------- */

export interface GraphPalette {
  background: string;
  entity: string;
  mention: string;
  kinds: Record<MemoryKind, string>;
  relations: Record<MemoryRelation, string>;
}

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

/**
 * What the palette falls back to before the stage is mounted, and if a token
 * is ever missing: the dark values, because the canvas is a lit object on a
 * dark ground by nature.
 */
const FALLBACK: GraphPalette = {
  background: '#0a0a0c',
  entity: '#d6dae1',
  mention: '#343a44',
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

function readPalette(element: HTMLElement | null): GraphPalette {
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
    kinds,
    relations,
  };
}

function samePalette(a: GraphPalette, b: GraphPalette): boolean {
  if (a.background !== b.background || a.entity !== b.entity || a.mention !== b.mention) return false;
  for (const kind of Object.keys(KIND_VARIABLE) as MemoryKind[]) {
    if (a.kinds[kind] !== b.kinds[kind]) return false;
  }
  for (const relation of Object.keys(RELATION_VARIABLE) as MemoryRelation[]) {
    if (a.relations[relation] !== b.relations[relation]) return false;
  }
  return true;
}

/**
 * The net's colours, read off the `.graph-stage` element the page renders.
 *
 * The hex values live in `styles/index.css` because WebGL cannot parse oklch,
 * which is what every design token in this app is. Reading them back here
 * rather than keeping a second copy in JavaScript means the theme is defined
 * in exactly one place - and the `MutationObserver` on the root class is what
 * makes a theme switch repaint the scene without rebuilding it.
 */
export function useGraphPalette(stage: RefObject<HTMLElement | null>): GraphPalette {
  const [palette, setPalette] = useState<GraphPalette>(FALLBACK);

  useLayoutEffect(() => {
    // The observer fires on every class change of the root element, most of
    // which have nothing to do with the theme. Keeping the old object when the
    // colours did not move is what stops those from re-feeding the whole scene.
    const update = (): void =>
      setPalette((current) => {
        const next = readPalette(stage.current);
        return samePalette(current, next) ? current : next;
      });
    update();

    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // A root without an explicit class follows the operating system, and that
    // can change while the page is open.
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', update);

    return () => {
      observer.disconnect();
      media?.removeEventListener('change', update);
    };
  }, [stage]);

  return palette;
}

/* --------------------------------- scene --------------------------------- */

interface Node {
  id: string;
  type: 'entity' | 'memory';
  label: string;
  size: number;
  colour: string;
  dormant: boolean;
  memory?: MemoryRecord;
  entity?: MemoryEntity;
}

interface Link {
  source: string;
  target: string;
  kind: 'mention' | 'relation';
  relation?: string;
  colour: string;
  width: number;
}

/** What the page's "Einpassen" button reaches into the scene for. */
export interface GraphHandle {
  fit(): void;
}

export interface MemoryGraph3DProps {
  graph: Graph | null;
  palette: GraphPalette;
  /** Clicking a memory body. */
  onSelectMemory(memory: MemoryRecord): void;
  /** Clicking a hub filters the net down to that topic. */
  onSelectEntity(entityId: string): void;
  /** WebGL is missing or the library failed to load - the page says so. */
  onUnavailable?(): void;
  ref?: Ref<GraphHandle>;
}

export function MemoryGraph3D({
  graph,
  palette,
  onSelectMemory,
  onSelectEntity,
  onUnavailable,
  ref,
}: MemoryGraph3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // The instance stays untyped on purpose: the library's own types drag the
  // whole three.js surface into this file for no benefit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  // Read through refs so a new handler identity never rebuilds the scene.
  const selectRef = useRef(onSelectMemory);
  const entityRef = useRef(onSelectEntity);
  const failedRef = useRef(onUnavailable);
  selectRef.current = onSelectMemory;
  entityRef.current = onSelectEntity;
  failedRef.current = onUnavailable;

  // The scene is built asynchronously. Without this the first data pass runs
  // before the instance exists and nothing ever reaches the canvas.
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({ fit: () => graphRef.current?.zoomToFit?.(600, 80) }), []);

  const data = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], links: [] as Link[] };

    const mentions = new Map<string, number>();
    for (const link of graph.links) {
      mentions.set(link.entityId, (mentions.get(link.entityId) ?? 0) + 1);
    }

    const nodes: Node[] = [
      ...graph.entities.map((item) => ({
        id: 'e:' + item.id,
        type: 'entity' as const,
        label: item.name,
        size: 12 + Math.min(60, (mentions.get(item.id) ?? 1) * 8),
        colour: palette.entity,
        dormant: false,
        entity: item,
      })),
      ...graph.memories.map((memory) => ({
        id: 'm:' + memory.id,
        type: 'memory' as const,
        label: memory.content,
        size: 1.5 + memory.importance * 5 + (memory.pinned ? 2 : 0),
        colour: palette.kinds[memory.kind] ?? palette.kinds.fact,
        dormant: Boolean(memory.dormantAt),
        memory,
      })),
    ];

    const known = new Set(nodes.map((node) => node.id));
    const links: Link[] = [
      ...graph.links
        .filter((link) => known.has('m:' + link.memoryId) && known.has('e:' + link.entityId))
        .map((link) => ({
          source: 'm:' + link.memoryId,
          target: 'e:' + link.entityId,
          kind: 'mention' as const,
          colour: palette.mention,
          width: 0.3,
        })),
      ...graph.edges
        .filter((edge) => known.has('m:' + edge.srcId) && known.has('m:' + edge.dstId))
        .map((edge) => ({
          source: 'm:' + edge.srcId,
          target: 'm:' + edge.dstId,
          kind: 'relation' as const,
          relation: edge.relation,
          colour: palette.relations[edge.relation] ?? palette.mention,
          // A contradiction should be impossible to miss.
          width: edge.relation === 'contradicts' ? 1.6 : 0.6 + edge.weight,
        })),
    ];

    return { nodes, links };
  }, [graph, palette]);

  // Build the scene once, then only feed it data.
  useEffect(() => {
    let cancelled = false;
    const mount = mountRef.current;
    if (!mount) return;

    void (async () => {
      try {
        const [{ default: ForceGraph3D }, { default: SpriteText }] = await Promise.all([
          import('3d-force-graph'),
          import('three-spritetext'),
        ]);
        if (cancelled || !mountRef.current) return;

        // Typed loosely on purpose: the library's generics expect its own
        // node shape, and threading ours through them buys nothing here.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance: any = new ForceGraph3D(mountRef.current);
        instance
          .showNavInfo(false)
          .nodeRelSize(6)
          .nodeVal((node: Node) => node.size)
          .nodeColor((node: Node) => node.colour)
          .nodeOpacity(0.92)
          .nodeResolution(12)
          .linkColor((link: Link) => link.colour)
          .linkWidth((link: Link) => link.width)
          .linkOpacity(0.45)
          .linkCurvature((link: Link) => (link.kind === 'relation' ? 0.18 : 0))
          // Only relations get an arrow: a memory is about an entity in no
          // particular direction, but it does supersede or refine another one.
          .linkDirectionalArrowLength((link: Link) => (link.kind === 'relation' ? 3 : 0))
          .linkDirectionalArrowRelPos(0.9)
          .nodeThreeObjectExtend(true)
          .nodeThreeObject((node: Node) => {
            if (node.type !== 'entity') return null;
            // three-spritetext declares its three.js base against its own copy
            // of three, so the inherited transform is invisible to us here.
            const text = new SpriteText(node.label) as unknown as {
              color: string;
              textHeight: number;
              position: { y: number };
            };
            text.color = node.colour;
            text.textHeight = 7;
            // Hang the name under the hub rather than inside it.
            text.position.y = -(Math.cbrt(node.size) * 6 + 7);
            return text;
          })
          .onNodeClick((node: Node) => {
            if (node.type === 'entity') entityRef.current(node.entity?.id ?? '');
            else if (node.memory) selectRef.current(node.memory);
          })
          // Fit once the layout has actually settled, rather than on a guess.
          .onEngineStop(() => instance.zoomToFit(500, 70));

        instance.d3Force('charge')?.strength(-90);
        graphRef.current = instance;
        setReady(true);

        const resize = (): void => {
          const box = mountRef.current?.getBoundingClientRect();
          if (box) instance.width(box.width).height(box.height);
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(mountRef.current);
        (instance as { __observer?: ResizeObserver }).__observer = observer;
      } catch {
        if (!cancelled) failedRef.current?.();
      }
    })();

    return () => {
      cancelled = true;
      const instance = graphRef.current as
        | { __observer?: ResizeObserver; _destructor?: () => void }
        | null;
      instance?.__observer?.disconnect();
      instance?._destructor?.();
      graphRef.current = null;
      setReady(false);
      mount.replaceChildren();
    };
  }, []);

  // Data and colours flow in separately, so a filter or a theme switch does
  // not throw the camera back to where it started.
  useEffect(() => {
    const instance = graphRef.current;
    if (!instance) return;
    instance.backgroundColor(palette.background);
    instance.graphData({ nodes: data.nodes, links: data.links });
  }, [data, palette, ready]);

  return <div ref={mountRef} className="absolute inset-0" aria-hidden="true" />;
}
