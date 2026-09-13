import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  BrainIcon,
  MoonIcon,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  SplineIcon,
  SquareArrowOutUpRightIcon,
  SunIcon,
  TagIcon,
  Trash2Icon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import {
  MEMORY_KIND_LABEL,
  MEMORY_KINDS,
  ORIGIN_LABEL,
  RELATION_LABEL,
  shorten,
} from '@/lib/format';
import { formatDateTime, formatNumber, formatPercent } from '@/lib/stats';
import type {
  MemoryKind,
  MemoryNeighbourhood,
  MemoryRecord,
  MemoryRelation,
  ScoredMemory,
} from '@/lib/types';
import { useMemoryState } from '@/providers/rookery-provider';
import { DataTable, type DataTableTab } from '@/components/blocks/data-table/data-table';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import {
  buildMemoryColumns,
  MEMORY_COLUMN_LABELS,
  MEMORY_SORTING,
} from '@/components/common/memory-columns';
import { MetaList } from '@/components/common/meta-list';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { useMemoryOutlet } from '@/pages/MemoryLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldLabel } from '@/components/ui/field';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * Everything the assistant knows, as one table.
 *
 * The list used to be a 300-pixel sidebar panel: a scrolling `<ul>`, a
 * hover-only delete cross that a touch screen could never reach, and a
 * `ToggleGroup` of kinds that wrapped onto three lines. It is the block's
 * table now - facets with counts, one search, a row menu that spells out
 * every action, and a drawer that shows what a memory hangs on.
 *
 * Two honesty notes carry the page. The search is the assistant's own blended
 * recall (`GET /api/memories?q=`), so its answer is ranked rather than
 * filtered: the "Treffer" column shows the score and the reason, and the table
 * is told not to filter that answer a second time. And the list is capped at
 * the server's 500, which the footer says - out loud once it actually hangs
 * there.
 */

type Row = MemoryRecord | ScoredMemory;

/** Everything `PATCH /api/memories/:id` accepts from this page. */
interface MemoryPatch {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  pinned?: boolean;
  dormant?: boolean;
  forgotten?: boolean;
}

type PatchFn = (id: string, changes: MemoryPatch, message: string) => Promise<void>;

function isScored(item: Row): item is ScoredMemory {
  return 'score' in item;
}

/** What a memory currently is, as the badges the status column draws. */
function StateBadges({ memory }: { memory: MemoryRecord }) {
  const plain = !memory.pinned && !memory.dormantAt && !memory.forgotten;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {memory.pinned ? <Badge variant="secondary">pinned</Badge> : null}
      {memory.dormantAt ? <Badge variant="outline">sleeping</Badge> : null}
      {memory.forgotten ? <Badge variant="destructive">forgotten</Badge> : null}
      {plain ? <span className="text-sm text-muted-foreground">awake</span> : null}
    </div>
  );
}

