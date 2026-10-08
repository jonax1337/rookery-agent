import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import {
  BookmarkIcon as PinIcon,
  BookmarkXIcon as PinOffIcon,
  BrainIcon,
  DeleteIcon as Trash2Icon,
  ExternalLinkIcon as SquareArrowOutUpRightIcon,
  MoonIcon,
  RotateCcwIcon,
  SunIcon,
} from '@/components/icons';
import { toast } from 'sonner';

import { reportFailure } from '@/lib/errors';
import { MEMORY_KIND_LABEL, MEMORY_KINDS, shorten } from '@/lib/format';
import type { MemoryRecord, ScoredMemory } from '@/lib/types';
import { useMemoryState } from '@/providers/rookery-provider';
import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { DataTable, type DataTableTab } from '@/components/blocks/data-table/data-table';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState, NoResults, ServerOffline } from '@/components/common/empty-state';
import {
  buildMemoryColumns,
  MEMORY_COLUMN_LABELS,
  MEMORY_SORTING,
} from '@/components/common/memory-columns';
import { RowMenuButton } from '@/components/common/row-menu-button';
import { useMemoryOutlet } from '@/pages/MemoryLayout';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

import { MemoryDrawer, MemoryStateBadges } from './memory/MemoryDrawer';
import {
  pinChange,
  RESTORE_CHANGE,
  sleepChange,
  type ApplyChange,
  type MemoryChange,
} from './memory/memory-changes';
import { useRecallFeedback } from './memory/RecallFeedback';

/**
 * Everything the assistant knows, as one table.
 *
 * Facets with counts, one search, a row menu that spells out every action,
 * and a drawer that shows what a memory hangs on.
 *
 * Two honesty notes carry the page. The search is the assistant's own blended
 * recall (`GET /api/memories?q=`), so its answer is ranked rather than
 * filtered: the "Matches" column shows the score and the reason, and the table
 * is told not to filter that answer a second time. And the list is capped at
 * the server's 500, which the footer says - out loud once it actually hangs
 * there.
 */

const ALL_TAB = 'all';

/** The graph page sends a memory over as `/memory/memories?memory=<id>`. */
const REQUESTED_MEMORY_PARAM = 'memory';

function isScored(item: MemoryRecord | ScoredMemory): item is ScoredMemory {
  return 'score' in item;
}

