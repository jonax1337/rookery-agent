import * as React from 'react';
import { NavLink } from 'react-router';

import {
  BotIcon,
  ExternalLinkIcon,
  LayoutGridIcon,
  MessageSquareIcon,
  PlusIcon,
  TerminalIcon,
  XIcon,
} from '@/components/icons';
import { useConfirm } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/common/empty-state';
import { RunTerminal } from '@/components/common/run-terminal';
import { usePageMeta } from '@/components/shell/page-meta';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { api } from '@/lib/api';
import { reportFailure } from '@/lib/errors';
import type { TerminalView } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useChatSession, useConnection } from '@/providers/rookery-provider';

/**
 * Every open Claude Code terminal in one place - conversations switched to
 * the terminal, and agents working in theirs - as tabs, or side by side.
 *
 * The list comes from the server (`GET /api/terminals`) and follows it: a
 * terminal opening, finishing or going away arrives as a `changed` broadcast.
 * Every terminal stays mounted while its tab is hidden, so switching tabs is
 * instant and nothing has to replay; a new one opens as a conversation of
 * its own, on whatever provider and model the chat composer has picked.
 */

type Layout = 'tabs' | 'grid';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private window or blocked storage: the choice is simply not remembered.
  }
}

export function WorkspacePage() {
  const { socket } = useConnection();
  const { turn } = useChatSession();
  const { confirm, dialog } = useConfirm();
  const [terminals, setTerminals] = React.useState<TerminalView[] | null>(null);
  const [active, setActive] = React.useState<string | null>(() => readStored('rookery.workspace.active'));
  const [layout, setLayout] = React.useState<Layout>(() =>
    readStored('rookery.workspace.layout') === 'grid' ? 'grid' : 'tabs',
  );
  const [opening, setOpening] = React.useState(false);
  /** The terminal the keyboard should go to: the one just picked or opened. */
  const [focusKey, setFocusKey] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setTerminals(await api.terminals());
    } catch (caught) {
      reportFailure('Load terminals', caught);
      setTerminals((current) => current ?? []);
    }
  }, []);

  React.useEffect(() => {
    void load();
    return socket.onChanged((change) => {
      // A conversation's title arrives after its first answer, as a session change.
      if (change.kind === 'terminals' || change.kind === 'session') void load();
    });
  }, [load, socket]);

  // The remembered tab, if it is still open; the first one otherwise.
  const current = terminals?.find((entry) => entry.key === active) ?? terminals?.[0] ?? null;

  const select = (key: string): void => {
    setActive(key);
    setFocusKey(key);
    writeStored('rookery.workspace.active', key);
  };

  const openNew = React.useCallback(async () => {
    setOpening(true);
    try {
      const opened = await socket.openTui({
        // Before the composer has loaded, its values are placeholders; the
        // server's saved defaults are the right answer then.
        ...(turn.ready
          ? {
              provider: turn.provider,
              ...(turn.model ? { model: turn.model } : {}),
              ...(turn.effort ? { effort: turn.effort } : {}),
              permission: turn.permission,
            }
          : {}),
        ...(turn.projectId ? { projectId: turn.projectId } : {}),
      });
      setActive(opened.key);
      setFocusKey(opened.key);
      writeStored('rookery.workspace.active', opened.key);
      await load();
    } catch (caught) {
      reportFailure('Open terminal', caught);
    } finally {
      setOpening(false);
    }
  }, [load, socket, turn.effort, turn.model, turn.permission, turn.projectId, turn.provider, turn.ready]);

  const close = React.useCallback(
    async (terminal: TerminalView) => {
      if (terminal.kind === 'run' && terminal.state === 'running') {
        const ok = await confirm({
          title: 'Stop the agent and close its terminal?',
          description: terminal.subtitle + ' is still working. Closing ends the process, and the run fails.',
          confirmLabel: 'Close terminal',
          destructive: true,
        });
        if (!ok) return;
      }
      // A conversation keeps everything said in it; a run keeps its transcript.
      socket.killTui(terminal.key);
    },
    [confirm, socket],
  );

  usePageMeta(
    {
      breadcrumb: [{ label: 'Workspace' }],
      actions: (
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={layout}
            onValueChange={(value) => {
              if (value !== 'tabs' && value !== 'grid') return;
              setLayout(value);
              writeStored('rookery.workspace.layout', value);
            }}
            aria-label="Layout"
          >
            <ToggleGroupItem
              value="tabs"
              aria-label="Tabs"
              className="data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              <TerminalIcon />
              Tabs
            </ToggleGroupItem>
            <ToggleGroupItem
              value="grid"
              aria-label="Side by side"
              className="data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              <LayoutGridIcon />
              Grid
            </ToggleGroupItem>
          </ToggleGroup>
          <Button type="button" size="sm" disabled={opening} onClick={() => void openNew()}>
            {opening ? <Spinner /> : <PlusIcon />}
            {opening ? 'Opening…' : 'New terminal'}
          </Button>
        </div>
      ),
    },
    [layout, opening, openNew],
  );

  if (terminals === null) return <div className="flex-1" />;

  if (terminals.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={TerminalIcon}
          title="No open terminals"
          description="Open a conversation in Claude Code's own terminal. Agents working in theirs show up here by themselves."
          actionLabel="New terminal"
          onAction={() => void openNew()}
        />
        {dialog}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      {layout === 'tabs' ? (
        <div role="tablist" aria-label="Open terminals" className="flex shrink-0 gap-1 overflow-x-auto border-b">
          {terminals.map((terminal) => (
            <TerminalTab
              key={terminal.key}
              terminal={terminal}
              selected={terminal.key === current?.key}
              onSelect={() => select(terminal.key)}
              onClose={() => void close(terminal)}
            />
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          'min-h-0 flex-1',
          layout === 'grid'
            ? cn('grid auto-rows-[minmax(420px,1fr)] gap-3 overflow-y-auto', terminals.length > 1 && 'lg:grid-cols-2')
            : 'flex flex-col',
        )}
      >
        {terminals.map((terminal) => {
          const visible = layout === 'grid' || terminal.key === current?.key;
          return (
            <div
              key={terminal.key}
              className={cn('flex min-h-0 flex-col gap-2', layout === 'tabs' && 'flex-1', !visible && 'hidden')}
            >
              {layout === 'grid' ? (
                <TerminalHeader terminal={terminal} onClose={() => void close(terminal)} />
              ) : null}
              <RunTerminal
                assignmentId={terminal.key}
                showHeader={false}
                autoFocus={layout === 'tabs' ? terminal.key === current?.key : terminal.key === focusKey}
                className="min-h-0 flex-1"
                fallback={<p className="m-auto text-sm text-muted-foreground">This terminal has closed.</p>}
              />
            </div>
          );
        })}
      </div>
      {dialog}
    </div>
  );
}

/**
 * Working, or not: a conversation terminal that answered is waiting for its
 * person, a run that answered is done and only lingering.
 */
function StateDot({ state, kind }: { state: TerminalView['state']; kind: TerminalView['kind'] }) {
  const label = state === 'running' ? 'Working' : kind === 'chat' ? 'Waiting for you' : 'Done';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'size-2 shrink-0 rounded-full',
        state === 'running' ? 'animate-pulse bg-primary' : 'bg-muted-foreground/50',
      )}
    />
  );
}

