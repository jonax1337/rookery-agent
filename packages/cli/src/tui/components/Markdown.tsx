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

/** A block read from the source, and the index of the first line after it. */
interface Parsed {
  block: Block;
  next: number;
}

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+#.-]*)\s*$/u;
const HEADING = /^(#{1,6})\s+(.*)$/u;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
const QUOTE = /^\s*>\s?(.*)$/u;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/u;
const LIST_CONTINUATION = /^\s{2,}\S/u;
const TASK_MARK = /^\[([ xX])\]\s+(.*)$/u;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/u;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/u;

/** Source spaces that make one list nesting level. */
const SPACES_PER_LIST_LEVEL = 2;

/** Split markdown source into the block shapes this renderer knows. */
export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!(lines[index] ?? '').trim()) {
      index += 1;
      continue;
    }
    const { block, next } = readBlock(lines, index);
    blocks.push(block);
    index = next;
  }

  return blocks;
}

/** Block readers in precedence order; the paragraph is what is left over. */
const BLOCK_READERS: ReadonlyArray<(lines: string[], start: number) => Parsed | undefined> = [
  readFence,
  readRule,
  readHeading,
  readTable,
  readQuote,
  readList,
];

function readBlock(lines: string[], start: number): Parsed {
  for (const read of BLOCK_READERS) {
    const parsed = read(lines, start);
    if (parsed) return parsed;
  }
  return readParagraph(lines, start);
}

function readFence(lines: string[], start: number): Parsed | undefined {
  const fence = FENCE.exec(lines[start] ?? '');
  if (!fence) return undefined;

  const marker = (fence[2] ?? '```').slice(0, 3);
  const language = fence[3] ?? '';
  const body: string[] = [];
  let index = start + 1;
  // An unterminated fence runs to the end: that is what a streaming
  // reply looks like a few hundred milliseconds before it closes.
  while (index < lines.length) {
    const current = lines[index] ?? '';
    index += 1;
    if (current.trimStart().startsWith(marker)) break;
    body.push(current);
  }

  const code = body.join('\n');
  return { block: language ? { type: 'code', code, language } : { type: 'code', code }, next: index };
}

function readRule(lines: string[], start: number): Parsed | undefined {
  return RULE.test(lines[start] ?? '') ? { block: { type: 'rule' }, next: start + 1 } : undefined;
}

function readHeading(lines: string[], start: number): Parsed | undefined {
  const heading = HEADING.exec(lines[start] ?? '');
  if (!heading) return undefined;
  const level = (heading[1] ?? '#').length;
  return { block: { type: 'heading', level, text: heading[2] ?? '' }, next: start + 1 };
}

/**
 * A table is a pipe row whose *next* line is the `|---|` divider. Testing the
 * divider is what keeps a lone pipe-heavy sentence out of a table.
 */
function isTableStart(lines: string[], index: number): boolean {
  return TABLE_ROW.test(lines[index] ?? '') && TABLE_DIVIDER.test(lines[index + 1] ?? '');
}

function readTable(lines: string[], start: number): Parsed | undefined {
  if (!isTableStart(lines, start)) return undefined;

  const header = splitRow(lines[start] ?? '');
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && TABLE_ROW.test(lines[index] ?? '')) {
    rows.push(splitRow(lines[index] ?? ''));
    index += 1;
  }
  return { block: { type: 'table', header, rows }, next: index };
}

/** Cells of one pipe-table row, without the outer pipes. */
function splitRow(line: string): string[] {
  const inner = TABLE_ROW.exec(line)?.[1] ?? line;
  return inner.split('|').map((cell) => cell.trim());
}

function readQuote(lines: string[], start: number): Parsed | undefined {
  if (!QUOTE.test(lines[start] ?? '')) return undefined;

  const quoted: string[] = [];
  let index = start;
  while (index < lines.length) {
    const match = QUOTE.exec(lines[index] ?? '');
    if (!match) break;
    quoted.push(match[1] ?? '');
    index += 1;
  }
  return { block: { type: 'quote', text: quoted.join('\n').trim() }, next: index };
}

function readList(lines: string[], start: number): Parsed | undefined {
  if (!LIST_ITEM.test(lines[start] ?? '')) return undefined;

  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const raw = lines[index] ?? '';
    const match = LIST_ITEM.exec(raw);
    if (match) {
      items.push(listItem(match));
    } else {
      // A wrapped continuation line belongs to the item above it.
      const last = items[items.length - 1];
      if (!last || !LIST_CONTINUATION.test(raw)) break;
      last.text += ' ' + raw.trim();
    }
    index += 1;
  }
  return { block: { type: 'list', items }, next: index };
}

