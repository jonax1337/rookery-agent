import { useEffect, useMemo, useRef, useState } from 'react';

import { formatToolValue } from '@/components/assistant-ui/elements/compact-tool-call';
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
 * And it looks like one. A transcript is a recording of events, not a
 * document: monospace, one column, chronological, printed rather than
 * typeset. No card, no heading, no badges, no fade-ins, and no markdown -
 * the finished result of the same work stays markdown, on the page where it
 * belongs. Tool calls keep their information and lose the chat widget: a
 * line with name and argument, the result unfolding underneath in the same
 * block, because a terminal that hides what a tool returned is a progress
 * bar.
 *
 * The buffer this reads is live-only while the run lasts; the journal behind
 * it answers after the end too, so the transcript survives the run.
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
     in view; scrolling up stops the chase so the reader can stay where they
     are, and the button that comes up with it starts it again. */
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);
  useEffect(() => {
    if (!following) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible, log.finished, following]);
  const handleScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    if (atBottom !== followingRef.current) setFollowing(atBottom);
  };

  return (
    <div
      className={cn('relative rounded-lg bg-zinc-950 font-mono text-xs text-zinc-200', className)}
      aria-label="Live terminal of this run"
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex max-h-[28rem] min-h-24 flex-col gap-1 overflow-y-auto p-3 pb-6 leading-relaxed"
      >
        {/* Sticky rather than floating: a toggle laid over the transcript
            covers the first line the moment the block gets narrow. */}
        {hasThinking ? (
          <div className="sticky top-0 z-10 -mt-1 flex justify-end bg-zinc-950 pb-1">
            <button
              type="button"
              className="text-[11px] text-zinc-500 hover:text-zinc-200"
              onClick={() => setShowThinking((current) => !current)}
            >
              {showThinking ? 'hide thinking' : 'show thinking'}
            </button>
          </div>
        ) : null}
        {log.overflowed ? (
          <p className="text-zinc-500">
            [the beginning was dropped — the live buffer keeps only the newest entries]
          </p>
        ) : null}
        {log.error ? <p className="text-red-400">{log.error}</p> : null}

        {visible.length === 0 ? (
          <p className="text-zinc-500">
            {log.finished
              ? 'The run has finished.'
              : log.error
                ? 'The live log is reachable over the WebSocket.'
                : 'Waiting for the first output …'}
          </p>
        ) : (
          visible.map(({ key, row }) => {
            if (row.kind === 'status') {
              return (
                <p key={key} className="text-zinc-500">
                  {'— ' + (row.detail ? row.label + ' · ' + row.detail : row.label)}
                </p>
              );
            }
            if (row.kind === 'error') {
              return (
                <p key={key} className="whitespace-pre-wrap text-red-400">
                  {row.message}
                </p>
              );
            }
            const block = folded.blocks[row.index];
            if (!block) return null;
            if (block.type === 'thinking') return <ThinkingRow key={key} text={block.text} />;
            if (block.type === 'text')
              return (
                <p key={key} className="whitespace-pre-wrap text-zinc-100">
                  {block.text}
                </p>
              );
            return <TerminalToolRow key={key} event={block.call} />;
          })
        )}
      </div>

      {!following ? (
        <button
          type="button"
          className="absolute end-3 bottom-2 rounded bg-zinc-800/90 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
          onClick={() => setFollowing(true)}
        >
          ↓ follow output
        </button>
      ) : null}
    </div>
  );
}

/** Dimmed and quiet: reasoning is context, not the answer. */
function ThinkingRow({ text }: { text: string }) {
  return <p className="whitespace-pre-wrap text-zinc-500 italic">{text}</p>;
}

/**
 * One tool call, printed. The line carries name and argument; clicking it
 * unfolds the request and what came back, indented, in the same monospace
 * block - the information the chat widget used to hold, without the card.
 */
function TerminalToolRow({ event }: { event: Extract<AgentEvent, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const name = prettyToolName(event.name);
  const request = formatToolValue(event.detail);
  const result = formatToolValue(event.result);
  const failed = event.isError === true;
  const running = event.status === 'start';
  const marker = failed ? '✗' : running ? '·' : '✓';

  return (
    <div>
      <button
        type="button"
        className={cn(
          'flex w-full items-baseline gap-1.5 text-left hover:text-zinc-100',
          failed ? 'text-red-400' : 'text-sky-300',
        )}
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span className="shrink-0 text-zinc-500">{marker}</span>
        <span className="shrink-0">{name}</span>
        {event.detail ? (
          <span className="min-w-0 flex-1 truncate text-zinc-400">{event.detail}</span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="shrink-0 text-zinc-600">{open ? '−' : '+'}</span>
      </button>

      {open ? (
        <div className="mt-0.5 border-s border-zinc-800 ps-3 text-zinc-400">
          {/* The line above already carries the argument; repeating it here
              only helps when the line had to shorten it. */}
          {request && request !== event.detail ? (
            <p className="whitespace-pre-wrap">{request}</p>
          ) : null}
          {result ? (
            <p className={cn('whitespace-pre-wrap', failed ? 'text-red-400' : 'text-zinc-300')}>{result}</p>
          ) : running ? (
            <p className="text-zinc-500">running …</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
