import { useEffect, useMemo, useRef, useState } from 'react';

import { Fade } from '@/components/animate-ui/primitives/effects/fade';
import { formatToolValue } from '@/components/assistant-ui/elements/compact-tool-call';
import { ToolCall } from '@/components/assistant-ui/elements/tool-call';
import { ResultMarkdown } from '@/components/result-markdown';
import { RunningBadge } from '@/components/common/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { prettyToolName } from '@/hooks/useChat';
import { useAssignmentLog } from '@/hooks/useAssignmentLog';
import { useConnection, useOrgState } from '@/providers/rookery-provider';
import { TurnBlocks } from '@/lib/blocks';
import type { AgentEvent, AssignmentStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * The live window onto one running assignment: text, thinking and tool calls
 * in the order they happen - what the original Claude Code terminal shows.
 *
 * The buffer this reads is live-only: it exists while the run lasts, and the
 * moment the run ends only the persisted result remains, so the section is
 * mounted for running assignments and taken down when they finish.
 */

type TerminalRow =
  | { kind: 'block'; index: number }
  | { kind: 'status'; label: string; detail?: string }
  | { kind: 'error'; message: string };

interface FoldedRow {
  key: string;
  row: TerminalRow;
}

export interface AssignmentTerminalProps {
  assignmentId: string;
  /** The status the host page already knows; unset falls back to `org.live`. */
  status?: AssignmentStatus;
  className?: string;
}

export function AssignmentTerminal({ assignmentId, status: statusProp, className }: AssignmentTerminalProps) {
  const { socket } = useConnection();
  const org = useOrgState();
  const status = statusProp ?? org.live[assignmentId]?.status;
  const log = useAssignmentLog(socket, assignmentId, status !== undefined ? { liveStatus: status } : {});

  const [showThinking, setShowThinking] = useState(false);

  // Entries become rows: foldable events run through the same TurnBlocks
  // state machine the transcript uses, status and errors interleave as their
  // own one-liners. A block's position is its identity between renders - new
  // blocks only ever appear at the end, a start/end merge lands in place.
  const folded = useMemo(() => {
    const folder = new TurnBlocks();
    const rows: FoldedRow[] = [];
    let blockRows = 0;
    for (const { seq, event } of log.entries) {
      if (event.type === 'text' || event.type === 'thinking' || event.type === 'tool') {
        folder.apply(event);
        while (blockRows < folder.blocks.length) {
          rows.push({ key: 'b' + blockRows, row: { kind: 'block', index: blockRows } });
          blockRows += 1;
        }
      } else if (event.type === 'status') {
        // The one status a log carries is the provider switch, and the
        // controller resets its buffer for it: the attempt the watcher just
        // saw fail is over. Ending it here keeps the retry's first delta
        // from gluing onto its trailing text - what a watcher attaching
        // after the switch sees is only the retry anyway.
        folder.reconcile('');
        rows.push({ key: 's' + seq, row: { kind: 'status', label: event.label, detail: event.detail } });
      } else if (event.type === 'error') {
        rows.push({ key: 'e' + seq, row: { kind: 'error', message: event.message } });
      }
    }
    return { rows, blocks: folder.blocks };
  }, [log.entries]);

  const visible = useMemo(
    () =>
      showThinking
        ? folded.rows
        : folded.rows.filter(({ row }) => row.kind !== 'block' || folded.blocks[row.index]?.type !== 'thinking'),
    [folded, showThinking],
  );
  const hasThinking = folded.blocks.some((block) => block.type === 'thinking');

  /* Auto-scroll with pin-to-bottom: following the run keeps the newest line
     in view; scrolling up pauses the chase until the reader returns to the
     bottom themselves. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  useEffect(() => {
    if (!pinnedRef.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible, log.finished]);
  const handleScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  };

  return (
    <Fade asChild>
      <Card className={cn('py-3', className)} aria-label="Live terminal of this run">
        <CardHeader className="flex flex-wrap items-center gap-2 border-b px-3!">
          <CardTitle className="text-sm">Live</CardTitle>
          {!log.finished ? <RunningBadge count={1} /> : null}
          {hasThinking ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto text-muted-foreground"
              onClick={() => setShowThinking((current) => !current)}
            >
              {showThinking ? 'Thinking verbergen' : 'Thinking zeigen'}
            </Button>
          ) : null}
        </CardHeader>

        <Fade asChild delay={50}>
          <CardContent className="px-3!">
            <div className="flex flex-col gap-2">
              {log.error ? (
                <p className="text-xs leading-snug text-destructive">{log.error}</p>
              ) : null}
              {log.overflowed ? (
                <p className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                  Anfang wurde verworfen — der Live-Puffer behält nur die neuesten Einträge.
                </p>
              ) : null}

              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="flex max-h-[28rem] min-h-24 flex-col gap-1.5 overflow-y-auto pr-1"
              >
                {visible.length === 0 ? (
                  <p className="py-4 text-center text-xs text-muted-foreground">
                    {log.finished
                      ? 'Der Lauf ist beendet.'
                      : log.error
                        ? 'Das Live-Log ist über die WebSocket erreichbar.'
                        : 'Warte auf den ersten Output …'}
                  </p>
                ) : (
                  visible.map(({ key, row }) => {
                    if (row.kind === 'status') {
                      return (
                        <p key={key} className="text-xs text-muted-foreground/80">
                          {row.detail ? row.label + ' · ' + row.detail : row.label}
                        </p>
                      );
                    }
                    if (row.kind === 'error') {
                      return (
                        <p key={key} className="text-xs leading-snug text-destructive">
                          {row.message}
                        </p>
                      );
                    }
                    const block = folded.blocks[row.index];
                    if (!block) return null;
                    if (block.type === 'thinking') return <ThinkingRow key={key} text={block.text} />;
                    if (block.type === 'text') return <ResultMarkdown key={key} text={block.text} />;
                    return <TerminalToolRow key={key} event={block.call} />;
                  })
                )}
              </div>
            </div>
          </CardContent>
        </Fade>
      </Card>
    </Fade>
  );
}

/** Dimmed, quiet: reasoning is context, not the answer. */
function ThinkingRow({ text }: { text: string }) {
  return (
    <p className="border-l border-border pl-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground/70">
      {text}
    </p>
  );
}

/**
 * One tool call as a terminal line: name and query visible at a glance, the
 * result behind the same collapsible the chat transcript uses. The line only
 * exists because the terminal is not the chat - the visual language is.
 */
function TerminalToolRow({ event }: { event: Extract<AgentEvent, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const name = prettyToolName(event.name);
  return (
    <ToolCall
      label={name}
      activeLabel={name}
      query={event.detail ?? ''}
      request={formatToolValue(event.detail)}
      result={formatToolValue(event.result)}
      running={event.status === 'start'}
      failed={event.isError === true}
      open={open}
      onOpenChange={setOpen}
      className="max-w-none"
    />
  );
}
