/**
 * A deliberately small markdown renderer for the terminal.
 *
 * Scope is exactly what an assistant reply actually uses: headings, ordered
 * and unordered lists, block quotes, rules, fenced code and the common inline
 * marks. Anything it does not understand is printed verbatim, which is the
 * right failure mode for a chat transcript - a heavy markdown/AST dependency
 * would cost more than it buys and would still print unknown syntax as text.
 *
 * The parser is also stream-tolerant: an unterminated fence still renders as a
 * code block so a half-arrived reply does not flicker between shapes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ui } from '../theme.js';
import { CodeBlock } from './CodeBlock.js';

/* ------------------------------- blocks ------------------------------- */

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; items: { marker: string; text: string; indent: number }[] }
  | { type: 'rule' };

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/u;

/** Split markdown source into the block shapes this renderer knows. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = (fence[2] ?? '```').slice(0, 3);
      const language = fence[3] ?? '';
      const body: string[] = [];
      index += 1;
      // An unterminated fence runs to the end: that is what a streaming
      // reply looks like a few hundred milliseconds before it closes.
      while (index < lines.length) {
        const current = lines[index] ?? '';
        if (current.trimStart().startsWith(marker)) {
          index += 1;
          break;
        }
        body.push(current);
        index += 1;
      }
      blocks.push(
        language
          ? { type: 'code', code: body.join('\n'), language }
          : { type: 'code', code: body.join('\n') },
      );
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: (heading[1] ?? '#').length,
        text: heading[2] ?? '',
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (!match) break;
        quoted.push(match[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', text: quoted.join('\n').trim() });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: { marker: string; text: string; indent: number }[] = [];
      while (index < lines.length) {
        const raw = lines[index] ?? '';
        const match = LIST_ITEM.exec(raw);
        if (match) {
          items.push({
            indent: Math.floor((match[1] ?? '').length / 2),
            marker: match[2] ? '•' : (match[3] ?? '1') + '.',
            text: match[4] ?? '',
          });
          index += 1;
          continue;
        }
        // A wrapped continuation line belongs to the item above it.
        const last = items[items.length - 1];
        if (last && raw.trim() && /^\s{2,}\S/u.test(raw)) {
          last.text += ' ' + raw.trim();
          index += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const raw = lines[index] ?? '';
      if (
        !raw.trim() ||
        FENCE.test(raw) ||
        HEADING.test(raw) ||
        RULE.test(raw) ||
        QUOTE.test(raw) ||
        LIST_ITEM.test(raw)
      ) {
        break;
      }
      paragraph.push(raw.trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }

  return blocks;
}

/* ------------------------------- inline ------------------------------- */

interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: boolean;
}

const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\n]+?)\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])|\[([^\]\n]+)\]\(([^)\s]+)\)/gu;

/** Split one line of markdown into styled spans. Never throws on odd syntax. */
export function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;

  INLINE.lastIndex = 0;
  let match = INLINE.exec(source);
  while (match) {
    if (match.index > cursor) spans.push({ text: source.slice(cursor, match.index) });

    if (match[2] !== undefined) spans.push({ text: match[2], code: true });
    else if (match[3] !== undefined) spans.push({ text: match[3], bold: true });
    else if (match[4] !== undefined) spans.push({ text: match[4], bold: true });
    else if (match[5] !== undefined) spans.push({ text: match[5], strike: true });
    else if (match[6] !== undefined) spans.push({ text: match[6], italic: true });
    else if (match[7] !== undefined) spans.push({ text: match[7], italic: true });
    else if (match[8] !== undefined) spans.push({ text: match[8], link: true });

    cursor = match.index + match[0].length;
    match = INLINE.exec(source);
  }

  if (cursor < source.length) spans.push({ text: source.slice(cursor) });
  return spans.length ? spans : [{ text: source }];
}

function Inline({ text, color }: { text: string; color?: string }): React.JSX.Element {
  const spans = parseInline(text);
  return (
    <Text color={color ?? ui.ivory} wrap="wrap">
      {spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold}
          italic={span.italic}
          strikethrough={span.strike}
          underline={span.link}
          color={span.code ? ui.info : span.link ? ui.info : color ?? ui.ivory}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

/* ------------------------------ component ----------------------------- */

export interface MarkdownProps {
  children: string;
  /** Appended to the very last line - used for the streaming cursor. */
  trailing?: React.ReactNode;
}

export function Markdown({ children, trailing }: MarkdownProps): React.JSX.Element {
  const blocks = parseBlocks(children);
  const lastIndex = blocks.length - 1;

  // Nothing has arrived yet: still show the cursor, so an empty reply reads
  // as "typing" rather than as a blank gap.
  if (!blocks.length) {
    return <Box>{trailing ?? <Text> </Text>}</Box>;
  }

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        const tail = index === lastIndex ? trailing : null;
        // Blocks are separated by a blank line, the way markdown reads on a
        // page. Only the first block hugs whatever is above it.
        const gap = index === 0 ? 0 : 1;

        switch (block.type) {
          case 'heading':
            return (
              <Box key={index} flexDirection="row" marginTop={gap}>
                <Text bold color={ui.amber}>
                  {'#'.repeat(block.level)} {block.text}
                </Text>
                {tail}
              </Box>
            );

          case 'rule':
            return (
              <Box key={index} marginTop={gap}>
                <Text dimColor color={ui.muted}>
                  ────────────────────────
                </Text>
              </Box>
            );

          case 'code':
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                <CodeBlock code={block.code} {...(block.language ? { language: block.language } : {})} />
                {tail}
              </Box>
            );

          case 'quote':
            return (
              <Box key={index} flexDirection="row" paddingLeft={1} marginTop={gap}>
                <Text color={ui.muted}>│ </Text>
                <Box flexGrow={1} flexDirection="column">
                  <Inline text={block.text} color={ui.muted} />
                </Box>
                {tail}
              </Box>
            );

          case 'list':
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                {block.items.map((item, itemIndex) => (
                  <Box key={itemIndex} flexDirection="row" paddingLeft={1 + item.indent * 2}>
                    <Text color={ui.amber}>{item.marker} </Text>
                    <Box flexGrow={1}>
                      <Inline text={item.text} />
                    </Box>
                  </Box>
                ))}
                {tail}
              </Box>
            );

          case 'paragraph':
          default:
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                {block.text.split('\n').map((line, lineIndex, all) => (
                  <Box key={lineIndex} flexDirection="row">
                    <Inline text={line} />
                    {lineIndex === all.length - 1 ? tail : null}
                  </Box>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
}
