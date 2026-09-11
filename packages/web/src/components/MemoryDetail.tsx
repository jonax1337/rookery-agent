import { useEffect, useState } from 'react';
import { PinIcon, SunIcon, Trash2Icon } from 'lucide-react';
import { api } from '../lib/api';
import type { MemoryNeighbourhood, MemoryRecord } from '../lib/types';
import { MEMORY_KIND_LABEL, ORIGIN_LABEL, RELATION_LABEL, relativeTime } from '../lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';

interface MemoryDetailProps {
  memory: MemoryRecord | null;
  onClose(): void;
  onPin(id: string, pinned: boolean): void;
  onWake(id: string): void;
  onForget(id: string): void;
}

/**
 * One memory, with everything hanging off it: what it is about, what it
 * refines, what contradicts it, what replaced it. This is where the graph
 * stops being a picture and becomes something you can act on.
 */
export function MemoryDetail({ memory, onClose, onPin, onWake, onForget }: MemoryDetailProps) {
  const [detail, setDetail] = useState<MemoryNeighbourhood | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!memory) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .memoryEdges(memory.id)
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
  }, [memory]);

  const current = detail?.memory ?? memory;

  return (
    <Sheet open={Boolean(memory)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        {current ? (
          <>
            <SheetHeader>
              <SheetTitle className="text-sm font-medium leading-snug">{current.content}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <Badge variant="secondary" className="h-4 px-1.5 text-[9.5px]">
                  {MEMORY_KIND_LABEL[current.kind]}
                </Badge>
                <span>Gewicht {current.importance.toFixed(2)}</span>
                <span>·</span>
                <span>{ORIGIN_LABEL[current.origin]}</span>
                <span>·</span>
                <span>{relativeTime(current.createdAt)}</span>
                {current.dormantAt ? (
                  <Badge variant="outline" className="h-4 px-1.5 text-[9.5px]">
                    schläft
                  </Badge>
                ) : null}
                {current.pinned ? (
                  <Badge variant="outline" className="h-4 px-1.5 text-[9.5px]">
                    angeheftet
                  </Badge>
                ) : null}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-4 overflow-y-auto px-4 pb-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={current.pinned ? 'secondary' : 'outline'}
                  className="h-7 text-xs"
                  onClick={() => onPin(current.id, !current.pinned)}
                >
                  <PinIcon className="size-3.5" />
                  {current.pinned ? 'Nicht mehr anheften' : 'Anheften'}
                </Button>
                {current.dormantAt ? (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onWake(current.id)}>
                    <SunIcon className="size-3.5" />
                    Aufwecken
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => onForget(current.id)}
                >
                  <Trash2Icon className="size-3.5" />
                  Vergessen
                </Button>
              </div>

              <p className="text-[11px] text-muted-foreground">
                {current.accessCount} mal abgerufen · Nutzen {current.usefulness.toFixed(2)}
                {current.lastAccessedAt ? ' · zuletzt ' + relativeTime(current.lastAccessedAt) : ''}
              </p>

              {loading ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-full" />
                </div>
              ) : null}

              {detail?.entities.length ? (
                <div>
                  <Separator className="mb-3" />
                  <p className="mb-1.5 text-[11px] font-medium">Themen</p>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.entities.map((entity) => (
                      <Badge key={entity.id} variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                        {entity.name}
                        <span className="ml-1 text-muted-foreground">{entity.mentions}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {detail && (detail.outgoing.length || detail.incoming.length) ? (
                <div>
                  <Separator className="mb-3" />
                  <p className="mb-1.5 text-[11px] font-medium">Verbindungen</p>
                  <ul className="space-y-2">
                    {detail.outgoing.map((edge) => (
                      <li key={edge.id} className="text-[11px] leading-snug">
                        <span
                          className={edge.relation === 'contradicts' ? 'text-destructive' : 'text-muted-foreground'}
                        >
                          {RELATION_LABEL[edge.relation]}
                        </span>{' '}
                        <span className={edge.other.dormantAt ? 'opacity-60' : ''}>{edge.other.content}</span>
                      </li>
                    ))}
                    {detail.incoming.map((edge) => (
                      <li key={edge.id} className="text-[11px] leading-snug">
                        <span className={edge.other.dormantAt ? 'opacity-60' : ''}>{edge.other.content}</span>{' '}
                        <span
                          className={edge.relation === 'contradicts' ? 'text-destructive' : 'text-muted-foreground'}
                        >
                          {RELATION_LABEL[edge.relation]} diese Erinnerung
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
