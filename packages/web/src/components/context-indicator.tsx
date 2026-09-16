import { useState } from 'react';

import { formatNumber } from '@/lib/stats';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';

/**
 * How full the model's head is. Nothing else.
 *
 * This sits in the composer, next to the model and effort menus, because that
 * is what it belongs to: the context is a property of the conversation being
 * written, not of the app. The subscription's quota windows used to hang
 * underneath it here - they live where they belong now, on the dashboard and
 * in the avatar menu, and asking the provider for them on every chat screen
 * was a request per composer mount for a number nobody was reading here.
 *
 * The window is never guessed. The harness reports it per turn, and a
 * conversation that has an answer in it carries the real figure - a model with
 * a one-million window says one million. Before the first answer there is no
 * window, so there is no percentage either, and the panel says so instead of
 * inventing a default that would be wrong for every long-context model.
 */

export interface ContextUsage {
  /** Tokens the model had in front of it on the last request. */
  tokens: number;
  /** The window those tokens sit in, as the provider reported it. */
  window?: number;
}

/** Comfortable, getting full, nearly full - the same three steps everywhere. */
function tone(percent: number | null): string {
  if (percent === null) return 'text-muted-foreground';
  if (percent >= 90) return 'text-destructive';
  if (percent >= 70) return 'text-status-warn';
  return 'text-foreground';
}

/** The fill colour of a `Progress`, which paints its indicator `bg-primary`. */
function barTone(percent: number): string {
  if (percent >= 90) return '*:data-[slot=progress-indicator]:bg-destructive';
  if (percent >= 70) return '*:data-[slot=progress-indicator]:bg-status-warn';
  return '';
}

interface ContextIndicatorProps {
  context: ContextUsage | null;
}

/**
 * The composer's context gauge: a short bar plus the share of the model
 * window, in the tokens the provider reported for the last request. The panel
 * opens the same figure as a dial.
 */
export function ContextIndicator({ context }: ContextIndicatorProps) {
  const [open, setOpen] = useState(false);

  const window = context?.window;
  const percent = context && window ? Math.min(100, Math.round((context.tokens / window) * 100)) : null;
  const valueTone = tone(percent);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={
            percent !== null ? 'Context: ' + percent + ' percent used' : 'Context not measured yet'
          }
          className="h-8 gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground tabular-nums hover:text-foreground"
        >
          <Progress
            value={percent ?? 0}
            aria-hidden="true"
            className={cn('h-1 w-8 shrink-0', barTone(percent ?? 0))}
          />
          <span className={cn(percent !== null && percent >= 70 && valueTone)}>
            {percent !== null ? percent + ' %' : context ? formatNumber(context.tokens) : '–'}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-72">
        <PopoverHeader className="gap-2.5 p-0">
          <div className="flex items-baseline justify-between gap-3">
            <PopoverTitle className="text-sm font-semibold">Context</PopoverTitle>
            {percent !== null && (
              <span className={cn('text-sm font-medium tabular-nums', valueTone)}>
                {percent}% used
              </span>
            )}
          </div>

          {percent !== null && (
            <Progress
              value={percent}
              aria-label="Context used"
              className={cn('h-1.5', barTone(percent))}
            />
          )}

          <PopoverDescription className="text-xs tabular-nums">
            {context ? (
              <>
                <span className="font-medium text-foreground">{formatNumber(context.tokens)}</span>
                {window ? ' / ' + formatNumber(window) + ' tokens' : ' tokens'}
                {' · last response'}
              </>
            ) : (
              'Measured after the first response.'
            )}
          </PopoverDescription>
        </PopoverHeader>
      </PopoverContent>
    </Popover>
  );
}
