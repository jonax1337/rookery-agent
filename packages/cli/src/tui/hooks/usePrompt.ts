/**
 * The prompt: the draft being typed, the caret in it, the slash palette
 * above it and the history behind it, plus the keystrokes that edit it.
 *
 * The App decides what Enter *sends*; everything about how the text itself
 * changes lives here.
 */

import { useCallback, useState } from 'react';
import type { Key } from 'ink';
import { NEWER, OLDER, useHistory } from './useHistory.js';
import { useSlash } from './useSlash.js';
import type { SlashState } from './useSlash.js';

export interface PromptApi {
  draft: string;
  cursor: number;
  slash: SlashState;
  /** The palette is showing: the draft is a command word and Esc has not closed it. */
  paletteOpen: boolean;
  /** Record the draft in the history and empty the box. */
  commit: () => void;
  /**
   * Enter inserts a newline or completes a command where that is what the
   * user means; otherwise the draft is ready to be sent.
   */
  pressEnter: (key: Key) => 'submit' | 'handled';
  /** Any other key: caret movement, deletion, typing, history, the palette. */
  edit: (input: string, key: Key) => void;
}

export function usePrompt(): PromptApi {
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const history = useHistory();
  const slash = useSlash(draft, cursor);
  const paletteOpen = slash.open && !dismissed;

  const setBuffer = useCallback((value: string, caret: number) => {
    setDraft(value);
    setCursor(Math.max(0, Math.min(caret, value.length)));
    setDismissed(false);
  }, []);

  /** A change by the user: whatever history walk was under way is over. */
  const editBuffer = (value: string, caret: number): void => {
    setBuffer(value, caret);
    history.reset();
  };

  const commit = (): void => {
    history.push(draft);
    setBuffer('', 0);
  };

  const complete = (): void => {
    const command = slash.active;
    if (!command) return;
    // Commands that take arguments get a trailing space so typing continues.
    const value = command.name + (command.args ? ' ' : '');
    setBuffer(value, value.length);
  };

  const insertNewline = (): void => {
    setBuffer(draft.slice(0, cursor) + '\n' + draft.slice(cursor), cursor + 1);
  };

  const pressEnter = (key: Key): 'submit' | 'handled' => {
    // Shift+Enter / Alt+Enter, where the terminal reports them, insert a
    // newline. A trailing backslash is the portable equivalent for the
    // many terminals that send a bare CR for both.
    if (key.shift || key.meta) {
      insertNewline();
      return 'handled';
    }
    if (draft.slice(0, cursor).endsWith('\\')) {
      setBuffer(draft.slice(0, cursor - 1) + '\n' + draft.slice(cursor), cursor);
      return 'handled';
    }
    if (paletteOpen && slash.active && slash.active.name !== draft.trim()) {
      complete();
      return 'handled';
    }
    return 'submit';
  };

  const walkHistory = (direction: typeof OLDER | typeof NEWER): void => {
    const line = history.walk(direction, draft);
    if (line === null) return;
    setDraft(line);
    setCursor(line.length);
  };

  const moveCaret = (input: string, key: Key): boolean => {
    const byWord = key.ctrl || key.meta;
    if (key.leftArrow) {
      setCursor((at) => Math.max(0, at - (byWord ? wordLeft(draft, at) : 1)));
      return true;
    }
    if (key.rightArrow) {
      setCursor((at) => Math.min(draft.length, at + (byWord ? wordRight(draft, at) : 1)));
      return true;
    }
    if (key.home || (key.ctrl && input === 'a')) {
      setCursor(0);
      return true;
    }
    if (key.end || (key.ctrl && input === 'e')) {
      setCursor(draft.length);
      return true;
    }
    return false;
  };

  const deleteText = (input: string, key: Key): boolean => {
    // Ctrl+W and Alt+Backspace both delete the word to the left.
    if ((key.ctrl && input === 'w') || ((key.meta || key.ctrl) && (key.backspace || key.delete))) {
      const span = wordLeft(draft, cursor);
      if (span) editBuffer(draft.slice(0, cursor - span) + draft.slice(cursor), cursor - span);
      return true;
    }
    if (key.ctrl && input === 'u') {
      editBuffer(draft.slice(cursor), 0);
      return true;
    }
    if (key.ctrl && input === 'k') {
      editBuffer(draft.slice(0, cursor), cursor);
      return true;
    }
    if (key.backspace || input === '\x7F') {
      if (cursor) editBuffer(draft.slice(0, cursor - 1) + draft.slice(cursor), cursor - 1);
      return true;
    }
    if (key.delete) {
      if (cursor < draft.length) editBuffer(draft.slice(0, cursor) + draft.slice(cursor + 1), cursor);
      return true;
    }
    return false;
  };

  const edit = (input: string, key: Key): void => {
    if (key.escape) {
      setDismissed(true);
      return;
    }
    if (key.tab) {
      if (paletteOpen) complete();
      return;
    }
    // Ctrl+J is the other portable "newline without sending".
    if (input === '\n' || (key.ctrl && input === 'j')) {
      insertNewline();
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (paletteOpen) slash.move(key.upArrow ? -1 : 1);
      else walkHistory(key.upArrow ? OLDER : NEWER);
      return;
    }
    if (moveCaret(input, key) || deleteText(input, key)) return;

    // Everything else is literal text, including pasted multi-line blocks.
    if (input && !key.ctrl && !key.meta) {
      const text = input.replace(/\r/gu, '\n');
      editBuffer(draft.slice(0, cursor) + text + draft.slice(cursor), cursor + text.length);
    }
  };

  return { draft, cursor, slash, paletteOpen, commit, pressEnter, edit };
}

function isSpaceAt(value: string, index: number): boolean {
  return /\s/u.test(value[index] ?? '');
}

/** How many characters back the previous word boundary is. */
function wordLeft(value: string, cursor: number): number {
  let index = cursor;
  while (index > 0 && isSpaceAt(value, index - 1)) index -= 1;
  while (index > 0 && !isSpaceAt(value, index - 1)) index -= 1;
  return cursor - index;
}

/** How many characters forward the next word boundary is. */
function wordRight(value: string, cursor: number): number {
  let index = cursor;
  while (index < value.length && isSpaceAt(value, index)) index += 1;
  while (index < value.length && !isSpaceAt(value, index)) index += 1;
  return index - cursor;
}
