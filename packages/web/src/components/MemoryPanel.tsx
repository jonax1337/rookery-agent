import { useState } from 'react';
import { XIcon } from 'lucide-react';
import { MEMORY_KIND_LABEL, relativeTime } from '../lib/format';
import type { MemoryKind, MemoryRecord, ScoredMemory } from '../lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface MemoryPanelProps {
  items: (MemoryRecord | ScoredMemory)[];
  stats: { total: number; byKind: Record<string, number>; forgotten: number } | null;
  query: string;
  kind: MemoryKind | '';
  loading: boolean;
  /** Ids recalled for the current turn, briefly highlighted. */
  highlighted: Set<string>;
  onQuery(value: string): void;
  onKind(value: MemoryKind | ''): void;
  onAdd(input: { content: string; kind: MemoryKind; importance: number }): void;
  onForget(id: string): void;
}

const KINDS: MemoryKind[] = ['fact', 'preference', 'project', 'event', 'summary'];

function isScored(item: MemoryRecord | ScoredMemory): item is ScoredMemory {
  return 'score' in item;
}

/** Browse, search, add and forget what the assistant remembers. */
export function MemoryPanel({
  items,
  stats,
  query,
  kind,
  loading,
  highlighted,
  onQuery,
  onKind,
  onAdd,
  onForget,
}: MemoryPanelProps) {
  const [draft, setDraft] = useState('');
  const [draftKind, setDraftKind] = useState<MemoryKind>('fact');

  const submit = (): void => {
    const content = draft.trim();
    if (!content) return;
    onAdd({ content, kind: draftKind, importance: 0.7 });
    setDraft('');
  };

  return (
    <aside className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Gedächtnis
          {stats && (
            <Badge variant="secondary" className="tabular h-4 px-1.5 text-[10px]">
              {stats.total}
            </Badge>
          )}
        </h2>
      </div>

      <div className="space-y-2 px-3 py-3">
        <Input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Durchsuchen…"
          aria-label="Erinnerungen durchsuchen"
          className="h-8 text-[13px]"
        />
        <ToggleGroup
          type="single"
          value={kind}
          onValueChange={(value) => onKind((value || '') as MemoryKind | '')}
          variant="outline"
          size="sm"
          className="flex-wrap"
        >
          <ToggleGroupItem value="">Alle</ToggleGroupItem>
          {KINDS.map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {MEMORY_KIND_LABEL[value]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-3">
        {loading && (
          <div className="space-y-2 pb-3" aria-hidden="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}

        {!loading && items.length === 0 && (
          <p className="pb-3 text-[13px] leading-relaxed text-muted-foreground">
            {query
              ? 'Nichts gefunden.'
              : 'Noch nichts gespeichert. Rookery lernt nach jedem Gespräch von selbst dazu.'}
          </p>
        )}

        <ul className="space-y-1.5 pb-3">
          {items.map((item) => (
            <li
              key={item.id}
              className={
                'group rounded-lg border p-2.5 transition-colors ' +
                (highlighted.has(item.id) ? 'border-primary/60 bg-primary/5' : 'bg-card')
              }
            >
              <div className="flex items-start gap-2">
                <p className="flex-1 text-[13px] leading-snug">{item.content}</p>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onForget(item.id)}
                  aria-label="Diese Erinnerung vergessen"
                  className="shrink-0 opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <XIcon />
                </Button>
              </div>

              <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                <Badge variant="outline" className="h-4 px-1.5 text-[9.5px] font-normal">
                  {MEMORY_KIND_LABEL[item.kind]}
                </Badge>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="w-10">
                      <Progress value={Math.round(item.importance * 100)} className="h-1" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    Wichtigkeit {Math.round(item.importance * 100)}%
                  </TooltipContent>
                </Tooltip>
                <span className="tabular">{relativeTime(item.updatedAt)}</span>
                {isScored(item) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="tabular ml-auto text-primary">{item.score.toFixed(2)}</span>
                    </TooltipTrigger>
                    <TooltipContent>{item.reason}</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ScrollArea>

      <div className="space-y-2 border-t p-3">
        <Textarea
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Etwas, das ich mir merken soll…"
          aria-label="Erinnerung hinzufügen"
          className="min-h-0 resize-none text-[13px]"
        />
        <div className="flex items-center gap-1.5">
          <Select value={draftKind} onValueChange={(value) => setDraftKind(value as MemoryKind)}>
            <SelectTrigger size="sm" className="h-8 flex-1 text-xs" aria-label="Art der Erinnerung">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {MEMORY_KIND_LABEL[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={submit} disabled={!draft.trim()} className="h-8">
            Merken
          </Button>
        </div>
      </div>
    </aside>
  );
}
