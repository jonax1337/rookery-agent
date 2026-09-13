/**
 * A tolerant reader for the slice of TOML the CLIs actually write.
 *
 * Codex keeps its whole configuration in `~/.codex/config.toml` - MCP
 * servers, plugin switches, editor preferences, hook fingerprints - and it,
 * not Rookery, decides what goes in there. A strict parser would be the
 * wrong tool: one construct it has never seen (an inline table in a corner
 * of the file nobody here cares about, a date, a key style) and the whole
 * read fails, taking the MCP servers with it. So this one reads what it
 * understands and steps over the rest, statement by statement.
 *
 * Deliberately no dependency: the same reason the database is `node:sqlite`.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

const BARE = /[A-Za-z0-9_-]/;

class Reader {
  #text: string;
  #at = 0;

  constructor(text: string) {
    this.#text = text;
  }

  get done(): boolean {
    return this.#at >= this.#text.length;
  }

  peek(offset = 0): string {
    return this.#text[this.#at + offset] ?? '';
  }

  take(count = 1): string {
    const slice = this.#text.slice(this.#at, this.#at + count);
    this.#at += count;
    return slice;
  }

  starts(text: string): boolean {
    return this.#text.startsWith(text, this.#at);
  }

  /** Past whitespace, comments and - when asked - line breaks. */
  skip(newlines: boolean): void {
    for (;;) {
      const char = this.peek();
      if (char === ' ' || char === '\t' || char === '\r') this.#at += 1;
      else if (char === '\n' && newlines) this.#at += 1;
      else if (char === '#') this.toLineEnd();
      else return;
    }
  }

  toLineEnd(): void {
    while (!this.done && this.peek() !== '\n') this.#at += 1;
  }

  /** Past the current statement, used when something could not be read. */
  recover(): void {
    this.toLineEnd();
    if (!this.done) this.#at += 1;
  }
}

/** A quoted or bare key segment. */
function readKeySegment(reader: Reader): string {
  const quote = reader.peek();
  if (quote === '"' || quote === "'") return readString(reader);
  let name = '';
  while (BARE.test(reader.peek())) name += reader.take();
  if (!name) throw new Error('key expected');
  return name;
}

/** A dotted key path: `a.b."c d"`. */
function readKeyPath(reader: Reader): string[] {
  const path = [readKeySegment(reader)];
  for (;;) {
    reader.skip(false);
    if (reader.peek() !== '.') return path;
    reader.take();
    reader.skip(false);
    path.push(readKeySegment(reader));
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };

function readString(reader: Reader): string {
  // Multi-line forms first: their opening delimiter starts with the single one.
  if (reader.starts('"""') || reader.starts("'''")) {
    const fence = reader.take(3);
    const literal = fence === "'''";
    let text = '';
    if (reader.peek() === '\n') reader.take();
    while (!reader.done && !reader.starts(fence)) {
      const char = reader.take();
      if (!literal && char === '\\') {
        const escaped = reader.take();
        text += ESCAPES[escaped] ?? escaped;
      } else text += char;
    }
    reader.take(3);
    return text;
  }

  const quote = reader.take();
  const literal = quote === "'";
  let text = '';
  while (!reader.done) {
    const char = reader.take();
    if (char === quote) return text;
    if (char === '\n') throw new Error('unterminated string');
    if (!literal && char === '\\') {
      const escaped = reader.take();
      if (escaped === 'u' || escaped === 'U') {
        const digits = reader.take(escaped === 'u' ? 4 : 8);
        text += String.fromCodePoint(Number.parseInt(digits, 16) || 0);
      } else text += ESCAPES[escaped] ?? escaped;
    } else text += char;
  }
  throw new Error('unterminated string');
}

function readValue(reader: Reader): TomlValue {
  reader.skip(false);
  const char = reader.peek();
  if (char === '"' || char === "'") return readString(reader);

  if (char === '[') {
    reader.take();
    const items: TomlValue[] = [];
    for (;;) {
      reader.skip(true);
      if (reader.done) throw new Error('unterminated array');
      if (reader.peek() === ']') {
        reader.take();
        return items;
      }
      items.push(readValue(reader));
      reader.skip(true);
      if (reader.peek() === ',') reader.take();
    }
  }

  if (char === '{') {
    reader.take();
    const table: TomlTable = {};
    for (;;) {
      reader.skip(true);
      if (reader.done) throw new Error('unterminated inline table');
      if (reader.peek() === '}') {
        reader.take();
        return table;
      }
      const path = readKeyPath(reader);
      reader.skip(false);
      if (reader.peek() !== '=') throw new Error('= expected');
      reader.take();
      place(table, path, readValue(reader));
      reader.skip(true);
      if (reader.peek() === ',') reader.take();
    }
  }

  // Everything else runs to the end of the value: a boolean, a number, or a
  // shape this reader does not model (a date, say), kept as the raw text.
  let raw = '';
  while (!reader.done) {
    const next = reader.peek();
    if (next === '\n' || next === ',' || next === ']' || next === '}' || next === '#') break;
    raw += reader.take();
  }
  const text = raw.trim();
  if (!text) throw new Error('value expected');
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^0x[0-9a-fA-F_]+$/.test(text)) return Number.parseInt(text.slice(2).replace(/_/g, ''), 16);
  if (/^[+-]?\d[\d_]*(\.[\d_]+)?([eE][+-]?\d+)?$/.test(text)) return Number(text.replace(/_/g, ''));
  return text;
}

/** Walk a key path, creating tables on the way, and set the last segment. */
function place(root: TomlTable, path: string[], value: TomlValue): void {
  const table = descend(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (last !== undefined) table[last] = value;
}

/** The table at a key path, created as plain tables where it does not exist. */
function descend(root: TomlTable, path: string[]): TomlTable {
  let table = root;
  for (const segment of path) {
    let next = table[segment];
    // An array of tables continues in its last element, the way TOML reads it.
    if (Array.isArray(next)) next = next[next.length - 1];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      next = {};
      table[segment] = next;
    }
    table = next as TomlTable;
  }
  return table;
}

/**
 * The document as nested plain objects. Never throws: a statement that does
 * not read is skipped, and what came before it is kept.
 */
export function readToml(text: string): TomlTable {
  const reader = new Reader(text);
  const root: TomlTable = {};
  let current = root;

  while (!reader.done) {
    reader.skip(true);
    if (reader.done) break;

    try {
      if (reader.peek() === '[') {
        const arrayOfTables = reader.starts('[[');
        reader.take(arrayOfTables ? 2 : 1);
        reader.skip(false);
        const path = readKeyPath(reader);
        reader.skip(false);
        reader.take(arrayOfTables ? 2 : 1);
        if (arrayOfTables) {
          const parent = descend(root, path.slice(0, -1));
          const last = path[path.length - 1] as string;
          const existing = parent[last];
          const list = Array.isArray(existing) ? existing : [];
          const entry: TomlTable = {};
          list.push(entry);
          parent[last] = list;
          current = entry;
        } else {
          current = descend(root, path);
        }
        reader.toLineEnd();
        continue;
      }

      const path = readKeyPath(reader);
      reader.skip(false);
      if (reader.peek() !== '=') throw new Error('= expected');
      reader.take();
      place(current, path, readValue(reader));
      reader.skip(false);
      reader.toLineEnd();
    } catch {
      reader.recover();
    }
  }

  return root;
}

/** The nested table at a path, or null when the path holds something else. */
export function tomlTable(root: TomlTable, ...path: string[]): TomlTable | null {
  let value: TomlValue | undefined = root;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    value = (value as TomlTable)[segment];
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TomlTable) : null;
}
