/**
 * A fenced code block: a faint left rule, a language tag and highlighted lines.
 *
 * The rule replaces the box the block used to be drawn in. A full border costs
 * two columns on every line and boxes the code in twice - once against the
 * prose, once against the terminal - while a single gutter separates code from
 * prose just as clearly and leaves the code the full width it was written for.
 *
 * Highlighting is the local, dependency-free one in `../highlight.ts`; an
 * unknown language simply renders verbatim.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, ui } from '../theme.js';
import { highlightLine, type TokenKind } from '../highlight.js';

export interface CodeBlockProps {
  code: string;
  /** Language written after the opening fence, if any. */
  language?: string;
}

/** Token kind -> colour. Comments recede, values come forward. */
const TOKEN_COLOR: Record<TokenKind, string> = {
  plain: ui.ivory,
  comment: ui.faint,
  string: ui.ok,
  number: ui.amberSoft,
  keyword: ui.info,
  punctuation: ui.muted,
};

export function CodeBlock({ code, language }: CodeBlockProps): React.JSX.Element {
  // Trailing blank lines inside a fence are noise, leading indentation is not.
  const lines = code.replace(/\s+$/u, '').split('\n');

  return (
    <Box flexDirection="column">
      {language ? (
        <Box flexDirection="row">
          <Text color={ui.faint}>{glyph.bar + ' '}</Text>
          <Text color={ui.info} dimColor>
            {language}
          </Text>
        </Box>
      ) : null}
      {lines.map((line, index) => (
        // Code lines have no stable identity beyond their position.
        <Box key={index} flexDirection="row">
          <Text color={ui.faint}>{glyph.bar + ' '}</Text>
          <Box flexGrow={1}>
            <Text wrap="wrap">
              {highlightLine(line, language).map((token, tokenIndex) => (
                <Text key={tokenIndex} color={TOKEN_COLOR[token.kind]}>
                  {token.text}
                </Text>
              ))}
              {line === '' ? ' ' : ''}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
