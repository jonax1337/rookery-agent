import { useMemo } from 'react';
import { MoonIcon } from 'lucide-react';
import type { MemoryRecord, SleepRun } from '../lib/types';
import { MEMORY_KIND_LABEL, relativeTime } from '../lib/format';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';

interface MemoryTimelineProps {
  memories: MemoryRecord[];
  runs: SleepRun[];
  onSelect(memory: MemoryRecord): void;
}

type Entry =
  | { kind: 'memory'; at: number; memory: MemoryRecord }
  | { kind: 'sleep'; at: number; run: SleepRun };

/**
 * How the memory got to be the way it is: what was learned when, with the
 * nights marked in between. It is the most honest view of a store that
 * grows, and the only place a night's effect is visible in context.
 */
export function MemoryTimeline({ memories, runs, onSelect }: MemoryTimelineProps) {
  const entries = useMemo<Entry[]>(() => {
    const items: Entry[] = [
      ...memories.map((memory) => ({ kind: 'memory' as const, at: memory.createdAt, memory })),
      ...runs
        .filter((run) => run.status === 'done' && !run.undoneAt)
        .map((run) => ({ kind: 'sleep' as const, at: run.finishedAt ?? run.startedAt, run })),
    ];
    return items.sort((a, b) => b.at - a.at);
  }, [memories, runs]);

  if (!entries.length) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
        Noch nichts passiert.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full rounded-lg border bg-card">
      <ol className="relative space-y-3 p-4 pl-8">
        {/* The spine of the timeline. */}
        <span className="absolute bottom-4 left-[13px] top-4 w-px bg-border" aria-hidden />

        {entries.map((entry) =>
          entry.kind === 'sleep' ? (
            <li key={'s:' + entry.run.id} className="relative">
              <span className="absolute -left-[22px] top-1 grid size-4 place-items-center rounded-full border bg-background">
                <MoonIcon className="size-2.5 text-primary" />
              </span>
              <div className="rounded-md border border-dashed px-2.5 py-1.5">
                <p className="text-xs">{entry.run.report ?? 'Nacht gelaufen'}</p>
                <p className="text-[10.5px] text-muted-foreground">{relativeTime(entry.at)}</p>
              </div>
            </li>
          ) : (
            <li key={'m:' + entry.memory.id} className="relative">
              <span
                className={
                  'absolute -left-[19px] top-2 size-2 rounded-full ' +
                  (entry.memory.dormantAt ? 'bg-muted-foreground/40' : 'bg-primary')
                }
                aria-hidden
              />
              <button
                type="button"
                onClick={() => onSelect(entry.memory)}
                className="w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent"
              >
                <p className={'text-xs leading-snug ' + (entry.memory.dormantAt ? 'opacity-55' : '')}>
                  {entry.memory.content}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                  <Badge variant="outline" className="h-4 px-1 text-[9px] font-normal">
                    {MEMORY_KIND_LABEL[entry.memory.kind]}
                  </Badge>
                  {relativeTime(entry.at)}
                  {entry.memory.origin === 'sleep' ? ' · im Schlaf entstanden' : ''}
                  {entry.memory.dormantAt ? ' · schläft' : ''}
                </p>
              </button>
            </li>
          ),
        )}
      </ol>
    </ScrollArea>
  );
}
