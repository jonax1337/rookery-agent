import { useCallback, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';


import { MEMORY_KIND_LABEL, RELATION_LABEL } from '@/lib/format';
import { formatNumber } from '@/lib/stats';
import type { MemoryKind, MemoryRecord } from '@/lib/types';
import { useMemoryState } from '@/providers/rookery-provider';
import {
  MemoryGraph3D,
  useGraphPalette,
  type GraphHandle,
} from '@/components/MemoryGraph3D';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { EmptyState } from '@/components/common/empty-state';
import { EntityCombobox, type EntityOption } from '@/components/forms/entity-combobox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import {
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  EyeOffIcon as MonitorXIcon,
  MaximizeIcon,
} from "@/components/icons";

/**
 * The shape of what is known.
 *
 * The scene itself is unchanged - `MemoryGraph3D` still builds the same force
 * layout out of the same nodes. What changed is everything around it: the
 * filter row is a `ButtonGroup` like every other toolbar in the app, the
 * legend is an `ItemGroup`, and the stage has a real aspect ratio instead
 * of a fixed 680 pixels that was too tall on a laptop and too short on a monitor.
 *
 * The palette lives in `.graph-stage` in `styles/index.css`, because WebGL
 * cannot read the oklch tokens the rest of the app is painted with. The stage
 * element below is what carries that class, and the legend reads the same
 * values back - so a swatch here and a body out there are the same colour by
 * construction rather than by two lists that drift apart.
 */
export function MemoryGraphPage() {
  const { graph } = useMemoryState();
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GraphHandle>(null);
  const palette = useGraphPalette(stageRef);

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
        only - the force layout and its canvas are never animated.
      */}
      <Fade delay={50}>
        <div
          ref={stageRef}
          className="graph-stage relative aspect-video min-h-80 w-full overflow-hidden rounded-lg border bg-card sm:min-h-[480px]"
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
              />
            </Fade>
          ) : (
            <>
              <MemoryGraph3D
                ref={sceneRef}
                graph={data}
                palette={palette}
                onSelectMemory={setPicked}
                onSelectEntity={graph.setEntity}
                onUnavailable={onUnavailable}
              />

              {graph.loading ? (
                <Fade className="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-2 rounded-md bg-background/80 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
                  <Spinner aria-hidden="true" />
                  loading
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
                  />
                </Fade>
              ) : null}

              {/*
                A clicked body names itself here and offers the one way on: the
                sheet that can pin, wake or forget a memory is on the list page,
                and a second copy of it here would drift apart from it. The
                `Fade` turns its appearance into an entrance; dismissing stays
                immediate, as it always was.
              */}
              {picked ? (
                <Fade className="absolute right-3 bottom-3 left-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-3 text-sm backdrop-blur">
                  <Badge variant="outline">{MEMORY_KIND_LABEL[picked.kind]}</Badge>
                  <span className="line-clamp-2 min-w-0 flex-1">{picked.content}</span>
                  <Button size="sm" asChild>
                    <Link to={'/memory?erinnerung=' + picked.id}>
                      <SquareArrowOutUpRightIcon data-icon="inline-start" />
                      Open
                    </Link>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
                    Close
                  </Button>
                </Fade>
              ) : null}
            </>
          )}
        </div>
      </Fade>

      <Fade delay={100}>
        <Legend palette={palette} />
      </Fade>
    </div>
  );
}

/** Without this the colours are decoration; with it they are information. */
function Legend({ palette }: { palette: ReturnType<typeof useGraphPalette> }) {
  const kinds = Object.keys(MEMORY_KIND_LABEL) as MemoryKind[];
  const relations = ['refines', 'contradicts', 'supersedes'] as const;

  return (
    <ItemGroup className="flex-row flex-wrap gap-x-4 gap-y-1">
      {kinds.map((kind) => (
        <Item key={kind} size="xs" className="w-auto px-0">
          <ItemMedia>
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: palette.kinds[kind] }}
              aria-hidden="true"
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="text-xs font-normal text-muted-foreground">
              {MEMORY_KIND_LABEL[kind]}
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
      {relations.map((relation) => (
        <Item key={relation} size="xs" className="w-auto px-0">
          <ItemMedia>
            <span
              className="inline-block h-px w-4"
              style={{ background: palette.relations[relation] }}
              aria-hidden="true"
            />
          </ItemMedia>
          <ItemContent>
            <ItemTitle className="text-xs font-normal text-muted-foreground">
              {RELATION_LABEL[relation]}
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
      <Item size="xs" className="ml-auto w-auto px-0">
        <ItemContent>
          <ItemTitle className="text-xs font-normal text-muted-foreground">
            Drag to rotate, scroll to zoom, click to select
          </ItemTitle>
        </ItemContent>
      </Item>
    </ItemGroup>
  );
}
