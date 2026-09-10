/**
 * A fenced code block: dim rounded border, language label, verbatim lines.
 *
 * No syntax highlighting on purpose - a terminal-wide highlighter is a heavy
 * dependency and the border plus the language label already do the job of
 * separating code from prose.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ui } from '../theme.js';

export interface CodeBlockProps {
  code: string;
  /** Language written after the opening fence, if any. */
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps): React.JSX.Element {
  // Trailing blank lines inside a fence are noise, leading indentation is not.
  const lines = code.replace(/\s+$/u, '').split('\n');

  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1}>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={ui.muted}
        borderDimColor
        paddingX={1}
      >
        {language ? (
          <Text dimColor color={ui.info}>
            {language}
          </Text>
        ) : null}
        {lines.map((line, index) => (
          // Code lines have no stable identity beyond their position.
          <Text key={index} color={ui.ivory} wrap="wrap">
            {line === '' ? ' ' : line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
