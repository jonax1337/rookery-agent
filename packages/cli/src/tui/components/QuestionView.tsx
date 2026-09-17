/**
 * The question surface: what the terminal shows while a turn waits on a person.
 *
 * It takes the place of the input box, the way the watch view does, because a
 * blocked turn has nothing to say to anything typed at it - the only useful
 * keystroke is an answer or an Esc. The scrollback and the live region stay
 * on screen above it: the turn is still streaming, it is only waiting.
 *
 * `Select` and `MultiSelect` come from `@inkjs/ui` and read the keyboard
 * themselves (arrows, Space, Enter), so the app's own keymap steps aside
 * while this is mounted. A pure function of props like every other component
 * here, so `scripts/tui-render-check.mjs` can assert on real output.
 */

import React, { useCallback } from 'react';
import { Box, Text } from 'ink';
import { MultiSelect, Select } from '@inkjs/ui';
import { glyph, ui } from '../theme.js';
import { shorten } from '../../ui/render.js';
import type { OpenQuestion } from '../hooks/useTurn.js';

export interface QuestionViewProps {
  question: OpenQuestion;
  /**
   * The app's ticker clock, so the countdown is a function of props rather
   * than of the wall clock - which is what keeps the render check honest.
   */
  now: number;
  /** Chosen option indices, in the order the question offered them. */
  onAnswer: (selected: number[]) => void;
}

/** Cap on one option row, so a long description never wraps the list. */
const MAX_OPTION = 72;

/** How many rows the list shows before it scrolls. */
const VISIBLE_OPTIONS = 6;

export function QuestionView({ question, now, onAnswer }: QuestionViewProps): React.JSX.Element {
  // The option's index is its identity: an answer is indices into the list as
  // it was offered, so nothing depends on labels being unique.
  const options = question.options.map((option, index) => ({
    value: String(index),
    label: shorten(
      option.description ? option.label + '  ' + glyph.dot + ' ' + option.description : option.label,
      MAX_OPTION,
    ),
  }));

  const answerOne = useCallback(
    (value: string) => {
      onAnswer([Number(value)]);
    },
    [onAnswer],
  );

  const answerMany = useCallback(
    (values: string[]) => {
      // Enter on an empty selection is not an answer - Esc is how you decline -
      // so it leaves the question standing rather than sending nothing.
      if (!values.length) return;
      onAnswer(values.map(Number).sort((left, right) => left - right));
    },
    [onAnswer],
  );

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={ui.amber} bold>
          {glyph.prompt + ' ' + question.header}
        </Text>
        <Text color={ui.faint}>{'  ' + timeLeft(question.expiresAt - now)}</Text>
      </Box>

      <Box paddingLeft={2} flexDirection="column">
        <Text color={ui.ivory}>{question.question}</Text>

        <Box marginTop={1} flexDirection="column">
          {question.multiSelect ? (
            <MultiSelect
              options={options}
              visibleOptionCount={VISIBLE_OPTIONS}
              onSubmit={answerMany}
            />
          ) : (
            <Select options={options} visibleOptionCount={VISIBLE_OPTIONS} onChange={answerOne} />
          )}
        </Box>

        <Text color={ui.faint} dimColor>
          {glyph.up + glyph.down + ' move ' + glyph.dot +
            (question.multiSelect ? ' Space picks ' + glyph.dot : '') +
            ' Enter answers ' + glyph.dot + ' Esc skips'}
        </Text>
      </Box>
    </Box>
  );
}

/** "9m left" / "40s left" - how long the turn will keep waiting. */
export function timeLeft(ms: number): string {
  if (ms <= 0) return 'expiring';
  if (ms < 60_000) return Math.ceil(ms / 1000) + 's left';
  return Math.ceil(ms / 60_000) + 'm left';
}
