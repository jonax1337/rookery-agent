import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { AssignmentTerminal } from '@/components/common/assignment-terminal';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useConnection } from '@/providers/rookery-provider';
import type { AssignmentStatus, TuiSessionInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * A run's window: the real Claude Code terminal while its process lives,
 * the transcript once it is gone.
 *
 * Agents work in Claude Code's own TUI inside a pseudo terminal on the
 * server (core `providers/claude-tui.ts`). This paints that terminal with
 * xterm.js from the bytes the server relays, and sends keystrokes back - a
 * person can answer a question, interrupt with Esc, or ask a follow-up once
 * the work is done, exactly as at the console. When the agent finishes, the
 * terminal stays open for a while (`idle`); closing it, or the time running
 * out, kills the process, and what is left is the transcript the journal
 * kept all along - the same `AssignmentTerminal` a headless run always had.
 */

const THEME = {
  background: '#0c1311',
  foreground: '#d8e4df',
  cursor: '#d8e4df',
  selectionBackground: '#2b4a40',
};

export interface RunTerminalProps {
  /** The terminal's key: a run's assignment id, or a conversation's `chat:<id>`. */
  assignmentId: string;
  status?: AssignmentStatus;
  /**
   * What stands in for the terminal once there is none. A run falls back to
   * its transcript; a conversation brings its own.
   */
  fallback?: ReactNode;
  /** The Working/Done bar with the close button - a run's, not a conversation's. */
  showHeader?: boolean;
  /** Called with the terminal's state whenever it changes; `null` once it is gone. */
  onInfo?: (info: TuiSessionInfo | null) => void;
  /**
   * Put the keyboard in the terminal as soon as it is there - and again
   * whenever this turns true, e.g. when its tab is picked.
   */
  autoFocus?: boolean;
  className?: string;
}

const ESC = String.fromCharCode(27);

/** Whether output carries anything a person can see, not only control sequences. */
function hasVisibleText(data: string): boolean {
  return /[^\s]/.test(
    data
      .split(ESC)
      .join('')
      .replace(/\][^\x07]*\x07/g, '')
      .replace(/\[[0-9;?>]*[ -/]*[@-~]/g, ''),
  );
}

export function RunTerminal({
  assignmentId,
  status,
  fallback,
  showHeader = true,
  onInfo,
  autoFocus = false,
  className,
}: RunTerminalProps) {
  const { socket } = useConnection();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { confirm, dialog } = useConfirm();
  // `undefined` while the server has not answered yet, `null` when the run
  // has no open terminal - headless, or already killed.
  const [info, setInfo] = useState<TuiSessionInfo | null | undefined>(undefined);
  // Claude Code needs a second or two before it paints anything; until then
  // the box says it is starting instead of standing there black.
  const [painted, setPainted] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Another run on the same page: ask again instead of trusting the last answer.
    setInfo(undefined);
    setPainted(false);
    let seen = false;
    const note = (data: string): void => {
      if (seen || !hasVisibleText(data)) return;
      seen = true;
      setPainted(true);
    };
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const input = term.onData((data) => socket.sendTuiInput(assignmentId, data));
    const off = socket.onTui((frame) => {
      if (frame.assignmentId !== assignmentId) return;
      if (frame.type === 'tui-snapshot') {
        // A snapshot is the whole screen history: start from a clean slate,
        // or a reconnect would paint it twice.
        term.reset();
        if (frame.data) {
          term.write(frame.data);
          note(frame.data);
        }
        setInfo(frame.info);
      } else if (frame.type === 'tui-data') {
        term.write(frame.data);
        note(frame.data);
      } else {
        setInfo(frame.info.state === 'exited' ? null : frame.info);
      }
    });
    socket.watchTui(assignmentId);

    return () => {
      off();
      input.dispose();
      socket.unwatchTui(assignmentId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [socket, assignmentId]);

  const live = info != null;

  // Read through a ref: a new callback identity every render must not
  // re-run the effect that reports.
  const onInfoRef = useRef(onInfo);
  onInfoRef.current = onInfo;
  useEffect(() => {
    if (info !== undefined) onInfoRef.current?.(info);
  }, [info]);

  // The terminal follows its box; the process on the server follows the
  // terminal, so the TUI lays itself out for what is actually visible.
  useEffect(() => {
    if (!live) return;
    const host = hostRef.current;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!host || !fit || !term) return;
    const apply = (): void => {
      try {
        fit.fit();
        socket.resizeTui(assignmentId, term.cols, term.rows);
      } catch {
        // Not laid out yet; the observer comes back.
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(host);
    // xterm measures its character cell once, and a first measurement taken
    // before the monospace web font arrived left the process at half the
    // width it had. Measure again once the fonts are in, and once the TUI
    // starts drawing - resetting the font family makes xterm re-measure.
    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (disposed) return;
      term.options.fontFamily = term.options.fontFamily;
      apply();
    });
    const settle = setTimeout(apply, 400);
    return () => {
      disposed = true;
      clearTimeout(settle);
      observer.disconnect();
    };
  }, [live, painted, socket, assignmentId]);

  useEffect(() => {
    if (autoFocus && live) termRef.current?.focus();
  }, [autoFocus, live, painted]);

  const close = async (): Promise<void> => {
    if (info?.state === 'running') {
      const ok = await confirm({
        title: 'Stop the agent and close its terminal?',
        description: 'The agent is still working. Closing ends the process, and the run fails.',
        confirmLabel: 'Close terminal',
        destructive: true,
      });
      if (!ok) return;
    }
    socket.killTui(assignmentId);
  };

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {live && showHeader ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={info.state === 'running' ? 'default' : 'secondary'}>
            {info.state === 'running' ? 'Working' : 'Done'}
          </Badge>
          <span className="min-w-0 truncate">
            {info.state === 'running'
              ? 'Live Claude Code terminal - you can type into it.'
              : 'The work is done. The terminal stays open for a while, then only the transcript remains.'}
          </span>
          <Button type="button" variant="outline" size="sm" className="ml-auto shrink-0" onClick={() => void close()}>
            Close terminal
          </Button>
        </div>
      ) : null}
      {/* Mounted from the start so no output is lost while the server answers;
          hidden until there is a terminal to show. */}
      <div
        className={cn(
          'relative min-h-[320px] overflow-hidden rounded-lg border',
          showHeader ? 'h-[560px]' : 'flex-1',
          !live && 'hidden',
        )}
        style={{ background: THEME.background }}
      >
        <div ref={hostRef} className="absolute inset-0 p-2" />
        {live && !painted ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Starting Claude Code…
          </div>
        ) : null}
      </div>
      {info === null
        ? (fallback ?? <AssignmentTerminal assignmentId={assignmentId} {...(status ? { status } : {})} />)
        : null}
      {dialog}
    </div>
  );
}
