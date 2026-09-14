/**
 * The slash-command catalogue and the palette's selection state.
 *
 * The palette only opens while the caret is still inside the command word of
 * a line that starts with `/`. Once the user types a space they are writing
 * arguments, and a list of commands on top of that would be in the way.
 */

import { useEffect, useMemo, useState } from 'react';

export interface SlashCommand {
  name: string;
  /** Argument sketch shown after the name, e.g. `<id>`. */
  args?: string;
  description: string;
}

/** Every command the TUI accepts, in the order the palette lists them. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/help', description: 'Organization commands and roles' },
  { name: '/new', description: 'start a new conversation' },
  { name: '/sessions', description: 'recent conversations' },
  { name: '/switch', args: '<id>', description: 'resume a previous conversation' },
  { name: '/talk', args: '<slug>', description: 'talk to an agent; `assistant` switches back' },
  { name: '/provider', args: '<id>', description: 'claude, codex or a configured profile id' },
  { name: '/permission', args: '<level>', description: 'chat | read | write | full' },
  { name: '/model', args: '[name]', description: 'set model (empty = provider default)' },
  { name: '/effort', args: '[level]', description: 'low | medium | high | xhigh | max | off' },
  { name: '/usage', description: 'current provider usage' },
  { name: '/org', description: 'who works here and what is running' },
  { name: '/agents', description: 'organization agents' },
  { name: '/assign', args: '<agent> <task>', description: 'give an agent an assignment' },
  // `/task` sits before `/tasks` so typing the shorter name completes to it:
  // the palette filters by prefix and Tab takes the first match.
  { name: '/task', args: '<title>', description: 'add a task to the board' },
  { name: '/tasks', args: '[status]', description: 'organization task board' },
  { name: '/project', args: '<name|off>', description: 'set the project for this conversation' },
  { name: '/inbox', description: 'unread messages from agents' },
  { name: '/memory', args: '<query>', description: 'search long-term memory' },
  { name: '/remember', args: '<text>', description: 'store a memory manually' },
  { name: '/forget', args: '<id>', description: 'forget a memory' },
  { name: '/voice', description: 'toggle spoken replies' },
  { name: '/doctor', description: 'provider status' },
  { name: '/verbose', description: 'toggle thinking traces' },
  { name: '/clear', description: 'clear the screen' },
  { name: '/exit', description: 'exit' },
] as const;

export interface SlashState {
  open: boolean;
  matches: SlashCommand[];
  selected: number;
  /** The `/word` the palette is filtering on. */
  query: string;
  move: (delta: number) => void;
  /** The command that Tab/Enter would complete to, if any. */
  active: SlashCommand | undefined;
}

/**
 * Derive palette state from the buffer and caret.
 * `value`/`cursor` are the single source of truth; the palette owns nothing
 * but which row is highlighted.
 */
export function useSlash(value: string, cursor: number): SlashState {
  const query = useMemo(() => commandWord(value, cursor), [value, cursor]);

  const matches = useMemo(() => {
    if (query === null) return [];
    const needle = query.slice(1).toLowerCase();
    return SLASH_COMMANDS.filter((command) => command.name.slice(1).startsWith(needle));
  }, [query]);

  const [selected, setSelected] = useState(0);

  // A changed filter must never leave the highlight pointing past the list.
  useEffect(() => {
    setSelected((current) => (current < matches.length ? current : 0));
  }, [matches.length]);

  const open = query !== null && matches.length > 0;
  const index = matches.length ? selected % matches.length : 0;

  return {
    open,
    matches,
    selected: index,
    query: query ?? '',
    active: open ? matches[index] : undefined,
    move: (delta: number) => {
      if (!matches.length) return;
      setSelected((current) => (current + delta + matches.length) % matches.length);
    },
  };
}

/**
 * The `/word` the caret is inside, or null when the palette should stay shut.
 * Returns null once the line has a space: at that point the user is typing
 * arguments, not picking a command.
 */
export function commandWord(value: string, cursor: number): string | null {
  if (!value.startsWith('/')) return null;
  // Multi-line drafts are prose, not commands.
  if (value.includes('\n')) return null;
  if (/\s/u.test(value)) return null;
  if (cursor < 1 || cursor > value.length) return null;
  return value;
}