/** Build one list item, pulling a `[ ]` / `[x]` checkbox out of its text. */
function listItem(match: RegExpExecArray): ListItem {
  const indent = Math.floor((match[1] ?? '').length / SPACES_PER_LIST_LEVEL);
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

/** Consecutive lines up to the next thing that starts a block of its own. */
function readParagraph(lines: string[], start: number): Parsed {
  const paragraph: string[] = [];
  let index = start;
  while (index < lines.length && !endsParagraph(lines, index)) {
    paragraph.push((lines[index] ?? '').trim());
    index += 1;
  }
  return { block: { type: 'paragraph', text: paragraph.join('\n') }, next: index };
}

function endsParagraph(lines: string[], index: number): boolean {
  const raw = lines[index] ?? '';
  return (
    !raw.trim() ||
    FENCE.test(raw) ||
    HEADING.test(raw) ||
    RULE.test(raw) ||
    QUOTE.test(raw) ||
    LIST_ITEM.test(raw) ||
    isTableStart(lines, index)
  );
}

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

/** Which capture group of `INLINE` carries the text of which mark. */
const INLINE_MARKS: ReadonlyArray<readonly [group: number, mark: Omit<Span, 'text'>]> = [
  [2, { code: true }],
  [3, { bold: true }],
  [4, { bold: true }],
  [5, { strike: true }],
  [6, { italic: true }],
  [7, { italic: true }],
  [8, { link: true }],
];

function markOf(match: RegExpExecArray) {
  return INLINE_MARKS.find(([group]) => match[group] !== undefined);
}

/** Split one line of markdown into styled spans. Never throws on odd syntax. */
export function parseInline(source: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;

  INLINE.lastIndex = 0;
  let match = INLINE.exec(source);
  while (match) {
    if (match.index > cursor) spans.push({ text: source.slice(cursor, match.index) });

    const marked = markOf(match);
    if (marked) spans.push({ text: match[marked[0]] ?? '', ...marked[1] });

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
  const base = color ?? ui.frost;
  return (
    <Text color={base} bold={bold} dimColor={dim} wrap="wrap">
      {spans.map((span, index) => (
        <Text
          key={index}
          bold={span.bold || bold}
          italic={span.italic}
          strikethrough={span.strike}
          underline={span.link}
          color={span.code ? ui.accentSoft : span.link ? ui.info : base}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

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
      {blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          // Blocks are separated by a blank line, the way markdown reads on a
          // page. Only the first block hugs whatever is above it.
          gap={index === 0 ? 0 : 1}
          tail={index === lastIndex ? trailing : null}
        />
      ))}
    </Box>
  );
}

function BlockView({
  block,
  gap,
  tail,
}: {
  block: Block;
  gap: number;
  tail: React.ReactNode;
}): React.JSX.Element {
  switch (block.type) {
    case 'heading':
      return <HeadingBlock level={block.level} text={block.text} gap={gap} tail={tail} />;

    case 'rule':
      return <Rule marginTop={gap} />;

    case 'code':
      return (
        <Section gap={gap} tail={tail}>
          <CodeBlock code={block.code} language={block.language} />
        </Section>
      );

    case 'quote':
      return (
        <Section gap={gap}>
          <ProseLines
            text={block.text}
            tail={tail}
            color={ui.muted}
            gutter={
              <Text color={ui.accent} dimColor>
                {glyph.bar + ' '}
              </Text>
            }
          />
        </Section>
      );

    case 'list':
      return (
        <Section gap={gap} tail={tail}>
          {block.items.map((item, itemIndex) => (
            <ListRow key={itemIndex} item={item} />
          ))}
        </Section>
      );

    case 'table':
      return (
        <Section gap={gap} tail={tail}>
          <TableBlock header={block.header} rows={block.rows} />
        </Section>
      );

    case 'paragraph':
      return (
        <Section gap={gap}>
          <ProseLines text={block.text} tail={tail} />
        </Section>
      );
  }
}

/** A block's own column, set off from the block above by `gap` blank lines. */
function Section({
  gap,
  tail,
  children,
}: {
  gap: number;
  tail?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={gap}>
      {children}
      {tail}
    </Box>
  );
}

/** A faint horizontal rule: just a top border on an empty box. */
function Rule({ marginTop = 0 }: { marginTop?: number }): React.JSX.Element {
  return (
    <Box
      marginTop={marginTop}
      borderStyle="single"
      borderColor={ui.faint}
      borderDimColor
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
    />
  );
}

/** Prose one source line per row, with the streaming cursor on the last. */
function ProseLines({
  text,
  tail,
  color,
  gutter,
}: {
  text: string;
  tail: React.ReactNode;
  color?: string;
  gutter?: React.ReactNode;
}): React.JSX.Element {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, index) => (
        <Box key={index} flexDirection="row">
          {gutter}
          <Box flexGrow={1}>
            <Inline text={line} color={color} />
          </Box>
          {index === lines.length - 1 ? tail : null}
        </Box>
      ))}
    </>
  );
}

