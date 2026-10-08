import { useCallback, useEffect, useState } from 'react';

import {
  BookmarkIcon as PinIcon,
  BookmarkIcon as TagIcon,
  BookmarkXIcon as PinOffIcon,
  DeleteIcon as Trash2Icon,
  MoonIcon,
  RotateCcwIcon,
  SunIcon,
  WaypointsIcon as SplineIcon,
} from '@/components/icons';

import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import { MEMORY_KIND_LABEL, MEMORY_KINDS, ORIGIN_LABEL, RELATION_LABEL } from '@/lib/format';
import { formatDateTime, formatNumber } from '@/lib/stats';
import type { MemoryKind, MemoryNeighbourhood, MemoryRecord, MemoryRelation } from '@/lib/types';
import { SlidingNumber } from '@/components/animate-ui/primitives/texts/sliding-number';
import { DetailDrawer } from '@/components/blocks/detail-drawer';
import { SectionHeading } from '@/components/blocks/section-heading';
import { EmptyState } from '@/components/common/empty-state';
import { MetaList } from '@/components/common/meta-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';

import {
  pinChange,
  RESTORE_CHANGE,
  sleepChange,
  type ApplyChange,
  type MemoryChange,
} from './memory-changes';

/** A slider moves in 0.05 steps; anything finer than this is float noise, not an edit. */
const IMPORTANCE_EPSILON = 0.001;

/** What a memory currently is, as the badges the status column draws. */
export function MemoryStateBadges({ memory }: { memory: MemoryRecord }) {
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

interface MemoryDrawerProps {
  id: string | null;
  /** The row that opened it, so the drawer has something to show at once. */
  fallback: MemoryRecord | null;
  onOpenChange(open: boolean): void;
  /** Clicking a neighbour opens that memory instead of this one. */
  onJump(id: string): void;
  onChange: ApplyChange;
  onForget(memory: MemoryRecord): Promise<void>;
}

/**
 * One memory, with everything hanging off it.
 *
 * The three fields that make a memory what it is are editable here: a wrong
 * fact is a choice between correcting it and forgetting it.
 */
export function MemoryDrawer({
  id,
  fallback,
  onOpenChange,
  onJump,
  onChange,
  onForget,
}: MemoryDrawerProps) {
  const { neighbourhood, loading, reload } = useMemoryNeighbourhood(id);
  const current = neighbourhood?.memory ?? fallback;

  // The neighbourhood carries its own copy of the memory, so it is fetched
  // again after every edit - otherwise the footer would keep offering "Pin"
  // on a memory that is already pinned.
  const applyChange = useCallback(
    async (memoryId: string, change: MemoryChange): Promise<void> => {
      await onChange(memoryId, change);
      reload();
    },
    [onChange, reload],
  );

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
          <DrawerActions memory={current} onChange={applyChange} onForget={onForget} />
        ) : null
      }
    >
      {current ? (
        <>
          {/* Keyed by id: the draft belongs to one memory and a refetch underneath must not wipe a half-typed correction. */}
          <MemoryEditor key={current.id} memory={current} onChange={applyChange} />
          <Evidence quote={current.evidence} />
          <MemoryVitals memory={current} />
          <TopicsSection neighbourhood={neighbourhood} loading={loading} />
          <ConnectionsSection neighbourhood={neighbourhood} loading={loading} onJump={onJump} />
        </>
      ) : null}
    </DetailDrawer>
  );
}

/**
 * The edges are a second request, so the drawer opens on the row it already
 * has and fills the neighbourhood in a moment later.
 */
function useMemoryNeighbourhood(id: string | null) {
  const [detail, setDetail] = useState<MemoryNeighbourhood | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((current) => current + 1), []);

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
      .catch((caught: unknown) => {
        if (cancelled) return;
        setDetail(null);
        reportFailure('Loading connections', caught);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, revision]);

  const neighbourhood = detail && detail.memory.id === id ? detail : null;
  return { neighbourhood, loading, reload };
}

function DrawerActions({
  memory,
  onChange,
  onForget,
}: {
  memory: MemoryRecord;
  onChange: ApplyChange;
  onForget(memory: MemoryRecord): Promise<void>;
}) {
  const asleep = Boolean(memory.dormantAt);
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant={memory.pinned ? 'secondary' : 'outline'}
        size="sm"
        onClick={() => void onChange(memory.id, pinChange(!memory.pinned))}
      >
        {memory.pinned ? (
          <PinOffIcon data-icon="inline-start" />
        ) : (
          <PinIcon data-icon="inline-start" />
        )}
        {memory.pinned ? 'Unpin' : 'Pin'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void onChange(memory.id, sleepChange(!asleep))}
      >
        {asleep ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
        {asleep ? 'Wake' : 'Put to sleep'}
      </Button>
      {memory.forgotten ? (
        <Button variant="outline" size="sm" onClick={() => void onChange(memory.id, RESTORE_CHANGE)}>
          <RotateCcwIcon data-icon="inline-start" />
          Restore
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void onForget(memory)}
        >
          <Trash2Icon data-icon="inline-start" />
          Forget
        </Button>
      )}
    </div>
  );
}