export function MemoryListPage() {
  const { memories, graph, highlighted } = useMemoryState();
  const { openRemember } = useMemoryOutlet();
  const { confirm, dialog } = useConfirm();

  const [tab, setTab] = useState<string>('alle');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Das Netz schickt eine Memory als `/memory?erinnerung=<id>` herüber.
  // Der Parameter wird sofort wieder entfernt, sonst zöge ein späteres
  // Schliessen der Schublade sie beim nächsten Rendern erneut auf - und der
  // Zurück-Knopf des Browsers landete auf derselben offenen Schublade.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('erinnerung');

  useEffect(() => {
    if (!requested) return;
    setSelectedId(requested);
    setSearchParams({}, { replace: true });
  }, [requested, setSearchParams]);

  const query = memories.query.trim();
  const searching = query.length > 0;

  /* -------------------------------- Actions ------------------------------ */

  const patch = useCallback<PatchFn>(
    async (id, changes, message) => {
      try {
        await memories.patch(id, changes);
        // A pin or a nap changes what the net may draw, so it reloads too.
        void graph.refresh();
        toast(message);
      } catch (caught) {
        reportFailure('Update', caught);
      }
    },
    [graph, memories],
  );

  const forget = useCallback(
    async (memory: MemoryRecord): Promise<void> => {
      const ok = await confirm({
        title: 'Forget memory?',
        description:
          'It will be excluded from recall. It is not deleted and remains in this table when “Show forgotten” is enabled.',
        confirmLabel: 'Forget',
        destructive: true,
      });
      if (!ok) return;
      await memories.forget(memory.id);
      void graph.refresh();
      setSelectedId((current) => (current === memory.id ? null : current));
      toast('Forget', { description: memory.content });
    },
    [confirm, graph, memories],
  );

  /* -------------------------------- Spalten ------------------------------- */

  // The whole table comes out of `buildMemoryColumns`; only the score column is
  // conditional, because a ranking only exists while a search is running - an
  // always-empty "Treffer" column would read as a ranking that failed rather
  // than as a list that was never ranked.
  const columns = useMemo(
    () =>
      buildMemoryColumns({
        selectable: true,
        onOpen: (memory) => setSelectedId(memory.id),
        highlighted,
        state: (memory) => <StateBadges memory={memory} />,
        ...(searching
          ? {
              score: (memory: MemoryRecord) =>
                isScored(memory) ? { value: memory.score, reason: memory.reason } : null,
            }
          : {}),
        rowActions: (memory) => (
          <MemoryRowActions
            memory={memory}
            onOpen={() => setSelectedId(memory.id)}
            onPatch={patch}
            onForget={() => void forget(memory)}
          />
        ),
      }),
    [forget, highlighted, patch, searching],
  );

  /* -------------------------------- Facetten ------------------------------ */

  const rows = useMemo(
    () => (tab === 'alle' ? memories.items : memories.items.filter((item) => item.kind === tab)),
    [memories.items, tab],
  );

  const tabs = useMemo<DataTableTab[]>(() => {
    const counts = new Map<string, number>();
    for (const item of memories.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    return [
      { value: 'alle', label: 'All', count: memories.items.length },
      ...MEMORY_KINDS.map((kind) => ({
        value: kind,
        label: MEMORY_KIND_LABEL[kind],
        count: counts.get(kind) ?? 0,
      })),
    ];
  }, [memories.items]);

  const reset = useCallback(() => {
    setTab('alle');
    memories.setQuery('');
  }, [memories]);

  /**
   * Three different kinds of nothing, and they mean different things: a search
   * that missed, a facet nobody has filled yet, and a bank that is genuinely
   * empty. Only the last one is an invitation to write the first memory.
   */
  const nothing = searching ? (
    <NoResults query={query} onReset={reset} />
  ) : memories.items.length > 0 ? (
    <NoResults onReset={reset} />
  ) : (
    <EmptyState
      icon={BrainIcon}
      title="No memories yet"
      description="Rookery learns automatically after every conversation. You can save anything that should be remembered immediately here."
      actionLabel="Save memory"
      onAction={openRemember}
      variant="plain"
      size="sm"
    />
  );

  return (
    <>
      {dialog}

      <DataTable
        data={rows}
        columns={columns}
        getRowId={(memory) => memory.id}
        idPrefix="erinnerungen"
        tabs={tabs}
        tab={tab}
        onTabChange={setTab}
        tabLabel="Memory type"
        searchable
        search={memories.query}
        onSearchChange={memories.setQuery}
        searchPlaceholder="Search memories"
        searchServerSide
        columnLabels={MEMORY_COLUMN_LABELS}
        initialSorting={MEMORY_SORTING}
        capped={memories.capped}
        rowLabel={{ singular: 'Memory', plural: 'Memories' }}
        loading={memories.loading && memories.items.length === 0}
        error={memories.error ? <ServerOffline onRetry={() => void memories.refresh()} /> : undefined}
        onRowClick={(memory) => setSelectedId(memory.id)}
        rowClassName={(memory) => (memory.forgotten || memory.dormantAt ? 'opacity-70' : undefined)}
        filters={
          <div className="flex items-center gap-2">
            <Switch
              id="vergessene"
              checked={memories.includeForgotten}
              onCheckedChange={memories.setIncludeForgotten}
            />
            <Label htmlFor="vergessene" className="text-sm font-normal text-muted-foreground">
              Show forgotten
            </Label>
          </div>
        }
        bulkActions={(selected, clear) => (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                for (const memory of selected) {
                  if (!memory.pinned) void patch(memory.id, { pinned: true }, 'Pinned');
                }
                clear();
              }}
            >
              Pin
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                for (const memory of selected) {
                  if (!memory.dormantAt) void patch(memory.id, { dormant: true }, 'Sleeping');
                }
                clear();
              }}
            >
              Put to sleep
            </Button>
          </>
        )}
        empty={nothing}
        filteredEmpty={nothing}
      />

      <MemoryDrawer
        id={selectedId}
        fallback={memories.items.find((item) => item.id === selectedId) ?? null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onJump={setSelectedId}
        onPatch={patch}
        onForget={forget}
      />
    </>
  );
}

/* ------------------------------- Zeilenmenü ------------------------------- */

/**
 * Every action on one memory, spelled out.
 *
 * The old list offered exactly one - a cross that appeared on hover, which on
 * a touch screen meant no action at all. Here the trigger is always there and
 * the destructive entry sits behind a separator and a confirmation.
 */