/**
 * A heading, set rather than echoed.
 *
 * Level 1 is the loudest thing a reply can say, so it is set in caps with a
 * rule under it; level 2 is brand green; level 3 and deeper stay in body
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
            <Inline text={text.toUpperCase()} color={ui.accent} bold />
          </Box>
          {tail}
        </Box>
        <Rule />
      </Box>
    );
  }

  return (
    <Box flexDirection="row" marginTop={gap}>
      <Box flexGrow={1}>
        <Inline text={text} color={level === 2 ? ui.accent : ui.frost} bold />
      </Box>
      {tail}
    </Box>
  );
}

/** Columns a nested list item moves in per nesting level. */
const LIST_INDENT_COLUMNS = 2;

/** One list row: marker in the gutter, wrapped body next to it. */
function ListRow({ item }: { item: ListItem }): React.JSX.Element {
  const marker =
    item.checked === undefined ? item.marker : item.checked ? glyph.boxOn : glyph.boxOff;
  const color = item.checked ? ui.ok : item.checked === false ? ui.muted : ui.accent;

  return (
    <Box flexDirection="row" paddingLeft={item.indent * LIST_INDENT_COLUMNS}>
      <Text color={color}>{marker + ' '}</Text>
      <Box flexGrow={1}>
        <Inline text={item.text} dim={item.checked} />
      </Box>
    </Box>
  );
}

/** Widest a table column may grow, in characters. */
const MAX_TABLE_COLUMN = 40;

/** Blank columns between two table columns. */
const TABLE_COLUMN_GAP = 2;

/**
 * A pipe table.
 *
 * Columns are sized from their content and capped, because a model that
 * returns one 300-character cell must not be allowed to push the other columns
 * off the screen. Cells past the cap are cut with an ellipsis rather than
 * wrapped: a table whose rows are different heights stops being a table.
 */
function TableBlock({ header, rows }: { header: string[]; rows: string[][] }): React.JSX.Element {
  const widths = columnWidths(header, rows);

  const textRow = (cells: string[], color: string, bold: boolean): React.JSX.Element => (
    <TableRow
      widths={widths}
      cell={(width, column) => (
        <Text color={color} bold={bold}>
          {pad(cells[column] ?? '', width)}
        </Text>
      )}
    />
  );

  return (
    <Box flexDirection="column">
      {textRow(header, ui.accent, true)}
      <TableRow
        widths={widths}
        cell={(width) => <Text color={ui.faint}>{glyph.rule.repeat(width)}</Text>}
      />
      {rows.map((cells, rowIndex) => (
        <React.Fragment key={rowIndex}>{textRow(cells, ui.frost, false)}</React.Fragment>
      ))}
    </Box>
  );
}

function columnWidths(header: string[], rows: string[][]): number[] {
  const count = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const widths: number[] = [];

  for (let column = 0; column < count; column += 1) {
    const cells = [header[column] ?? '', ...rows.map((row) => row[column] ?? '')];
    const longest = Math.max(...cells.map((cell) => plain(cell).length), 1);
    widths.push(Math.min(longest, MAX_TABLE_COLUMN));
  }
  return widths;
}

/** One table row: a gap-separated box per column, filled in by `cell`. */
function TableRow({
  widths,
  cell,
}: {
  widths: number[];
  cell: (width: number, column: number) => React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="row">
      {widths.map((width, column) => (
        <Box key={column} marginRight={column === widths.length - 1 ? 0 : TABLE_COLUMN_GAP}>
          {cell(width, column)}
        </Box>
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
