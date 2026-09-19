import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';

import { MEMORY_KIND_LABEL, RELATION_LABEL } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { MemoryKind, MemoryRecord } from '@/lib/types';
import { useMemoryState } from '@/providers/rookery-provider';
import { MemoryCortex, useCortexPalette, type CortexHandle } from '@/components/memory-cortex';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  EyeOffIcon as MonitorXIcon,
  MaximizeIcon,
  MoonIcon,
} from "@/components/icons";

/**
 * The shape of what is known.
 *
 * The net used to be a force layout: every memory a body, every link a
 * spring, the whole thing a ball that settled differently every time. It is
 * a brain now. Topics are regions of the cortex, memories are neurons laid
 * on it near what they mention, links are fibres arcing over the surface
 * with signals running along them - and while a night runs, the whole
 * thing fires harder and in the night's colour. `memory-cortex` draws it;
 * this page is the frame: the filter row, the counts, the legend, and the
 * strip that names a clicked neuron.
 *
 * The palette lives in `.graph-stage` in `styles/index.css`, because WebGL
 * cannot read the oklch tokens the rest of the app is painted with. The
 * stage element below carries that class, and the legend reads the same
 * values back - so a swatch here and a body in there are the same colour by
 * construction. The stage is dark in both themes: light added to darkness is
 * the whole picture, and it means nothing on a pale ground.
 */
export function MemoryGraphPage() {
  const { graph, sleep } = useMemoryState();
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<CortexHandle>(null);
  const palette = useCortexPalette(stageRef);

  // The one thing a browser can refuse outright. Once it has, there is no
  // point in keeping an empty black box on the page.
  const [unavailable, setUnavailable] = useState(false);
  const onUnavailable = useCallback(() => setUnavailable(true), []);

  // The drawer that shows one memory lives on the list page, so a click in the
  // net names the body here and hands the id over there - `?erinnerung=<id>`
  // is what the list opens its drawer on. A second editable sheet in this
  // file would be the same thing twice, and the two would drift.
  const [picked, setPicked] = useState<MemoryRecord | null>(null);

  const entityOptions = useMemo<EntityOption[]>(
    () =>
      graph.entities.map((entity) => ({
        value: entity.id,
        label: entity.name,
        hint: formatNumber(entity.mentions) + '×',
      })),
    [graph.entities],
  );

  const data = graph.graph;
  const empty = !graph.loading && (!data || data.memories.length === 0);
  const dreaming = sleep.status?.running ?? false;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 lg:px-6">
      <Fade>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <EntityCombobox
              id="netz-thema"
              options={entityOptions}
              value={graph.entity || null}
              onChange={(value) => graph.setEntity(value ?? '')}
              placeholder="All topics"
              emptyLabel="No topic found"
              className="w-full sm:w-56"
            />
            <Field orientation="horizontal" className="w-auto">
              <Switch
                id="netz-schlafende"
                checked={graph.includeDormant}
                onCheckedChange={graph.setIncludeDormant}
              />
              <FieldLabel htmlFor="netz-schlafende" className="font-normal whitespace-nowrap">
                Show sleeping
              </FieldLabel>
            </Field>
            <Button
              variant="outline"
              onClick={() => sceneRef.current?.fit()}
              disabled={unavailable || empty}
            >
              {/* Animates on hover of its wrapper span - the button base `[&_svg]:pointer-events-none` mutes only the svg, not the span. */}
              <MaximizeIcon data-icon="inline-start" />
              Fit to view
            </Button>
          </div>

          {data ? (
            <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
              {/* These three roll in from zero and keep rolling whenever the
                  topic filter or the sleeping toggle refetches the net;
                  `thousandSeparator` keeps `formatNumber`'s en-GB comma. */}
              <span>
                <SlidingNumber number={data.memories.length} fromNumber={0} thousandSeparator="," /> Memories
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <SlidingNumber number={data.entities.length} fromNumber={0} thousandSeparator="," /> topics
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <SlidingNumber number={data.edges.length} fromNumber={0} thousandSeparator="," /> Connections
              </span>
              {data.truncated ? <Badge variant="outline">truncated</Badge> : null}
            </div>
          ) : null}
        </div>
      </Fade>

      {/*
        `.graph-stage` is what carries the scene's hex palette; the ref is
        handed to the palette hook and to nothing else, so the colours and the
        canvas cannot get out of step. The `Fade` around it moves the frame
        only - the scene itself is never animated by React.
      */}
      <Fade delay={50}>
        <div
          ref={stageRef}
          className="graph-stage relative aspect-video min-h-80 w-full overflow-hidden rounded-lg border bg-[var(--graph-background)] sm:min-h-[480px]"
        >
          {unavailable ? (
            <Fade className="absolute inset-0 flex items-center justify-center p-6">
              <EmptyState
                icon={MonitorXIcon}
                title="The network cannot be rendered here"
                description="This view requires WebGL. The same memories are available in full in the list."
                actionLabel="View memories"
                actionTo="/memory/memories"
                variant="plain"
                className="text-white"
              />
            </Fade>
          ) : (
            <>
              <MemoryCortex
                ref={sceneRef}
                graph={data}
                layoutGraph={graph.atlas}
                palette={palette}
                dreaming={dreaming}
                selectedId={picked?.id ?? null}
                onSelectMemory={setPicked}
                onSelectEntity={graph.setEntity}
                onUnavailable={onUnavailable}
              />

              {/* A soft vignette: the brain sits in a pool of light rather than on a flat black. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.55)_100%)]"
              />

              {graph.loading ? (
                <Fade className="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80 backdrop-blur">
                  <Spinner aria-hidden="true" />
                  loading
                </Fade>
              ) : null}

              {/* The night, named while it runs: the cortex is firing in its colour. */}
              {dreaming ? (
                <Fade className="pointer-events-none absolute top-3 right-3 z-10 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1 text-xs text-white/80 backdrop-blur">
                  <MoonIcon size={14} aria-hidden="true" style={{ color: palette.dream }} />
                  Dreaming
                </Fade>
              ) : null}

              {empty ? (
                <Fade className="absolute inset-0 flex items-center justify-center p-6">
                  <EmptyState
                    icon={MonitorXIcon}
                    title="Nothing in the network yet"
                    description="Once conversations leave something lasting behind, a network will take shape here. Dream sleep draws the connections."
                    actionLabel="View nights"
                    actionTo="/memory/sleep"
                    variant="plain"
                    className="text-white"
                  />
                </Fade>
              ) : null}

              {!empty ? <Legend palette={palette} /> : null}

              {/*
                A clicked body names itself here and offers the one way on: the
                sheet that can pin, wake or forget a memory is on the list page,
                and a second copy of it here would drift apart from it. The
                `Fade` turns its appearance into an entrance; dismissing stays
                immediate, as it always was.
              */}
              {picked ? (
                <Fade className="absolute right-3 bottom-3 left-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/75 p-3 text-sm text-white backdrop-blur">
                  <Badge variant="outline" className="border-white/20 text-white">
                    {MEMORY_KIND_LABEL[picked.kind]}
                  </Badge>
                  <span className="line-clamp-2 min-w-0 flex-1">{picked.content}</span>
                  <Button size="sm" asChild>
                    <Link to={'/memory?erinnerung=' + picked.id}>
                      <SquareArrowOutUpRightIcon data-icon="inline-start" />
                      Open
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-white hover:bg-white/10 hover:text-white"
                    onClick={() => setPicked(null)}
                  >
                    Close
                  </Button>
                </Fade>
              ) : null}
            </>
          )}
        </div>
      </Fade>
    </div>
  );
}