/** The content, kind and importance of one memory, as a draft with its own save button. */
function MemoryEditor({ memory, onChange }: { memory: MemoryRecord; onChange: ApplyChange }) {
  const [content, setContent] = useState(memory.content);
  const [kind, setKind] = useState<MemoryKind>(memory.kind);
  const [importance, setImportance] = useState(memory.importance);
  const [saving, setSaving] = useState(false);

  const dirty =
    content.trim() !== memory.content ||
    kind !== memory.kind ||
    Math.abs(importance - memory.importance) > IMPORTANCE_EPSILON;

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await onChange(memory.id, {
        patch: { content: content.trim(), kind, importance },
        message: 'Saved',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Field>
        <FieldLabel htmlFor="memory-content">Content</FieldLabel>
        <Textarea
          id="memory-content"
          rows={4}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="memory-kind">Type</FieldLabel>
        <Select value={kind} onValueChange={(value) => setKind(value as MemoryKind)}>
          <SelectTrigger id="memory-kind" className="w-full">
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
        <FieldLabel htmlFor="memory-importance">Importance</FieldLabel>
        <div className="flex items-center gap-3">
          <Slider
            id="memory-importance"
            min={0}
            max={1}
            step={0.05}
            value={[importance]}
            onValueChange={(value) => setImportance(value[0] ?? importance)}
            className="flex-1"
          />
          {/* The slider's live value: the digits roll while formatPercent's
              resting pose ("50%") stays exactly as it was. */}
          <Badge variant="secondary" className="tabular-nums">
            <SlidingNumber number={Math.round(importance * 100)} />%
          </Badge>
        </div>
      </Field>

      <Button size="sm" className="w-fit" disabled={!dirty || saving} onClick={() => void save()}>
        Save changes
      </Button>
    </>
  );
}

/**
 * The words this memory was let in on. Nothing extracted is stored without
 * one any more, so showing the quote turns "the assistant claims I said this"
 * into something checkable in a second. Rows written by hand and rows the
 * night condensed carry none, and simply leave the section out.
 */
function Evidence({ quote }: { quote: string | undefined }) {
  if (!quote) return null;
  return (
    <SectionHeading title="Said" size="sm" flush>
      <blockquote className="border-l-2 pl-3 text-sm italic text-muted-foreground">
        {quote}
      </blockquote>
    </SectionHeading>
  );
}

function MemoryVitals({ memory }: { memory: MemoryRecord }) {
  return (
    <MetaList
      columns={1}
      items={[
        { label: 'Status', value: <MemoryStateBadges memory={memory} /> },
        {
          label: 'Accesses',
          // CountingNumber has no separator support and would drop
          // formatNumber's en-GB grouping ("1,234") in the resting pose.
          value: <SlidingNumber number={memory.accessCount} fromNumber={0} thousandSeparator="," />,
        },
        {
          label: 'Usage',
          value: (
            <>
              <SlidingNumber number={Math.round(memory.usefulness * 100)} fromNumber={0} />%
            </>
          ),
        },
        {
          label: 'Last used',
          value: memory.lastAccessedAt ? formatDateTime(memory.lastAccessedAt) : 'never',
        },
        {
          label: 'Dormant since',
          value: memory.dormantAt ? formatDateTime(memory.dormantAt) : null,
        },
      ]}
    />
  );
}

interface NeighbourhoodSectionProps {
  neighbourhood: MemoryNeighbourhood | null;
  loading: boolean;
}

function TopicsSection({ neighbourhood, loading }: NeighbourhoodSectionProps) {
  return (
    <SectionHeading title="Topics" size="sm" flush>
      {loading && !neighbourhood ? (
        <Skeleton className="h-8 w-full" />
      ) : neighbourhood?.entities.length ? (
        <ItemGroup className="gap-1">
          {neighbourhood.entities.map((entity) => (
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
    </SectionHeading>
  );
}

/** One edge of the neighbourhood, flattened with the direction it was read in. */
interface DrawerEdge {
  id: string;
  relation: MemoryRelation;
  /** True when this memory is the one doing the refining, contradicting, … */
  outgoing: boolean;
  other: MemoryRecord;
}

function flattenEdges(neighbourhood: MemoryNeighbourhood): DrawerEdge[] {
  return [
    ...neighbourhood.outgoing.map((edge) => ({ ...edge, outgoing: true })),
    ...neighbourhood.incoming.map((edge) => ({ ...edge, outgoing: false })),
  ];
}

function ConnectionsSection({
  neighbourhood,
  loading,
  onJump,
}: NeighbourhoodSectionProps & { onJump(id: string): void }) {
  const edges = neighbourhood ? flattenEdges(neighbourhood) : [];

  return (
    <SectionHeading title="Connections" size="sm" flush className="pb-2">
      {loading && !neighbourhood ? (
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
                    className={edge.relation === 'contradicts' ? 'text-destructive' : undefined}
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
    </SectionHeading>
  );
}
