import { useEffect, useMemo, useRef, useState } from 'react';
import { BrainIcon, LoaderIcon, MaximizeIcon } from 'lucide-react';
import type { MemoryEntity, MemoryGraph as Graph, MemoryKind, MemoryRecord } from '../lib/types';
import { MEMORY_KIND_LABEL, RELATION_LABEL } from '../lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

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
 * whoever opens this tab pays for them.
 *
 * The scene keeps its own palette instead of reading the app's CSS tokens:
 * those are oklch, which the renderer cannot parse, and a canvas wants
 * colours picked for a dark room anyway.
 */

interface MemoryGraph3DProps {
  graph: Graph | null;
  entities: MemoryEntity[];
  entity: string;
  onEntity(value: string): void;
  includeDormant: boolean;
  onIncludeDormant(value: boolean): void;
  loading: boolean;
  onSelect(memory: MemoryRecord): void;
}

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

const PALETTE = {
  dark: {
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
    } as Record<MemoryKind, string>,
    relations: {
      refines: '#5b9dff',
      caused_by: '#3fd18b',
      contradicts: '#ff5252',
      supersedes: '#6b7280',
      co_occurs: '#3a4049',
    } as Record<string, string>,
  },
  light: {
    background: '#f7f7f8',
    entity: '#2b3038',
    mention: '#cbd2da',
    kinds: {
      fact: '#1f6feb',
      preference: '#7c4dff',
      project: '#c2710c',
      event: '#1a9e63',
      summary: '#5a6b7d',
      insight: '#111318',
    } as Record<MemoryKind, string>,
    relations: {
      refines: '#1f6feb',
      caused_by: '#1a9e63',
      contradicts: '#d92020',
      supersedes: '#8b929c',
      co_occurs: '#cbd2da',
    } as Record<string, string>,
  },
};

function prefersDark(): boolean {
  if (typeof document === 'undefined') return true;
  const root = document.documentElement;
  if (root.classList.contains('dark')) return true;
  if (root.classList.contains('light')) return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function MemoryGraph3D({
  graph,
  entities,
  entity,
  onEntity,
  includeDormant,
  onIncludeDormant,
  loading,
  onSelect,
}: MemoryGraph3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  // The instance stays untyped on purpose: the library's own types drag the
  // whole three.js surface into this file for no benefit.
  const graphRef = useRef<any>(null);
  const selectRef = useRef(onSelect);
  const entityRef = useRef(onEntity);
  const [failed, setFailed] = useState(false);
  // The scene is built asynchronously. Without this the first data pass runs
  // before the instance exists and nothing ever reaches the canvas.
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(prefersDark);

  selectRef.current = onSelect;
  entityRef.current = onEntity;

  // Follow the app's theme switch without rebuilding the scene.
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(prefersDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const theme = dark ? PALETTE.dark : PALETTE.light;

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
        colour: theme.entity,
        dormant: false,
        entity: item,
      })),
      ...graph.memories.map((memory) => ({
        id: 'm:' + memory.id,
        type: 'memory' as const,
        label: memory.content,
        size: 1.5 + memory.importance * 5 + (memory.pinned ? 2 : 0),
        colour: theme.kinds[memory.kind] ?? theme.kinds.fact,
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
          colour: theme.mention,
          width: 0.3,
        })),
      ...graph.edges
        .filter((edge) => known.has('m:' + edge.srcId) && known.has('m:' + edge.dstId))
        .map((edge) => ({
          source: 'm:' + edge.srcId,
          target: 'm:' + edge.dstId,
          kind: 'relation' as const,
          relation: edge.relation,
          colour: theme.relations[edge.relation] ?? theme.mention,
          // A contradiction should be impossible to miss.
          width: edge.relation === 'contradicts' ? 1.6 : 0.6 + edge.weight,
        })),
    ];

    return { nodes, links };
  }, [graph, theme]);

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
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      const instance = graphRef.current as { __observer?: ResizeObserver; _destructor?: () => void } | null;
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
    instance.backgroundColor(theme.background);
    instance.graphData({ nodes: data.nodes, links: data.links });
  }, [data, theme, ready]);

  const empty = !loading && (!graph || !graph.memories.length);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={entity || 'all'} onValueChange={(value) => onEntity(value === 'all' ? '' : value)}>
          <SelectTrigger className="h-8 w-56 text-xs">
            <SelectValue placeholder="Alle Themen" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Themen</SelectItem>
            {entities.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name} ({item.mentions})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Switch id="dormant" checked={includeDormant} onCheckedChange={onIncludeDormant} />
          <Label htmlFor="dormant" className="text-xs font-normal text-muted-foreground">
            Aufgeräumte zeigen
          </Label>
        </div>

        <Button
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs text-muted-foreground"
          onClick={() => graphRef.current?.zoomToFit?.(600, 80)}
        >
          <MaximizeIcon className="size-3.5" />
          Einpassen
        </Button>

        {graph ? (
          <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>{graph.memories.length} Erinnerungen</span>
            <span>·</span>
            <span>{graph.entities.length} Themen</span>
            <span>·</span>
            <span>{graph.edges.length} Verbindungen</span>
            {graph.truncated ? (
              <Badge variant="outline" className="h-4 px-1.5 text-[9.5px]">
                gekürzt
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
        <div ref={mountRef} className="absolute inset-0" />

        {loading ? (
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
            <LoaderIcon className="size-3.5 animate-spin" />
            lädt
          </div>
        ) : null}

        {failed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <BrainIcon className="size-8 opacity-40" />
            <p className="text-sm">Der 3D-Graph lässt sich hier nicht darstellen.</p>
            <p className="max-w-xs text-center text-xs">
              Das Fenster braucht WebGL. In der Liste und auf der Zeitachse steht dasselbe Gedächtnis.
            </p>
          </div>
        ) : empty ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <BrainIcon className="size-8 opacity-40" />
            <p className="text-sm">Noch nichts im Gedächtnis.</p>
            <p className="max-w-xs text-center text-xs">
              Sobald Gespräche etwas Dauerhaftes hinterlassen, entsteht hier das Netz.
            </p>
          </div>
        ) : null}
      </div>

      <Legend theme={theme} />
    </div>
  );
}

/** Without this the colours are decoration; with it they are information. */
function Legend({ theme }: { theme: (typeof PALETTE)['dark'] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[10.5px] text-muted-foreground">
      {(Object.keys(MEMORY_KIND_LABEL) as MemoryKind[]).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-full" style={{ background: theme.kinds[kind] }} />
          {MEMORY_KIND_LABEL[kind]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-px w-4" style={{ background: theme.relations.refines }} />
        {RELATION_LABEL.refines}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-px w-4" style={{ background: theme.relations.contradicts }} />
        {RELATION_LABEL.contradicts}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-px w-4" style={{ background: theme.relations.supersedes }} />
        {RELATION_LABEL.supersedes}
      </span>
      <span className="opacity-60">Ziehen dreht, Rad zoomt, Klick öffnet</span>
    </div>
  );
}
