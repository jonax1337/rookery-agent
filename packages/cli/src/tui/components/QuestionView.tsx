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
import { GUTTER, glyph, ui } from '../theme.js';
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

/**
 * The option's index is its identity: an answer is indices into the list as it
 * was offered, so nothing depends on labels being unique.
 */
function toOptions(offered: OpenQuestion['options']): Array<{ value: string; label: string }> {
  return offered.map((option, index) => ({
    value: String(index),
    label: shorten(
      option.description ? option.label + '  ' + glyph.dot + ' ' + option.description : option.label,
      MAX_OPTION,
    ),
  }));
}

export function QuestionView({ question, now, onAnswer }: QuestionViewProps): React.JSX.Element {
  const options = toOptions(question.options);

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
        <Text color={ui.accent} bold>
          {glyph.prompt + ' ' + question.header}
        </Text>
        <Text color={ui.faint}>{'  ' + timeLeft(question.expiresAt - now)}</Text>
      </Box>

      <Box paddingLeft={GUTTER} flexDirection="column">
        <Text color={ui.frost}>{question.question}</Text>

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
          {keyHint(question.multiSelect)}
        </Text>
      </Box>
    </Box>
  );
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

/** "9m left" / "40s left" - how long the turn will keep waiting. */
function timeLeft(ms: number): string {
  if (ms <= 0) return 'expiring';
  if (ms < MS_PER_MINUTE) return Math.ceil(ms / MS_PER_SECOND) + 's left';
  return Math.ceil(ms / MS_PER_MINUTE) + 'm left';
}

function keyHint(multiSelect: boolean): string {
  const picks = multiSelect ? ' Space picks ' + glyph.dot : '';
  return glyph.up + glyph.down + ' move ' + glyph.dot + picks + ' Enter answers ' + glyph.dot + ' Esc skips';
}