/**
 * Without this the colours are decoration; with it they are information.
 *
 * It sits on the stage rather than under it: the swatches are lights, and a
 * light is only itself against the same dark the neurons are on. It steps
 * aside while a picked memory's strip is open - both would want the bottom
 * edge - and it never takes the pointer.
 */
function Legend({ palette }: { palette: ReturnType<typeof useCortexPalette> }) {
  const kinds = Object.keys(MEMORY_KIND_LABEL) as MemoryKind[];
  const relations = ['refines', 'contradicts', 'supersedes'] as const;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 z-[5] flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/60">
      {kinds.map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-1.5 rounded-full"
            style={{ background: palette.kinds[kind], boxShadow: '0 0 6px ' + palette.kinds[kind] }}
            aria-hidden="true"
          />
          {MEMORY_KIND_LABEL[kind]}
        </span>
      ))}
      <span aria-hidden="true" className="hidden h-3 w-px bg-white/15 sm:inline-block" />
      {relations.map((relation) => (
        <span key={relation} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-px w-3"
            style={{ background: palette.relations[relation], boxShadow: '0 0 4px ' + palette.relations[relation] }}
            aria-hidden="true"
          />
          {RELATION_LABEL[relation]}
        </span>
      ))}
      <span className="ml-auto hidden text-white/40 md:inline">Drag to turn, scroll to zoom, click to select</span>
    </div>
  );
}