function MemoryRowActions({
  memory,
  onOpen,
  onPatch,
  onForget,
}: {
  memory: MemoryRecord;
  onOpen(): void;
  onPatch: PatchFn;
  onForget(): void;
}) {
  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <RowMenuButton label={'Actions for ' + shorten(memory.content, 60)} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onOpen}>
            <SquareArrowOutUpRightIcon data-icon="inline-start" />
            Open
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void onPatch(
                memory.id,
                { pinned: !memory.pinned },
                memory.pinned ? 'Unpinned' : 'Pinned',
              )
            }
          >
            {memory.pinned ? (
              <PinOffIcon data-icon="inline-start" />
            ) : (
              <PinIcon data-icon="inline-start" />
            )}
            {memory.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              void onPatch(
                memory.id,
                { dormant: !memory.dormantAt },
                memory.dormantAt ? 'Awake' : 'Sleeping',
              )
            }
          >
            {memory.dormantAt ? (
              <SunIcon data-icon="inline-start" />
            ) : (
              <MoonIcon data-icon="inline-start" />
            )}
            {memory.dormantAt ? 'Wake' : 'Put to sleep'}
          </DropdownMenuItem>
          {memory.forgotten ? (
            <DropdownMenuItem
              onSelect={() => void onPatch(memory.id, { forgotten: false }, 'Restored')}
            >
              <RotateCcwIcon data-icon="inline-start" />
              Restore
            </DropdownMenuItem>
          ) : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onForget}>
                <Trash2Icon data-icon="inline-start" />
                Forget
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/* --------------------------------- Drawer --------------------------------- */

interface MemoryDrawerProps {
  id: string | null;
  /** The row that opened it, so the drawer has something to show at once. */
  fallback: MemoryRecord | null;
  onOpenChange(open: boolean): void;
  /** Clicking a neighbour opens that memory instead of this one. */
  onJump(id: string): void;
  onPatch: PatchFn;
  onForget(memory: MemoryRecord): Promise<void>;
}

/** One edge of the neighbourhood, flattened with the direction it was read in. */
interface DrawerEdge {
  id: string;
  relation: MemoryRelation;
  /** True when this memory is the one doing the refining, contradicting, … */
  outgoing: boolean;
  other: MemoryRecord;
}

/**
 * One memory, with everything hanging off it.
 *
 * This replaces the old `MemoryDetail` sheet and adds the part that was
 * missing: the three fields that make a memory what it is are editable here.
 * A wrong fact used to be a choice between living with it and forgetting it.
 */