export function MemoryListPage() {
  const { memories, graph, highlighted } = useMemoryState();
  const { openRemember } = useMemoryOutlet();
  const { confirm, dialog } = useConfirm();

  const [tab, setTab] = useState(ALL_TAB);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useOpenRequestedMemory(setSelectedId);

  const query = memories.query.trim();
  const searching = query.length > 0;

  const applyChange = useCallback<ApplyChange>(
    async (id, { patch, message }) => {
      try {
        await memories.patch(id, patch);
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
      try {
        await memories.forget(memory.id);
      } catch (caught) {
        reportFailure('Forget', caught);
        // The list drops the row even when the call fails; ask the server what is true.
        void memories.refresh();
        return;
      }
      void graph.refresh();
      setSelectedId((current) => (current === memory.id ? null : current));
      toast('Forget', { description: memory.content });
    },
    [confirm, graph, memories],
  );

  const renderFeedback = useRecallFeedback(highlighted);

  // The whole table comes out of `buildMemoryColumns`; only the score column is
  // conditional, because a ranking only exists while a search is running - an
  // always-empty "Matches" column would read as a ranking that failed rather
  // than as a list that was never ranked.
  const columns = useMemo(
    () =>
      buildMemoryColumns({
        selectable: true,
        onOpen: (memory) => setSelectedId(memory.id),
        highlighted: highlighted.ids,
        state: (memory) => <MemoryStateBadges memory={memory} />,
        ...(searching
          ? {
              score: (memory: MemoryRecord) =>
                isScored(memory) ? { value: memory.score, reason: memory.reason } : null,
            }
          : {}),
        ...(renderFeedback ? { feedback: renderFeedback } : {}),
        rowActions: (memory) => (
          <MemoryRowActions
            memory={memory}
            onOpen={() => setSelectedId(memory.id)}
            onChange={applyChange}
            onForget={() => void forget(memory)}
          />
        ),
      }),
    [applyChange, forget, highlighted.ids, renderFeedback, searching],
  );

  const rows = useMemo(
    () => (tab === ALL_TAB ? memories.items : memories.items.filter((item) => item.kind === tab)),
    [memories.items, tab],
  );

  const tabs = useMemo<DataTableTab[]>(() => {
    const counts = new Map<string, number>();
    for (const item of memories.items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
    return [
      { value: ALL_TAB, label: 'All', count: memories.items.length },
      ...MEMORY_KINDS.map((kind) => ({
        value: kind,
        label: MEMORY_KIND_LABEL[kind],
        count: counts.get(kind) ?? 0,
      })),
    ];
  }, [memories.items]);

  const reset = useCallback(() => {
    setTab(ALL_TAB);
    memories.setQuery('');
  }, [memories]);

  const nothing = (
    <NothingToShow
      query={searching ? query : null}
      bankIsEmpty={memories.items.length === 0}
      onReset={reset}
      onRemember={openRemember}
    />
  );

  return (
    <>
      {dialog}

      {/* Only the container takes part in the motion: the guideline animates
          a list as a whole, never row by row. */}
      <Fade>
        <DataTable
          data={rows}
          columns={columns}
          getRowId={(memory) => memory.id}
          idPrefix="memories"
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
          error={
            memories.error ? <ServerOffline onRetry={() => void memories.refresh()} /> : undefined
          }
          onRowClick={(memory) => setSelectedId(memory.id)}
          rowClassName={(memory) =>
            memory.forgotten || memory.dormantAt ? 'opacity-70' : undefined
          }
          filters={
            <div className="flex items-center gap-2">
              <Switch
                id="show-forgotten"
                checked={memories.includeForgotten}
                onCheckedChange={memories.setIncludeForgotten}
              />
              <Label htmlFor="show-forgotten" className="text-sm font-normal text-muted-foreground">
                Show forgotten
              </Label>
            </div>
          }
          bulkActions={(selected, clear) => (
            <BulkActions selected={selected} onChange={applyChange} onDone={clear} />
          )}
          empty={nothing}
          filteredEmpty={nothing}
        />
      </Fade>

      <MemoryDrawer
        id={selectedId}
        fallback={memories.items.find((item) => item.id === selectedId) ?? null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onJump={setSelectedId}
        onChange={applyChange}
        onForget={forget}
      />
    </>
  );
}

/**
 * The net hands a memory over in the URL. The parameter is removed at once,
 * otherwise closing the drawer later would pull it open again on the next
 * render - and the browser's back button would land on the same open drawer.
 */
function useOpenRequestedMemory(open: (id: string) => void): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get(REQUESTED_MEMORY_PARAM);

  useEffect(() => {
    if (!requested) return;
    open(requested);
    setSearchParams({}, { replace: true });
  }, [open, requested, setSearchParams]);
}

/**
 * Three different kinds of nothing, and they mean different things: a search
 * that missed, a facet nobody has filled yet, and a bank that is genuinely
 * empty. Only the last one is an invitation to write the first memory.
 */
function NothingToShow({
  query,
  bankIsEmpty,
  onReset,
  onRemember,
}: {
  /** The running search, or `null` when the list is not being searched. */
  query: string | null;
  bankIsEmpty: boolean;
  onReset(): void;
  onRemember(): void;
}) {
  if (query !== null) return <NoResults query={query} onReset={onReset} />;
  if (!bankIsEmpty) return <NoResults onReset={onReset} />;
  return (
    <EmptyState
      icon={BrainIcon}
      title="No memories yet"
      description="Rookery learns automatically after every conversation. You can save anything that should be remembered immediately here."
      actionLabel="Save memory"
      onAction={onRemember}
      variant="plain"
      size="sm"
    />
  );
}

function BulkActions({
  selected,
  onChange,
  onDone,
}: {
  selected: MemoryRecord[];
  onChange: ApplyChange;
  onDone(): void;
}) {
  const applyToSelected = (applicable: (memory: MemoryRecord) => boolean, change: MemoryChange) => {
    for (const memory of selected) {
      if (applicable(memory)) void onChange(memory.id, change);
    }
    onDone();
  };

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => applyToSelected((memory) => !memory.pinned, pinChange(true))}
      >
        Pin
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => applyToSelected((memory) => !memory.dormantAt, sleepChange(true))}
      >
        Put to sleep
      </Button>
    </>
  );
}

/**
 * Every action on one memory, spelled out. The trigger is always there and the
 * destructive entry sits behind a separator and a confirmation.
 */
function MemoryRowActions({
  memory,
  onOpen,
  onChange,
  onForget,
}: {
  memory: MemoryRecord;
  onOpen(): void;
  onChange: ApplyChange;
  onForget(): void;
}) {
  const asleep = Boolean(memory.dormantAt);
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
          <DropdownMenuItem onSelect={() => void onChange(memory.id, pinChange(!memory.pinned))}>
            {memory.pinned ? (
              <PinOffIcon data-icon="inline-start" />
            ) : (
              <PinIcon data-icon="inline-start" />
            )}
            {memory.pinned ? 'Unpin' : 'Pin'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void onChange(memory.id, sleepChange(!asleep))}>
            {asleep ? <SunIcon data-icon="inline-start" /> : <MoonIcon data-icon="inline-start" />}
            {asleep ? 'Wake' : 'Put to sleep'}
          </DropdownMenuItem>
          {memory.forgotten ? (
            <DropdownMenuItem onSelect={() => void onChange(memory.id, RESTORE_CHANGE)}>
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
