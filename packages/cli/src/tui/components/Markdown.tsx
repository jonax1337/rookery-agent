/**
 * A deliberately small markdown renderer for the terminal.
 *
 * Scope is exactly what an assistant reply actually uses: headings, ordered
 * and unordered lists, task lists, block quotes, pipe tables, rules, fenced
 * code and the common inline marks. Anything it does not understand is printed
 * verbatim, which is the right failure mode for a chat transcript - a heavy
 * markdown/AST dependency would cost more than it buys and would still print
 * unknown syntax as text.
 *
 * Two rules give the output its shape:
 *  - Markup is *replaced*, never echoed. A heading is set in the heading
 *    style; it does not keep its hashes. That is the whole difference between
 *    reading rendered text and reading source.
 *  - Every block that holds prose sets it inside a `flexGrow` box with
 *    `wrap="wrap"`, so a long line is broken by the layout instead of running
 *    off the right edge.
 *
 * The parser is also stream-tolerant: an unterminated fence still renders as a
 * code block so a half-arrived reply does not flicker between shapes.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyph, ui } from '../theme.js';
import { CodeBlock } from './CodeBlock.js';

/* ------------------------------- blocks ------------------------------- */

/** One item of a list, with its nesting depth and optional checkbox state. */
export interface ListItem {
  marker: string;
  text: string;
  indent: number;
  /** Set only for `- [ ]` / `- [x]` items. */
  checked?: boolean;
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'code'; code: string; language?: string }
  | { type: 'quote'; text: string }
  | { type: 'list'; items: ListItem[] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' };

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/u;
const TASK_MARK = /^\[([ xX])\]\s+(.*)$/u;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/u;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u;

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

    // A table is a pipe row whose *next* line is the `|---|` divider. Testing
    // the divider is what keeps a lone pipe-heavy sentence out of a table.
    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[index + 1] ?? '')) {
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      blocks.push({ type: 'table', header, rows });
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
      const items: ListItem[] = [];
      while (index < lines.length) {
        const raw = lines[index] ?? '';
        const match = LIST_ITEM.exec(raw);
        if (match) {
          items.push(listItem(match));
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
        LIST_ITEM.test(raw) ||
        (TABLE_ROW.test(raw) && TABLE_DIVIDER.test(lines[index + 1] ?? ''))
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

/** Build one list item, pulling a `[ ]` / `[x]` checkbox out of its text. */
function listItem(match: RegExpExecArray): ListItem {
  const indent = Math.floor((match[1] ?? '').length / 2);
  const bullet = match[2] ? glyph.bullet : (match[3] ?? '1') + '.';
  const body = match[4] ?? '';

  const task = TASK_MARK.exec(body);
  if (task) {
    return {
      indent,
      marker: bullet,
      text: task[2] ?? '',
      checked: (task[1] ?? ' ').toLowerCase() === 'x',
    };
  }
  return { indent, marker: bullet, text: body };
}

/** Cells of one pipe-table row, without the outer pipes. */
function splitRow(line: string): string[] {
  const inner = TABLE_ROW.exec(line)?.[1] ?? line;
  return inner.split('|').map((cell) => cell.trim());
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

/** Inline markdown, wrapped to whatever width the box it sits in offers. */
function Inline({
  text,
  color,
  bold,
  dim,
}: {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}): React.JSX.Element {
  const spans = parseInline(text);
  const base = color ?? ui.ivory;
  return (
    <Text color={base} bold={bold} dimColor={dim} wrap="wrap">
      {spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold || bold}
          italic={span.italic}
          strikethrough={span.strike}
          underline={span.link}
          color={span.code ? ui.amberSoft : span.link ? ui.info : base}
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
              <HeadingBlock
                key={index}
                level={block.level}
                text={block.text}
                gap={gap}
                tail={tail}
              />
            );

          case 'rule':
            return (
              <Box
                key={index}
                marginTop={gap}
                borderStyle="single"
                borderColor={ui.faint}
                borderDimColor
                borderBottom={false}
                borderLeft={false}
                borderRight={false}
              />
            );

          case 'code':
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                <CodeBlock
                  code={block.code}
                  {...(block.language ? { language: block.language } : {})}
                />
                {tail}
              </Box>
            );

          case 'quote':
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                {block.text.split('\n').map((line, lineIndex, all) => (
                  <Box key={lineIndex} flexDirection="row">
                    <Text color={ui.amber} dimColor>
                      {glyph.bar + ' '}
                    </Text>
                    <Box flexGrow={1}>
                      <Inline text={line} color={ui.muted} />
                    </Box>
                    {lineIndex === all.length - 1 ? tail : null}
                  </Box>
                ))}
              </Box>
            );

          case 'list':
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                {block.items.map((item, itemIndex) => (
                  <ListRow key={itemIndex} item={item} />
                ))}
                {tail}
              </Box>
            );

          case 'table':
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                <TableBlock header={block.header} rows={block.rows} />
                {tail}
              </Box>
            );

          case 'paragraph':
          default:
            return (
              <Box key={index} flexDirection="column" marginTop={gap}>
                {block.text.split('\n').map((line, lineIndex, all) => (
                  <Box key={lineIndex} flexDirection="row">
                    <Box flexGrow={1}>
                      <Inline text={line} />
                    </Box>
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

/**
 * A heading, set rather than echoed.
 *
 * Level 1 is the loudest thing a reply can say, so it is set in caps with a
 * rule under it; level 2 is brand amber; level 3 and deeper stay in body
 * colour and lean on weight alone. No level prints its hashes.
 *
 * Caps carry the emphasis on their own - letterspacing them as well pulls the
 * words apart faster than it makes them look set, especially in German, where
 * the headings are long.
 */
function HeadingBlock({
  level,
  text,
  gap,
  tail,
}: {
  level: number;
  text: string;
  gap: number;
  tail: React.ReactNode;
}): React.JSX.Element {
  if (level <= 1) {
    return (
      <Box flexDirection="column" marginTop={gap}>
        <Box flexDirection="row">
          <Box flexGrow={1}>
            <Inline text={text.toUpperCase()} color={ui.amber} bold />
          </Box>
          {tail}
        </Box>
        <Box
          borderStyle="single"
          borderColor={ui.faint}
          borderDimColor
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="row" marginTop={gap}>
      <Box flexGrow={1}>
        <Inline text={text} color={level === 2 ? ui.amber : ui.ivory} bold />
      </Box>
      {tail}
    </Box>
  );
}

/** One list row: marker in the gutter, wrapped body next to it. */
function ListRow({ item }: { item: ListItem }): React.JSX.Element {
  const marker =
    item.checked === undefined ? item.marker : item.checked ? glyph.boxOn : glyph.boxOff;
  const color = item.checked ? ui.ok : item.checked === false ? ui.muted : ui.amber;

  return (
    <Box flexDirection="row" paddingLeft={item.indent * 2}>
      <Text color={color}>{marker + ' '}</Text>
      <Box flexGrow={1}>
        <Inline text={item.text} {...(item.checked ? { dim: true } : {})} />
      </Box>
    </Box>
  );
}

/**
 * A pipe table.
 *
 * Columns are sized from their content and capped, because a model that
 * returns one 300-character cell must not be allowed to push the other columns
 * off the screen. Cells past the cap are cut with an ellipsis rather than
 * wrapped: a table whose rows are different heights stops being a table.
 */
function TableBlock({ header, rows }: { header: string[]; rows: string[][] }): React.JSX.Element {
  const count = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const widths: number[] = [];

  for (let column = 0; column < count; column += 1) {
    const cells = [header[column] ?? '', ...rows.map((row) => row[column] ?? '')];
    const longest = Math.max(...cells.map((cell) => plain(cell).length), 1);
    widths.push(Math.min(longest, 40));
  }

  const row = (cells: string[], color: string, bold: boolean): React.JSX.Element => (
    <Box flexDirection="row">
      {widths.map((width, column) => (
        <Box key={column} marginRight={column === widths.length - 1 ? 0 : 2}>
          <Text color={color} bold={bold}>
            {pad(cells[column] ?? '', width)}
          </Text>
        </Box>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {row(header, ui.amber, true)}
      <Box flexDirection="row">
        {widths.map((width, column) => (
          <Box key={column} marginRight={column === widths.length - 1 ? 0 : 2}>
            <Text color={ui.faint}>{glyph.rule.repeat(width)}</Text>
          </Box>
        ))}
      </Box>
      {rows.map((cells, rowIndex) => (
        <React.Fragment key={rowIndex}>{row(cells, ui.ivory, false)}</React.Fragment>
      ))}
    </Box>
  );
}

/** Table cells are measured and cut on their visible text, not their markup. */
function plain(cell: string): string {
  return parseInline(cell)
    .map((span) => span.text)
    .join('');
}

function pad(cell: string, width: number): string {
  const text = plain(cell);
  if (text.length <= width) return text.padEnd(width);
  return text.slice(0, Math.max(0, width - 1)) + '…';
}