function MemoryDrawer({ id, fallback, onOpenChange, onJump, onPatch, onForget }: MemoryDrawerProps) {
  const [detail, setDetail] = useState<MemoryNeighbourhood | null>(null);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [importance, setImportance] = useState(0.5);
  const [saving, setSaving] = useState(false);

  const loaded = detail && detail.memory.id === id ? detail : null;
  const current = loaded?.memory ?? fallback;

  // The edges are a second request, so the drawer opens on the row it already
  // has and fills the neighbourhood in a moment later.
  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .memoryEdges(id)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // The draft follows the chosen memory and nothing else: a refetch underneath
  // must not wipe a half-typed correction.
  useEffect(() => {
    if (!current || current.id !== id) return;
    setContent(current.content);
    setKind(current.kind);
    setImportance(current.importance);
    // Only the identity may refill the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const dirty =
    current !== null &&
    (content.trim() !== current.content ||
      kind !== current.kind ||
      Math.abs(importance - current.importance) > 0.001);

  const save = useCallback(async (): Promise<void> => {
    if (!current) return;
    setSaving(true);
    try {
      await onPatch(current.id, { content: content.trim(), kind, importance }, 'Saved');
    } finally {
      setSaving(false);
    }
  }, [content, current, importance, kind, onPatch]);

  const edges: DrawerEdge[] = loaded
    ? [
        ...loaded.outgoing.map((edge) => ({
          id: edge.id,
          relation: edge.relation,
          outgoing: true,
          other: edge.other,
        })),
        ...loaded.incoming.map((edge) => ({
          id: edge.id,
          relation: edge.relation,
          outgoing: false,
          other: edge.other,
        })),
      ]
    : [];

  return (
    <DetailDrawer
      open={id !== null}
      onOpenChange={onOpenChange}
      title={current ? MEMORY_KIND_LABEL[current.kind] : 'Memory'}
      description={
        current
          ? ORIGIN_LABEL[current.origin] + ' · created ' + formatDateTime(current.createdAt)
          : undefined
      }
      footer={
        current ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={current.pinned ? 'secondary' : 'outline'}
              size="sm"
              onClick={() =>
                void onPatch(
                  current.id,
                  { pinned: !current.pinned },
                  current.pinned ? 'Unpinned' : 'Pinned',
                )
              }
            >
              {current.pinned ? (
                <PinOffIcon data-icon="inline-start" />
              ) : (
                <PinIcon data-icon="inline-start" />
              )}
              {current.pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void onPatch(
                  current.id,
                  { dormant: !current.dormantAt },
                  current.dormantAt ? 'Awake' : 'Sleeping',
                )
              }
            >
              {current.dormantAt ? (
                <SunIcon data-icon="inline-start" />
              ) : (
                <MoonIcon data-icon="inline-start" />
              )}
              {current.dormantAt ? 'Wake' : 'Put to sleep'}
            </Button>
            {current.forgotten ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onPatch(current.id, { forgotten: false }, 'Restored')}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Restore
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void onForget(current)}
              >
                <Trash2Icon data-icon="inline-start" />
                Forget
              </Button>
            )}
          </div>
        ) : null
      }
    >
      {current ? (
        <>
          <Field>
            <FieldLabel htmlFor="erinnerung-inhalt">Content</FieldLabel>
            <Textarea
              id="erinnerung-inhalt"
              rows={4}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="erinnerung-art">Type</FieldLabel>
            <Select value={kind} onValueChange={(value) => setKind(value as MemoryKind)}>
              <SelectTrigger id="erinnerung-art" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_KINDS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {MEMORY_KIND_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="erinnerung-wichtigkeit">Importance</FieldLabel>
            <div className="flex items-center gap-3">
              <Slider
                id="erinnerung-wichtigkeit"
                min={0}
                max={1}
                step={0.05}
                value={[importance]}
                onValueChange={(value) => setImportance(value[0] ?? 0.5)}
                className="flex-1"
              />
              <Badge variant="secondary" className="tabular-nums">
                {formatPercent(importance * 100)}
              </Badge>
            </div>
          </Field>

          <Button size="sm" className="w-fit" disabled={!dirty || saving} onClick={() => void save()}>
            Save changes
          </Button>

          {/*
            The words this memory was let in on. Nothing extracted is stored
            without one any more, so showing the quote turns "the assistant
            claims I said this" into something checkable in a second. Rows
            written by hand and rows the night condensed carry none, and simply
            leave the section out.
          */}
          {current.evidence ? (
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Said</h3>
              <blockquote className="border-l-2 pl-3 text-sm italic text-muted-foreground">
                {current.evidence}
              </blockquote>
            </section>
          ) : null}

          <MetaList
            columns={1}
            items={[
              { label: 'Status', value: <StateBadges memory={current} /> },
              { label: 'Accesses', value: formatNumber(current.accessCount) },
              { label: 'Usage', value: formatPercent(current.usefulness * 100) },
              {
                label: 'Last used',
                value: current.lastAccessedAt ? formatDateTime(current.lastAccessedAt) : 'never',
              },
              {
                label: 'Dormant since',
                value: current.dormantAt ? formatDateTime(current.dormantAt) : null,
              },
            ]}
          />

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Topics</h3>
            {loading && !loaded ? (
              <Skeleton className="h-8 w-full" />
            ) : loaded?.entities.length ? (
              <ItemGroup className="gap-1">
                {loaded.entities.map((entity) => (
                  <Item key={entity.id} variant="outline" size="sm">
                    <ItemContent>
                      <ItemTitle className="font-normal">{entity.name}</ItemTitle>
                    </ItemContent>
                    <Badge variant="outline" className="tabular-nums">
                      {formatNumber(entity.mentions)}×
                    </Badge>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <EmptyState
                icon={TagIcon}
                title="Not assigned to a topic yet"
                description="No topics are linked to this memory yet."
                actionLabel="View nights"
                actionTo="/memory/sleep"
                variant="plain"
                size="sm"
              />
            )}
          </section>

          <section className="flex flex-col gap-2 pb-2">
            <h3 className="text-sm font-medium">Connections</h3>
            {loading && !loaded ? (
              <Skeleton className="h-8 w-full" />
            ) : edges.length ? (
              <ItemGroup className="gap-1">
                {edges.map((edge) => (
                  <Item
                    key={edge.id}
                    variant="outline"
                    size="sm"
                    asChild
                    className={edge.other.dormantAt ? 'opacity-70' : undefined}
                  >
                    <button type="button" onClick={() => onJump(edge.other.id)}>
                      <ItemContent>
                        <ItemDescription
                          className={
                            edge.relation === 'contradicts' ? 'text-destructive' : undefined
                          }
                        >
                          {edge.outgoing
                            ? RELATION_LABEL[edge.relation]
                            : RELATION_LABEL[edge.relation] + ' this memory'}
                        </ItemDescription>
                        <ItemTitle className="line-clamp-2 text-left font-normal">
                          {edge.other.content}
                        </ItemTitle>
                      </ItemContent>
                    </button>
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <EmptyState
                icon={SplineIcon}
                title="Standalone"
                description="Connections between memories are created during dream sleep."
                actionLabel="View nights"
                actionTo="/memory/sleep"
                variant="plain"
                size="sm"
              />
            )}
          </section>
        </>
      ) : null}
    </DetailDrawer>
  );
}
