import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { AssignmentTerminal } from '@/components/common/assignment-terminal';
import { useConfirm } from '@/components/common/confirm-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
  assignmentId: string;
  status?: AssignmentStatus;
  className?: string;
}

export function RunTerminal({ assignmentId, status, className }: RunTerminalProps) {
  const { socket } = useConnection();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { confirm, dialog } = useConfirm();
  // `undefined` while the server has not answered yet, `null` when the run
  // has no open terminal - headless, or already killed.
  const [info, setInfo] = useState<TuiSessionInfo | null | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Another run on the same page: ask again instead of trusting the last answer.
    setInfo(undefined);
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
        if (frame.data) term.write(frame.data);
        setInfo(frame.info);
      } else if (frame.type === 'tui-data') {
        term.write(frame.data);
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
    return () => observer.disconnect();
  }, [live, socket, assignmentId]);

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
      {live ? (
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
        ref={hostRef}
        className={cn('h-[560px] overflow-hidden rounded-lg border p-2', !live && 'hidden')}
        style={{ background: THEME.background }}
      />
      {info === null ? (
        <AssignmentTerminal assignmentId={assignmentId} {...(status ? { status } : {})} />
      ) : null}
      {dialog}
    </div>
  );
}