function KindIcon({ kind }: { kind: TerminalView['kind'] }) {
  return kind === 'chat' ? (
    <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
  ) : (
    <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
  );
}

interface TerminalTabProps {
  terminal: TerminalView;
  selected: boolean;
  onSelect(): void;
  onClose(): void;
}

function TerminalTab({ terminal, selected, onSelect, onClose }: TerminalTabProps) {
  return (
    <div
      className={cn(
        '-mb-px flex max-w-64 shrink-0 items-center gap-2 rounded-t-md border border-b-0 px-3 py-1.5 text-sm',
        selected ? 'bg-background text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        className="flex min-w-0 items-center gap-2 text-left outline-none"
      >
        <StateDot state={terminal.state} kind={terminal.kind} />
        <KindIcon kind={terminal.kind} />
        <span className="min-w-0 truncate">{terminal.title}</span>
        {terminal.subtitle ? <span className="shrink-0 text-xs text-muted-foreground">{terminal.subtitle}</span> : null}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={'Close ' + terminal.title}
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function TerminalHeader({ terminal, onClose }: { terminal: TerminalView; onClose(): void }) {
  const link = terminal.kind === 'chat' ? '/c/' + terminal.id : '/assignments/' + terminal.id;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <StateDot state={terminal.state} kind={terminal.kind} />
      <KindIcon kind={terminal.kind} />
      <span className="min-w-0 truncate font-medium">{terminal.title}</span>
      {terminal.subtitle ? <span className="shrink-0 text-xs text-muted-foreground">{terminal.subtitle}</span> : null}
      <Button asChild variant="ghost" size="icon-sm" className="ml-auto shrink-0">
        <NavLink to={link} aria-label={'Open ' + terminal.title}>
          <ExternalLinkIcon />
        </NavLink>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onClose}
        aria-label={'Close ' + terminal.title}
      >
        <XIcon />
      </Button>
    </div>
  );
}
