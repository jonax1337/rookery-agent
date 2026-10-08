import { EventEmitter } from 'node:events';
import { access, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '../types.js';
import { quoteForCmd, type ResolvedBinary } from './process.js';
import { userSettingsGuard } from './user-settings-guard.js';

/**
 * Claude Code as a real terminal program instead of a headless print run.
 *
 * An agent's work used to run as `claude -p --output-format stream-json`:
 * fast to parse, invisible to watch. Here the same binary starts with its
 * full TUI inside a pseudo terminal, and the bytes it paints go to whoever
 * opens the run in the browser - the same screen a person would see sitting
 * at that console, and one they can type into.
 *
 * Nothing the controller relies on changes. The events it reads (`text`,
 * `thinking`, `tool`, `done`, `error`) are rebuilt from the session
 * transcript Claude Code writes as JSONL next to every session, and the end
 * of the work is not guessed from the screen: a `Stop` hook, handed in with
 * the turn's settings, writes its payload to a marker file the moment the
 * agent stops - including `last_assistant_message`, which is exactly what a
 * print run reports as its result.
 *
 * The process outlives the work on purpose. When the agent stops, the run
 * is done and the task moves on, but the terminal stays open for a while so
 * the person can still read it or ask a follow-up; after that, or when
 * somebody closes it, the process is killed and all that remains is the
 * transcript. A cancelled or failed run is killed at once.
 */

/** What a terminal session is doing, as the UI shows it. */
export type TuiState = 'running' | 'idle' | 'exited';

export interface TuiSessionInfo {
  /** Who the session belongs to - an assignment id. */
  key: string;
  /** Claude Code's own session id, the name of the transcript file. */
  providerSessionId: string;
  state: TuiState;
  startedAt: number;
  cols: number;
  rows: number;
}

/** The subset of node-pty's `IPty` this module uses. */
interface PtyProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: { name: string; cols: number; rows: number; cwd?: string; env: Record<string, string> },
  ): PtyProcess;
}

const MINUTE_MS = 60_000;

/** How much screen output a late viewer gets replayed, in characters. */
const REPLAY_LIMIT = 1_000_000;

/** How long a finished agent's terminal stays open before it is killed. */
export const TUI_LINGER_MS = 10 * MINUTE_MS;

/** A size that fits the run page; the browser resizes to its own right away. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;

/** What a browser may resize the terminal to. */
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

/** Lines of history the screen mirror keeps above the visible screen. */
const MIRROR_SCROLLBACK_LINES = 5000;

/** The terminal type the child is told it runs in. */
const TERM = 'xterm-256color';

/** Longer prompts go to a file: argv on Windows ends at 32 767 characters. */
const INLINE_PROMPT_LIMIT = 12_000;

/**
 * No screen output and no transcript growth for this long means the terminal
 * waits for input nobody is giving - a permission question, or a run that
 * was interrupted with Esc and never told what to do next. Until then a
 * person can still answer it from the run page.
 */
const IDLE_LIMIT_MS = 15 * MINUTE_MS;

/** How long the transcript may trail the Stop hook before it is read as is. */
const SETTLE_LIMIT_MS = 3000;

const POLL_MS = 250;

/** How long after a Stop the transcript is watched for work a blocking hook set going again. */
const HOOK_BLOCK_GRACE_MS = 4 * POLL_MS;

/** The slower pace at which a lingering terminal's transcript is followed. */
const LATE_POLL_MS = 4 * POLL_MS;

const ESC = String.fromCharCode(27);

/** The TUI switches bracketed paste on and off with these; see `PASTE_START`. */
const PASTE_ON = ESC + '[?2004h';
const PASTE_OFF = ESC + '[?2004l';

/** Bracketed paste: the TUI takes the text between these as one paste, newlines and all. */
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';

let ptyModule: Promise<PtyModule | null> | undefined;

/**
 * The native pty binding, or `null` where it cannot load (a platform without
 * a prebuilt binary). Callers fall back to the headless run then.
 */
export function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('@lydell/node-pty')
    .then((module) => module as unknown as PtyModule)
    .catch(() => null);
  return ptyModule;
}

/** The subset of `@xterm/headless` plus its serialize addon this module uses. */
interface ScreenMirror {
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  serialize(): string;
  /** The visible screen as plain text, one line per row. */
  text(): string;
  dispose(): void;
}

/** The subset of an `@xterm/headless` terminal the mirror drives. */
interface HeadlessTerminal {
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
  rows: number;
  buffer: {
    active: {
      viewportY: number;
      getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

type HeadlessTerminalClass = new (options: Record<string, unknown>) => HeadlessTerminal;
type SerializeAddonClass = new () => { serialize(): string };
type MirrorFactory = (cols: number, rows: number) => ScreenMirror;

let mirrorModule: Promise<MirrorFactory | null> | undefined;

/** A package export by name; some loaders only expose it under `default`. */
function exportOf<T>(loaded: unknown, name: string): T {
  // A dynamically imported package, whose shape is only known by name.
  const members = loaded as Record<string, unknown>;
  const fallback = members.default as Record<string, unknown>;
  return (members[name] ?? fallback[name]) as T;
}

function mirrorFactory(Terminal: HeadlessTerminalClass, SerializeAddon: SerializeAddonClass): MirrorFactory {
  return (cols, rows) => {
    const term = new Terminal({ cols, rows, scrollback: MIRROR_SCROLLBACK_LINES, allowProposedApi: true });
    const addon = new SerializeAddon();
    term.loadAddon(addon);
    return {
      write: (data, done) => term.write(data, done),
      // Queued behind what is still waiting to be parsed: a write is
      // processed later, a resize at once, and bytes painted for the old
      // width then landed on the new one - overlapping, skewed lines.
      resize: (c, r) => term.write('', () => term.resize(c, r)),
      serialize: () => addon.serialize(),
      text: () => {
        const buffer = term.buffer.active;
        const lines: string[] = [];
        for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y += 1) {
          lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
        }
        return lines.join('\n');
      },
      dispose: () => term.dispose(),
    };
  };
}

/**
 * A terminal emulator with no screen, fed the same bytes as the browser.
 *
 * A viewer that opens a terminal late used to get the raw byte history
 * replayed - cursor moves and partial repaints computed for whatever size
 * the terminal had back then, cut off at a byte limit wherever that fell.
 * Played into a terminal of another size that came out skewed: prompt bars
 * twice, lines broken halfway, colour runs ending in the wrong place. The
 * mirror keeps the screen as it actually is, and a late viewer gets that,
 * serialized - colours and all - at the size the process has now.
 */
function loadMirror(): Promise<MirrorFactory | null> {
  mirrorModule ??= Promise.all([import('@xterm/headless'), import('@xterm/addon-serialize')])
    .then(([headless, serialize]) =>
      mirrorFactory(
        exportOf<HeadlessTerminalClass>(headless, 'Terminal'),
        exportOf<SerializeAddonClass>(serialize, 'SerializeAddon'),
      ),
    )
    .catch(() => null);
  return mirrorModule;
}

// Loaded up front, not with the first terminal. The mirror replays what was
// painted before it existed, at the size it is created with; if the module
// took its time on first use, a browser could resize the process in between,
// and the early bytes were then replayed at the wrong width.
void loadMirror();

/** The raw output so far, or the screen serialized, with the session it belongs to. */
interface ScreenSnapshot {
  info: TuiSessionInfo;
  data: string;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.floor(value)));

class TuiSession {
  buffer = '';
  /** The screen as it is, for late viewers; unset where the emulator cannot load. */
  mirror: ScreenMirror | undefined;
  /** Whether the TUI has bracketed paste switched on right now. */
  pasteMode = false;
  #lingerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly info: TuiSessionInfo,
    readonly pty: PtyProcess,
    private readonly cleanup: () => void,
    private readonly lingerMs: number,
  ) {}

  infoCopy(): TuiSessionInfo {
    return { ...this.info };
  }

  /** What the process painted: kept for late viewers, fed to the mirror, scanned for paste mode. */
  receive(data: string): void {
    this.buffer = (this.buffer + data).slice(-REPLAY_LIMIT);
    this.mirror?.write(data);
    const on = data.lastIndexOf(PASTE_ON);
    const off = data.lastIndexOf(PASTE_OFF);
    if (on !== off) this.pasteMode = on > off;
  }

  /** (Re)starts the countdown after which `expire` runs; it never keeps the process alive. */
  startLinger(expire: () => void): void {
    clearTimeout(this.#lingerTimer);
    this.#lingerTimer = setTimeout(expire, this.lingerMs);
    this.#lingerTimer.unref?.();
  }

  stopLinger(): void {
    clearTimeout(this.#lingerTimer);
  }

  /** The process is gone: no countdown, no screen mirror, and the owner's cleanup runs. */
  end(): void {
    this.stopLinger();
    this.mirror?.dispose();
    this.mirror = undefined;
    this.cleanup();
  }
}

/**
 * Every terminal that is still open, by assignment id.
 *
 * One per process, like the codex bridge: the provider starts sessions, the
 * server streams them to browsers, and both have to find the same ones.
 * Events: `data` (key, chunk), `state` (info), `exit` (key).
 */
export class TuiSessionRegistry extends EventEmitter {
  readonly #sessions = new Map<string, TuiSession>();

  /** Registers a freshly spawned pty; an older session under the same key is killed. */
  attach(
    key: string,
    pty: PtyProcess,
    providerSessionId: string,
    cleanup: () => void,
    lingerMs: number = TUI_LINGER_MS,
  ): void {
    this.kill(key);
    const session = new TuiSession(
      { key, providerSessionId, state: 'running', startedAt: Date.now(), cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
      pty,
      cleanup,
      lingerMs,
    );
    this.#sessions.set(key, session);
    this.#startMirror(key, session);
    pty.onData((data) => this.#received(key, session, data));
    pty.onExit(() => this.#exited(key, session));
    this.#announce(session);
  }

  /** Terminals currently attached, whether their run is working or waiting. */
  get size(): number {
    return this.#sessions.size;
  }

  info(key: string): TuiSessionInfo | null {
    return this.#sessions.get(key)?.infoCopy() ?? null;
  }

  list(): TuiSessionInfo[] {
    return [...this.#sessions.values()].map((session) => session.infoCopy());
  }

  /** The raw output so far - what the process wrote, not what the screen shows. */
  snapshot(key: string): ScreenSnapshot | null {
    const session = this.#sessions.get(key);
    return session ? { info: session.infoCopy(), data: session.buffer } : null;
  }

  /**
   * The screen as it is now, for a viewer that opens the terminal late:
   * scrollback and visible screen serialized at the process's current size.
   * Falls back to the raw output where there is no emulator.
   */
  async screen(key: string): Promise<ScreenSnapshot | null> {
    const session = this.#sessions.get(key);
    if (!session) return null;
    const mirror = session.mirror;
    if (!mirror) return this.snapshot(key);
    // Parsing is asynchronous; wait until what has arrived is on the screen.
    await new Promise<void>((resolve) => mirror.write('', resolve));
    if (session.mirror !== mirror) return this.snapshot(key);
    return { info: session.infoCopy(), data: mirror.serialize() };
  }

  /** What the screen shows right now as plain text, or null without an emulator. */
  screenText(key: string): string | null {
    return this.#sessions.get(key)?.mirror?.text() ?? null;
  }

  /** Whether the TUI takes pasted text as one paste right now. */
  pasteMode(key: string): boolean {
    return this.#sessions.get(key)?.pasteMode ?? false;
  }

  /** Keystrokes from a person. Typing into a finished terminal keeps it open longer. */
  write(key: string, data: string): boolean {
    const session = this.#sessions.get(key);
    if (!session) return false;
    session.pty.write(data);
    if (session.info.state === 'idle') this.linger(key);
    return true;
  }

  resize(key: string, cols: number, rows: number): void {
    const session = this.#sessions.get(key);
    if (!session) return;
    const c = clamp(cols, MIN_COLS, MAX_COLS);
    const r = clamp(rows, MIN_ROWS, MAX_ROWS);
    if (c === session.info.cols && r === session.info.rows) return;
    try {
      session.pty.resize(c, r);
      session.mirror?.resize(c, r);
      session.info.cols = c;
      session.info.rows = r;
      // Every other viewer of this terminal follows the new size instead of
      // fighting it with its own (run-terminal.tsx).
      this.#announce(session);
    } catch {
      // A pty that is exiting refuses a resize; nothing to keep.
    }
  }

  /**
   * Work started (again): a person typed into a conversation terminal. The
   * countdown a finished turn set is off while Claude is working.
   */
  markRunning(key: string): void {
    const session = this.#sessions.get(key);
    if (!session) return;
    session.stopLinger();
    this.#setState(session, 'running');
  }

  /** The work is over: the terminal stays open, then goes. */
  linger(key: string): void {
    const session = this.#sessions.get(key);
    if (!session) return;
    this.#setState(session, 'idle');
    session.startLinger(() => this.kill(key));
  }

  kill(key: string): boolean {
    const session = this.#sessions.get(key);
    if (!session) return false;
    session.stopLinger();
    try {
      session.pty.kill();
    } catch {
      // Already gone; the exit handler has done or will do the rest.
    }
    return true;
  }

  /** Server shutdown: no terminal outlives the process that owns it. */
  killAll(): void {
    for (const key of [...this.#sessions.keys()]) this.kill(key);
  }

  /**
   * Everything painted before the emulator was ready is still in the raw
   * buffer; it goes in first, and every later chunk after it.
   */
  #startMirror(key: string, session: TuiSession): void {
    void loadMirror().then((create) => {
      if (!create || this.#sessions.get(key) !== session) return;
      const mirror = create(session.info.cols, session.info.rows);
      mirror.write(session.buffer);
      session.mirror = mirror;
    });
  }

  #received(key: string, session: TuiSession, data: string): void {
    if (this.#sessions.get(key) !== session) return;
    session.receive(data);
    this.emit('data', key, data);
  }

  #exited(key: string, session: TuiSession): void {
    try {
      session.end();
    } finally {
      // A session replaced under its key (see `attach`) is not the registry's to announce.
      if (this.#sessions.get(key) === session) {
        this.#sessions.delete(key);
        this.#setState(session, 'exited');
        this.emit('exit', key);
      }
    }
  }

  #setState(session: TuiSession, state: TuiState): void {
    if (session.info.state === state) return;
    session.info.state = state;
    this.#announce(session);
  }

  #announce(session: TuiSession): void {
    this.emit('state', session.infoCopy());
  }
}

export const tuiSessions = new TuiSessionRegistry();

/* --------------------------------- the run -------------------------------- */

/** What starting Claude Code in a terminal needs - for a run or a conversation. */
export interface TuiSpawnSpec {
  /** Registry key - an assignment id, or `chat:<session id>`. */
  key: string;
  binary: ResolvedBinary;
  /** Everything but the prompt. */
  args: string[];
  /** The first message. A conversation terminal opens without one. */
  prompt?: string;
  cwd?: string;
  /** Additions to the environment; inherited Claude Code markers are removed first. */
  env: NodeJS.ProcessEnv;
  /** Claude Code's session id, pinned with `--session-id` or `--resume` in `args`. */
  sessionId: string;
  /** A folder of this terminal's own; the prompt file goes here. */
  workDir: string;
  /** Where the Stop hook writes its payload. */
  markerFile: string;
  /** Turns one transcript entry into the events a print run would have sent. */
  mapEntry: (entry: Record<string, unknown>) => AgentEvent[];
  /** Runs once the process is gone - the temp folders go then, not earlier. */
  cleanup: () => void;
  lingerMs?: number;
}

export interface TuiRunSpec extends TuiSpawnSpec {
  prompt: string;
  signal?: AbortSignal;
  /**
   * Events that arrive after the work was reported done: whatever a person
   * does in the terminal while it lingers. Without this they would be on the
   * screen and nowhere else - gone with the process.
   */
  onLateEvent?: (event: AgentEvent) => void;
}

const forwardSlashes = (path: string): string => path.replace(/\\/g, '/');

/** A file path as it sits inside a single-quoted string of a hook command. */
const quotedInScript = (file: string): string => forwardSlashes(file).replace(/'/g, "\\'");

/** The Stop hook's command: the payload on stdin, verbatim into the marker file. */
export function stopHookCommand(markerFile: string): string {
  const node = forwardSlashes(process.execPath);
  const target = quotedInScript(markerFile);
  return `"${node}" -e "require('fs').writeFileSync('${target}', require('fs').readFileSync(0))"`;
}

/**
 * Environment for the child. A Rookery started from inside a Claude Code
 * session inherits that session's markers, and with
 * `CLAUDE_CODE_CHILD_SESSION` set the new process quietly stops writing its
 * transcript - which is everything this mode reads.
 */
function childEnv(extra: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_')) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) env[name] = value;
  }
  env.TERM = TERM;
  env.COLORTERM = 'truecolor';
  return env;
}

/** Screen text without escape sequences and whitespace, for spotting a dialog. */
function flatten(screen: string): string {
  return screen
    .split(ESC)
    .join('')
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '');
}

const ARROW_DOWN = ESC + '[B';

/**
 * First-run dialogs a print run never shows, and the answer a person would
 * give. The folder is one Rookery already works in; the bypass warning only
 * appears for a `full` agent, which is a setting somebody chose.
 */
const STARTUP_DIALOGS: { marker: string; keys: string }[] = [
  { marker: 'Yes,Itrustthisfolder', keys: ARROW_DOWN },
  { marker: 'Yes,Iaccept', keys: ARROW_DOWN },
];

/** How much recent screen output is searched for a dialog, in characters. */
const DIALOG_SCREEN_TAIL = 20_000;

/** A beat before each key of a dialog answer, as a person would take it. */
const DIALOG_KEY_DELAY_MS = 150;

function configDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** The transcript file, once Claude Code has created it. */
async function findTranscript(root: string, sessionId: string): Promise<string | null> {
  const projects = join(root, 'projects');
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    const candidate = join(projects, folder, sessionId + '.jsonl');
    const found = await access(candidate).then(
      () => true,
      () => false,
    );
    if (found) return candidate;
  }
  return null;
}

const LINE_FEED = 0x0a;
const NO_BYTES = Buffer.alloc(0);

/** Reads a growing JSONL file from where the last call stopped. */
class TranscriptTail {
  #offset = 0;
  /** Bytes after the last newline: a line still being written. */
  #partial: Buffer = NO_BYTES;
  readonly #seen = new Set<string>();

  constructor(readonly path: string) {}

  /** Starts at the current end: a resumed session's history is not news. */
  async skipToEnd(): Promise<void> {
    try {
      this.#offset = (await stat(this.path)).size;
    } catch {
      // Not there yet: then everything in it will be new.
    }
  }

  async read(): Promise<Record<string, unknown>[]> {
    const appended = await this.#readAppended();
    if (appended.length === 0) return [];
    const bytes = Buffer.concat([this.#partial, appended]);
    const lastLineEnd = bytes.lastIndexOf(LINE_FEED);
    // Split on bytes, not on decoded text: a torn line is completed by the
    // next read, and so is a multi-byte character cut in half.
    this.#partial = bytes.subarray(lastLineEnd + 1);
    if (lastLineEnd === -1) return [];
    const entries: Record<string, unknown>[] = [];
    for (const line of bytes.toString('utf8', 0, lastLineEnd).split('\n')) {
      const entry = this.#parse(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** What the file grew by since the last call; nothing where there is none or no file yet. */
  async #readAppended(): Promise<Buffer> {
    const handle = await open(this.path, 'r').catch(() => null);
    if (!handle) return NO_BYTES;
    try {
      const { size } = await handle.stat();
      if (size <= this.#offset) return NO_BYTES;
      const buffer = Buffer.alloc(size - this.#offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.#offset);
      this.#offset += bytesRead;
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** The entry on one line, or null for a blank line, a broken one, or an entry seen before. */
  #parse(line: string): Record<string, unknown> | null {
    if (!line.trim()) return null;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A torn line never gets here (see `read`); a broken one is skipped.
      return null;
    }
    if (typeof entry !== 'object' || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.uuid === 'string') {
      if (this.#seen.has(record.uuid)) return null;
      this.#seen.add(record.uuid);
    }
    return record;
  }
}

/**
 * What a person typed, out of one `user` transcript entry - or `null` for
 * the entries that only look like one: tool results, and the wrappers Claude
 * Code writes for slash commands and its own reminders.
 */
function typedPrompt(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isSidechain === true) return null;
  const message = entry.message as Record<string, unknown> | undefined;
  const content = message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const blocks = content as Record<string, unknown>[];
    if (blocks.some((block) => block.type === 'tool_result')) return null;
    text = blocks.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n');
  }
  text = text.trim();
  if (!text || text.startsWith('<')) return null;
  return text;
}

/** What the model's prompt tokens add up to for one assistant entry, or undefined where it reports none. */
function contextTokensOf(usage: Record<string, unknown>): number | undefined {
  const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].filter(
    (value): value is number => typeof value === 'number',
  );
  return parts.length ? parts.reduce((sum, value) => sum + value, 0) : undefined;
}

const API_ERROR_FALLBACK = 'The API returned an error.';

/** The text of an assistant entry Claude Code wrote for an API error. */
function apiErrorText(message: Record<string, unknown> | undefined): string {
  const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
  return (
    content
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join(' ')
      .trim() || API_ERROR_FALLBACK
  );
}

/** A text block as the result of a turn: without the blank lines Claude Code leads it with. */
const withoutLeadingBreak = (text: string): string => text.replace(/^\n\n/, '');

/** The text a turn ended with - what a print run reports as its result. */
function lastTextBlock(events: AgentEvent[]): string {
  let last = '';
  for (const event of events) if (event.type === 'text') last = withoutLeadingBreak(event.delta);
  return last;
}

/** What the Stop hook reported the agent said last, or an empty string. */
function reportedMessage(payload: Record<string, unknown>): string {
  return typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
}

const fatalError = (message: string): AgentEvent => ({ type: 'error', message, fatal: true });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A spawned terminal, and what its transcript has said so far. */
class TerminalWatch {
  exitCode: number | null = null;
  lastActivity = Date.now();
  /** The last time the screen changed - quiet here means the TUI sits at its prompt. */
  lastScreen = Date.now();
  /** The newest text block - what a print run reports as its result. */
  lastBlock = '';
  /** Assistant entries read so far; growth after a Stop means work went on. */
  assistantEntries = 0;
  apiError: string | null = null;
  contextTokens: number | undefined;
  /** The model of the newest assistant entry - `/model` can change it mid-session. */
  model: string | undefined;
  #tail: TranscriptTail | null = null;
  /** The read in flight, if any; the next one starts when it is over. */
  #reading: Promise<unknown> = Promise.resolve();
  readonly #root: string;

  constructor(
    readonly spec: TuiSpawnSpec,
    /** A resumed session: its transcript already has a history to skip. */
    readonly resumed: boolean,
  ) {
    this.#root = configDir(spec.env);
  }

  /** The process painted something. */
  screenPainted(): void {
    this.lastActivity = Date.now();
    this.lastScreen = this.lastActivity;
  }

  /** How long the work has gone on, and how much context it holds. */
  usage(startedAt: number): TuiTurn['usage'] {
    return {
      durationMs: Date.now() - startedAt,
      ...(this.contextTokens !== undefined ? { contextTokens: this.contextTokens } : {}),
    };
  }

  /**
   * New transcript entries, as the events a print run would have streamed.
   * What a person typed comes out as a `status` event labelled `input`, in
   * its place between the answers. Reads never overlap - two at once would
   * both take the same bytes - so a caller waits for the one before it.
   */
  read(): Promise<AgentEvent[]> {
    const result = this.#reading.then(() => this.#readNow());
    this.#reading = result.catch(() => undefined);
    return result;
  }

  async #readNow(): Promise<AgentEvent[]> {
    const tail = await this.#transcript();
    if (!tail) return [];
    const events: AgentEvent[] = [];
    for (const entry of await tail.read()) {
      this.lastActivity = Date.now();
      if (entry.isSidechain === true) continue;
      const typed = typedPrompt(entry);
      if (typed !== null) {
        events.push({ type: 'status', label: 'input', detail: typed });
        continue;
      }
      if (entry.type === 'assistant') {
        this.#recordAssistant(entry);
        if (entry.isApiErrorMessage === true) {
          this.apiError = apiErrorText(entry.message as Record<string, unknown> | undefined);
          continue;
        }
        this.apiError = null;
      }
      for (const event of this.spec.mapEntry(entry)) {
        if (event.type === 'text') this.lastBlock = withoutLeadingBreak(event.delta);
        events.push(event);
      }
    }
    return events;
  }

  async #transcript(): Promise<TranscriptTail | null> {
    if (this.#tail) return this.#tail;
    const path = await findTranscript(this.#root, this.spec.sessionId);
    if (!path) return null;
    this.#tail = new TranscriptTail(path);
    if (this.resumed) await this.#tail.skipToEnd();
    return this.#tail;
  }

  #recordAssistant(entry: Record<string, unknown>): void {
    this.assistantEntries += 1;
    const message = entry.message as Record<string, unknown> | undefined;
    if (typeof message?.model === 'string' && message.model !== '<synthetic>') this.model = message.model;
    const usage = message?.usage as Record<string, unknown> | undefined;
    const tokens = usage ? contextTokensOf(usage) : undefined;
    if (tokens !== undefined) this.contextTokens = tokens;
  }

  /** The Stop hook's payload, once it has written one. */
  async marker(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(this.spec.markerFile, 'utf8');
      return raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      // Not written yet, or caught halfway through the write: asked again next poll.
      return null;
    }
  }

  async clearMarker(): Promise<void> {
    // The folder goes with the process; without it there is nothing left to clear.
    await writeFile(this.spec.markerFile, '').catch(() => undefined);
  }

  /**
   * After a Stop: read until the reported message is in the transcript (it
   * can trail the hook), then look once more. New assistant entries a moment
   * later mean a Stop hook of the person's own answered "block" and Claude
   * Code kept working - this stop was not the end.
   */
  async settle(reported: string): Promise<{ events: AgentEvent[]; holds: boolean }> {
    const events: AgentEvent[] = [];
    for (let waited = 0; waited < SETTLE_LIMIT_MS; waited += POLL_MS) {
      events.push(...(await this.read()));
      if (!reported || this.lastBlock.trim() === reported) break;
      await sleep(POLL_MS);
    }
    const before = this.assistantEntries;
    await sleep(HOOK_BLOCK_GRACE_MS);
    events.push(...(await this.read()));
    return { events, holds: this.assistantEntries === before };
  }
}

/**
 * The prompt as it goes on the command line. Through a `.cmd` shim the whole
 * command line is cmd.exe's to parse, and a task is outside text - a mail can
 * carry quotes, `&` or `%VAR%`. It never goes on that line: the file holds
 * it, the line only points there. Long prompts take the same way out.
 */
async function promptArgument(spec: TuiSpawnSpec): Promise<string | undefined> {
  const { prompt } = spec;
  if (prompt === undefined) return undefined;
  if (prompt.length <= INLINE_PROMPT_LIMIT && !spec.binary.isShim) return prompt;
  const file = join(spec.workDir, 'task.md');
  await writeFile(file, prompt);
  return (
    'Your task is written down in the file ' +
    forwardSlashes(file) +
    ' - read all of it first, then do exactly what it says.'
  );
}

function spawnPty(pty: PtyModule, spec: TuiSpawnSpec, argv: string[]): PtyProcess {
  const env = childEnv(spec.env);
  const options = {
    name: TERM,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env,
  };
  return spec.binary.isShim
    ? pty.spawn(env.COMSPEC ?? 'cmd.exe', '/d /s /c ' + quoteForCmd([spec.binary.path, ...argv]), options)
    : pty.spawn(spec.binary.path, argv, options);
}

/** Down to "Yes", then Enter - the same two keys a person presses. */
function answerDialog(child: PtyProcess, watch: TerminalWatch, keys: string): void {
  // The process may be gone by the time a key is due; a write to it would throw.
  const press = (data: string): void => {
    if (watch.exitCode === null) child.write(data);
  };
  setTimeout(() => {
    press(keys);
    setTimeout(() => press('\r'), DIALOG_KEY_DELAY_MS);
  }, DIALOG_KEY_DELAY_MS);
}

/** A listener for the child's output that answers each first-run dialog once, when it shows up. */
function startupDialogAnswerer(child: PtyProcess, watch: TerminalWatch): (data: string) => void {
  let screen = '';
  const answered = new Set<string>();
  return (data) => {
    if (answered.size === STARTUP_DIALOGS.length) return;
    screen = (screen + data).slice(-DIALOG_SCREEN_TAIL);
    const flat = flatten(screen);
    for (const dialog of STARTUP_DIALOGS) {
      if (answered.has(dialog.marker) || !flat.includes(dialog.marker)) continue;
      answered.add(dialog.marker);
      answerDialog(child, watch, dialog.keys);
    }
  };
}

/** Starts Claude Code in a pty and registers it. Throws only before the process exists. */
async function spawnTerminal(spec: TuiSpawnSpec, resumed: boolean): Promise<TerminalWatch> {
  const pty = await loadPty();
  if (!pty) throw new Error('Terminal support is not available on this system.');

  const prompt = await promptArgument(spec);
  const argv = prompt !== undefined ? [...spec.args, prompt] : spec.args;
  // This is Rookery's terminal, not the person's own `claude`: a model picked
  // here with Enter must not become their global default.
  const release = userSettingsGuard.acquire(configDir(spec.env));
  let child: PtyProcess;
  try {
    child = spawnPty(pty, spec, argv);
  } catch (error) {
    release();
    throw error;
  }

  const watch = new TerminalWatch(spec, resumed);
  const answerDialogs = startupDialogAnswerer(child, watch);
  child.onExit((event) => {
    watch.exitCode = event.exitCode;
  });
  child.onData((data) => {
    watch.screenPainted();
    answerDialogs(data);
  });
  tuiSessions.attach(
    spec.key,
    child,
    spec.sessionId,
    () => {
      release();
      spec.cleanup();
    },
    spec.lingerMs,
  );
  return watch;
}

/** Whether the terminal a watch belongs to is still the one registered under its key. */
function stillOpen(watch: TerminalWatch): boolean {
  return watch.exitCode === null && tuiSessions.info(watch.spec.key)?.providerSessionId === watch.spec.sessionId;
}

/**
 * Keeps reading while a finished run's terminal lingers, so what a person
 * does in it reaches the run's transcript too - and one last time after the
 * process is gone, for whatever it wrote on the way out.
 */
async function followLate(watch: TerminalWatch, onEvent: (event: AgentEvent) => void): Promise<void> {
  const deliver = async (): Promise<void> => {
    try {
      for (const event of await watch.read()) onEvent(event);
    } catch {
      // A transcript that cannot be read now is read on the next pass.
    }
  };
  while (stillOpen(watch)) {
    await sleep(LATE_POLL_MS);
    await deliver();
  }
  await sleep(LATE_POLL_MS);
  await deliver();
}

const IDLE_MESSAGE =
  'The terminal showed no activity for ' +
  IDLE_LIMIT_MS / MINUTE_MS +
  ' minutes - it was most likely waiting for an answer nobody gave.';

/**
 * Runs Claude Code in a pty and yields what a print run would have yielded.
 * Throws only before the process exists; afterwards failures are events.
 */
export async function* runTui(spec: TuiRunSpec): AsyncGenerator<AgentEvent, void, unknown> {
  const watch = await spawnTerminal(spec, false);
  const started = Date.now();
  let finished = false;

  try {
    yield { type: 'status', label: 'terminal', detail: 'Claude Code is running in a terminal.' };

    while (true) {
      if (spec.signal?.aborted) return;
      await sleep(POLL_MS);
      yield* await watch.read();

      const payload = await watch.marker();
      if (payload) {
        const reported = reportedMessage(payload);
        const { events, holds } = await watch.settle(reported);
        yield* events;
        if (!holds) {
          await watch.clearMarker();
          continue;
        }
        if (watch.apiError) {
          yield fatalError(watch.apiError);
          return;
        }
        finished = true;
        yield {
          type: 'done',
          text: reported || watch.lastBlock,
          providerSessionId: spec.sessionId,
          usage: watch.usage(started),
        };
        return;
      }

      if (Date.now() - watch.lastActivity > IDLE_LIMIT_MS) {
        yield fatalError(IDLE_MESSAGE);
        return;
      }

      if (watch.exitCode !== null) {
        yield* await watch.read();
        yield fatalError(
          watch.apiError ?? 'Claude Code closed its terminal (exit code ' + watch.exitCode + ') before finishing.',
        );
        return;
      }
    }
  } finally {
    // Done: keep the terminal for a while, and keep listening to it. Anything
    // else - cancelled, timed out, failed, or the consumer walking away - ends
    // it now.
    if (finished) {
      tuiSessions.linger(spec.key);
      if (spec.onLateEvent) void followLate(watch, spec.onLateEvent);
    } else {
      tuiSessions.kill(spec.key);
    }
  }
}

/* ------------------------------ conversations ------------------------------ */

/** One exchange in a conversation terminal: what was typed, and the answer. */
export interface TuiTurn {
  prompt: string;
  answer: string;
  /**
   * What happened in between, as a print run would have streamed it - text,
   * thinking and tool calls in order - so the conversation can store the
   * turn with its tool calls rather than as bare text.
   */
  events: AgentEvent[];
  /** The model that answered. */
  model?: string;
  providerSessionId: string;
  usage: { durationMs: number; contextTokens?: number };
}

/** A turn Rookery typed in itself, and how it ended. */
export interface SubmittedTurn extends TuiTurn {
  /** Stopped with Esc before Claude Code said it was done. */
  interrupted?: boolean;
  /** What went wrong, when it did: an API error, a message the terminal never took. */
  error?: string;
}

export interface TuiConversationHandlers {
  /** After every answer to something a person typed into the terminal itself. */
  onTurn(turn: TuiTurn): void;
  /** The process is gone, however it ended. */
  onExit(): void;
}

/** A conversation terminal nobody has used for this long is closed. */
const CONVERSATION_IDLE_MS = 60 * MINUTE_MS;

/** How long `whenIdle` waits for the work to end before it gives up waiting. */
const WHEN_IDLE_LIMIT_MS = 10 * MINUTE_MS;

/** Screen silence that means the TUI sits at its prompt, ready for keys. */
const READY_QUIET_MS = 800;
/** A terminal younger than this is still setting up, however quiet it looks. */
const SETUP_MS = 1500;
/** A fresh terminal paints, answers its dialogs and settles within this. */
const READY_LIMIT_MS = 30_000;
/** How many times a panel left open is closed with Esc before the wait goes on regardless. */
const MAX_PANEL_CLOSES = 3;

/** How long a slash command may stay out of the transcript before it counts as the terminal's own business. */
const ACCEPT_LIMIT_MS = 15_000;
/** How long a typed message may take to show up in the transcript before it is an error. */
const ACCEPT_DEADLINE_MS = 2 * ACCEPT_LIMIT_MS;
/** How often an unconfirmed message is looked after: Enter again, or typed again. */
const ACCEPT_RETRY_MS = 3000;
/** How much of a message identifies it on the screen. */
const SNIPPET_LENGTH = 24;

/** A command that ran this long, with the screen quiet for the next, has said all it will say. */
const COMMAND_MIN_RUN_MS = 2500;
const COMMAND_QUIET_MS = 1500;
const COMMAND_POLL_MS = 2 * POLL_MS;

/** How long an interrupted turn gets to write what it had before it is read as is. */
const INTERRUPT_SETTLE_MS = 1500;

/** Enter comes on its own write, this long after the message. */
const ENTER_DELAY_MS = 200;

const FIRST_RUN_DIALOG_HINT = /trust this folder|yes, i accept/i;
const PANEL_HINT = /esc to (cancel|close|exit)/i;

/**
 * A panel or menu is open and waiting for Esc. Not the first-run dialogs:
 * Esc there declines the folder and Claude Code quits.
 */
function hasOpenPanel(screen: string): boolean {
  if (FIRST_RUN_DIALOG_HINT.test(screen)) return false;
  return PANEL_HINT.test(screen);
}

/** The screen a command left, as text for the chat: without the hint lines and the empty tail. */
function commandOutput(screen: string, command: string): string {
  const lines = screen.split('\n');
  // Only what came after the command line itself, not the conversation above it.
  const at = lines.map((line) => line.includes(command)).lastIndexOf(true);
  return lines
    .slice(at + 1)
    .filter((line) => !PANEL_HINT.test(line))
    .join('\n')
    .replace(/\s+$/, '')
    .replace(/^\s*\n/, '');
}

/** Lines Claude Code draws under its input box, and only there. */
const INPUT_FOOTERS = ['shift+tab to cycle', 'for shortcuts'];

/**
 * The `UserPromptSubmit` hook of a conversation terminal: whatever Rookery
 * wrote into the context file for this one message goes to Claude Code as
 * `additionalContext`, and the file is emptied so the next message - typed in
 * the terminal by a person, say - does not get it again. Single quotes only:
 * the command runs through whichever shell Claude Code picks.
 */
export function promptContextHookCommand(contextFile: string): string {
  const node = forwardSlashes(process.execPath);
  const target = quotedInScript(contextFile);
  const script =
    "const fs=require('fs');const f='" + target + "';let t='';" +
    "try{t=fs.readFileSync(f,'utf8');fs.writeFileSync(f,'')}catch(e){}" +
    "if(t.trim())process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:t}}))";
  return `"${node}" -e "${script}"`;
}

/** The context file of a conversation terminal, next to its Stop marker. */
export function contextFileFor(workDir: string): string {
  return join(workDir, 'context.md');
}

interface PendingTurn {
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  events: AgentEvent[];
  started: number;
  /** The typed message has shown up in the transcript. */
  accepted: boolean;
  done: (turn: SubmittedTurn) => void;
}

export interface SubmitInput {
  prompt: string;
  /** Handed to Claude Code for this message only, through the prompt hook. */
  context?: string;
  onEvent: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

/**
 * One conversation, one Claude Code process. A person may type into it from
 * the terminal view, and Rookery types into it for every chat message - from
 * the web, from Telegram, or a report-back from work handed off earlier. What
 * Rookery typed comes back to the caller of `submit`; what a person typed
 * comes back through `onTurn`. Both are the same process and the same
 * transcript, which is the point: the chat and the terminal are one
 * conversation, not two views taking turns writing to it.
 */
export class ConversationTerminal {
  #pending: PendingTurn | null = null;
  /** Submissions run one after another, never interleaved. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #spawned = Date.now();
  /** Prompts a person typed since the last answer, and what came of them. */
  #typed: string[] = [];
  #typedEvents: AgentEvent[] = [];
  #typedStarted = Date.now();

  constructor(
    readonly watch: TerminalWatch,
    readonly handlers: TuiConversationHandlers,
  ) {}

  get key(): string {
    return this.watch.spec.key;
  }

  get providerSessionId(): string {
    return this.watch.spec.sessionId;
  }

  alive(): boolean {
    return stillOpen(this.watch);
  }

  /** Whether a submitted message is being answered right now. */
  get busy(): boolean {
    return this.#pending !== null;
  }

  close(): void {
    tuiSessions.kill(this.key);
  }

  /** Nothing being answered right now, neither a submitted message nor a typed one. */
  async whenIdle(limitMs = WHEN_IDLE_LIMIT_MS): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline && this.alive()) {
      if (this.#pending === null && !this.#working()) return;
      await sleep(POLL_MS);
    }
  }

  /**
   * Type one message into the terminal and wait for its answer. `context`
   * reaches Claude Code through the `UserPromptSubmit` hook rather than as
   * part of the message, so the transcript - and the terminal a person may be
   * watching - shows exactly what was said, nothing Rookery added.
   */
  submit(input: SubmitInput): Promise<SubmittedTurn> {
    const run = this.#queue.then(() => this.#submit(input));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #submit(input: SubmitInput): Promise<SubmittedTurn> {
    if (!this.alive()) return this.#refused(input, 'The terminal is closed.');
    await this.#ready(input.signal);
    if (input.signal?.aborted) return this.#refused(input, 'Cancelled before it was sent.');
    if (!this.alive()) return this.#refused(input, 'The terminal closed before the message could be sent.');

    await writeFile(contextFileFor(this.watch.spec.workDir), input.context ?? '').catch(() => undefined);
    // A turn started while the Stop marker still holds the last answer would
    // end the moment it began.
    await this.watch.clearMarker();

    const { pending, ended } = this.#begin(input);
    tuiSessions.markRunning(this.key);
    this.#type(input.prompt);
    const stopListening = this.#interruptOnAbort(pending, input.signal);

    // A slash command or a `!` shell line is the terminal's own business: it
    // may never reach the model, so no Stop hook comes. Once the screen has
    // settled without a model turn starting, it is done - whatever it showed
    // is on the terminal, which is where a command's output lives anyway.
    if (/^[/!]/.test(input.prompt.trim())) void this.#settleCommand(pending);
    else void this.#ensureAccepted(pending);

    try {
      return await ended;
    } finally {
      stopListening();
    }
  }

  #refused(input: SubmitInput, error: string): SubmittedTurn {
    return {
      prompt: input.prompt,
      answer: '',
      events: [],
      providerSessionId: this.providerSessionId,
      usage: { durationMs: 0 },
      error,
    };
  }

  /** Makes the turn the one being answered; `ended` resolves when it is settled. */
  #begin(input: SubmitInput): { pending: PendingTurn; ended: Promise<SubmittedTurn> } {
    let pending!: PendingTurn;
    const ended = new Promise<SubmittedTurn>((resolve) => {
      pending = {
        prompt: input.prompt,
        onEvent: input.onEvent,
        events: [],
        started: Date.now(),
        accepted: false,
        done: resolve,
      };
    });
    this.#pending = pending;
    return { pending, ended };
  }

  /** Aborting presses Esc for the turn; the returned function stops listening. */
  #interruptOnAbort(pending: PendingTurn, signal?: AbortSignal): () => void {
    const onAbort = (): void => {
      // Esc is what a person presses: Claude Code stops, keeps what it had,
      // and writes no Stop payload - so the turn is closed here instead.
      tuiSessions.write(this.key, ESC);
      setTimeout(() => void this.#interrupted(pending), INTERRUPT_SETTLE_MS);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return () => signal?.removeEventListener('abort', onAbort);
  }

  /** Ends a slash command's turn once its screen has gone quiet, or when it has run too long to be one. */
  async #settleCommand(pending: PendingTurn): Promise<void> {
    const command = pending.prompt.trim();
    const typedAt = Date.now();
    while (this.#pending === pending && !pending.accepted && Date.now() - typedAt < ACCEPT_LIMIT_MS) {
      await sleep(COMMAND_POLL_MS);
      const ranFor = Date.now() - typedAt;
      const quietFor = Date.now() - this.watch.lastScreen;
      if (ranFor <= COMMAND_MIN_RUN_MS || quietFor <= COMMAND_QUIET_MS || pending.accepted) continue;
      // What the command put on the screen is its answer - the chat
      // cannot see the terminal, so `/cost` there shows the costs. A
      // panel it opened is closed again, or the next message would be
      // typed into it.
      const screen = tuiSessions.screenText(this.key) ?? '';
      const output = commandOutput(screen, command);
      // Fenced: a panel is laid out in columns, and markdown would reflow it.
      this.#settle(pending, { answer: output ? '```\n' + output + '\n```' : '' });
      if (hasOpenPanel(screen)) tuiSessions.write(this.key, ESC);
      return;
    }
    // Still running past the limit (a command that started real work
    // settles through the Stop hook instead): never leave it hanging.
    if (this.#pending === pending && !pending.accepted) this.#settle(pending, { answer: '' });
  }

  /**
   * The message has to arrive. Every few seconds without it in the
   * transcript, the screen says why: the text sits in the input box (a
   * paste the TUI held on to) and gets another Enter, or it is not there at
   * all (keys swallowed while the TUI was still setting up) and is typed
   * again. Past the limit it is an error, not a turn waiting for ever.
   */
  async #ensureAccepted(pending: PendingTurn): Promise<void> {
    const typedAt = Date.now();
    const snippet = pending.prompt.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LENGTH);
    while (Date.now() - typedAt < ACCEPT_DEADLINE_MS) {
      await sleep(ACCEPT_RETRY_MS);
      if (this.#pending !== pending || pending.accepted) return;
      const screen = tuiSessions.screenText(this.key);
      const waiting = screen === null || screen.includes('[Pasted text') || screen.replace(/\s+/g, ' ').includes(snippet);
      if (waiting) tuiSessions.write(this.key, '\r');
      else this.#type(pending.prompt);
    }
    if (this.#pending !== pending || pending.accepted) return;
    this.#settle(pending, { error: 'The terminal did not take the message.' });
  }

  /** Claude Code is working: its terminal says so, or a person's message awaits its answer. */
  #working(): boolean {
    return tuiSessions.info(this.key)?.state === 'running' || this.#typed.length > 0;
  }

  /**
   * Wait until the TUI sits at its prompt: not working, quiet for a moment,
   * and - where the screen can be read - showing the footer Claude Code only
   * draws under a live input box. Quiet alone was not enough: a fresh
   * terminal pauses while its startup hooks run, and keys typed into that
   * pause are swallowed.
   */
  async #ready(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + READY_LIMIT_MS;
    let closed = 0;
    while (Date.now() < deadline && !signal?.aborted && this.alive()) {
      const resting =
        !this.#working() &&
        Date.now() - this.#spawned > SETUP_MS &&
        Date.now() - this.watch.lastScreen > READY_QUIET_MS;
      const screen = tuiSessions.screenText(this.key);
      const atPrompt = screen === null || INPUT_FOOTERS.some((footer) => screen.includes(footer));
      if (resting && atPrompt) return;
      // A panel left open - by a command typed in the terminal, say - sits
      // where the input box would be. Esc closes it, as a person would.
      if (resting && screen !== null && hasOpenPanel(screen) && closed < MAX_PANEL_CLOSES) {
        closed += 1;
        tuiSessions.write(this.key, ESC);
        await sleep(READY_QUIET_MS);
      }
      await sleep(POLL_MS);
    }
  }

  /** The message as keystrokes: pasted whole where the TUI allows it, then Enter. */
  #type(prompt: string): void {
    const body = tuiSessions.pasteMode(this.key) ? PASTE_START + prompt + PASTE_END : prompt.replace(/\r?\n/g, ' ');
    tuiSessions.write(this.key, body);
    // Enter on its own write, a beat later: in the same chunk the TUI can read
    // it as part of the paste rather than as the key that sends it.
    setTimeout(() => tuiSessions.write(this.key, '\r'), ENTER_DELAY_MS);
  }

  async #interrupted(pending: PendingTurn): Promise<void> {
    if (this.#pending !== pending) return;
    for (const event of await this.watch.read().catch(() => [] as AgentEvent[])) this.take(event);
    this.#settle(pending, { interrupted: true });
  }

  #settle(pending: PendingTurn, extra: { answer?: string; interrupted?: boolean; error?: string }): void {
    if (this.#pending !== pending) return;
    this.#pending = null;
    pending.done({
      ...this.#turn(pending.prompt, extra.answer ?? lastTextBlock(pending.events), pending.events, pending.started),
      ...(extra.interrupted ? { interrupted: true } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    });
    tuiSessions.linger(this.key);
  }

  #turn(prompt: string, answer: string, events: AgentEvent[], startedAt: number): TuiTurn {
    return {
      prompt,
      answer,
      events,
      ...(this.watch.model ? { model: this.watch.model } : {}),
      providerSessionId: this.providerSessionId,
      usage: this.watch.usage(startedAt),
    };
  }

  /** From the read loop: one transcript event, for the submitted turn if there is one. */
  take(event: AgentEvent): void {
    if (event.type === 'status' && event.label === 'input' && event.detail) {
      this.#takeInput(event.detail);
      return;
    }
    if (event.type !== 'text' && event.type !== 'thinking' && event.type !== 'tool') return;
    const pending = this.#pending;
    if (!pending) {
      this.#typedEvents.push(event);
      return;
    }
    pending.accepted = true;
    pending.events.push(event);
    pending.onEvent(event);
  }

  #takeInput(text: string): void {
    const pending = this.#pending;
    if (pending) {
      // The first message after a submission is the one Rookery typed.
      pending.accepted = true;
      return;
    }
    if (this.#typed.length === 0 && this.#typedEvents.length === 0) this.#typedStarted = Date.now();
    this.#typed.push(text);
    tuiSessions.markRunning(this.key);
  }

  /** From the read loop: the Stop hook fired and the transcript caught up. */
  stopped(reported: string): void {
    const pending = this.#pending;
    if (pending) {
      if (this.watch.apiError) this.#settle(pending, { error: this.watch.apiError });
      else this.#settle(pending, { answer: reported || this.watch.lastBlock });
      return;
    }
    const answer = reported || this.watch.lastBlock;
    if (this.#typed.length || answer) {
      this.handlers.onTurn(this.#turn(this.#typed.join('\n\n'), answer, this.#typedEvents, this.#typedStarted));
    }
    this.#typed = [];
    this.#typedEvents = [];
    // Answered: waiting for the person again.
    tuiSessions.linger(this.key);
  }

  /** From the read loop: the process is gone, and a turn still waiting on it ends. */
  exited(): void {
    const pending = this.#pending;
    if (pending) this.#settle(pending, { error: this.watch.apiError ?? 'Claude Code closed its terminal before answering.' });
  }
}

/**
 * Reads a conversation terminal's transcript and Stop marker until the
 * process is gone, handing everything to `terminal`.
 */
async function followConversation(
  watch: TerminalWatch,
  terminal: ConversationTerminal,
  handlers: TuiConversationHandlers,
): Promise<void> {
  try {
    while (stillOpen(watch)) {
      await sleep(POLL_MS);
      for (const event of await watch.read()) terminal.take(event);
      const payload = await watch.marker();
      if (payload) {
        const reported = reportedMessage(payload);
        const settled = await watch.settle(reported);
        for (const event of settled.events) terminal.take(event);
        await watch.clearMarker();
        if (!settled.holds) continue;
        terminal.stopped(reported);
      }
      if (Date.now() - watch.lastActivity > CONVERSATION_IDLE_MS) tuiSessions.kill(watch.spec.key);
    }
  } catch {
    // A read that throws past its own guards ends the watch, not the server.
  } finally {
    // With no watch nobody reads the answers: the process goes with it, so
    // `onExit` below tells the truth.
    if (stillOpen(watch)) tuiSessions.kill(watch.spec.key);
    terminal.exited();
    handlers.onExit();
  }
}

/**
 * Opens a conversation in Claude Code's own terminal. There is no task and
 * no end: a person or Rookery types, Claude answers. It runs until somebody
 * closes it, or until nobody has used it for an hour; the next message then
 * starts it again on the same session.
 */
export async function startConversationTerminal(
  spec: TuiSpawnSpec,
  resumed: boolean,
  handlers: TuiConversationHandlers,
): Promise<ConversationTerminal> {
  const watch = await spawnTerminal({ ...spec, lingerMs: CONVERSATION_IDLE_MS }, resumed);
  const terminal = new ConversationTerminal(watch, handlers);
  // A conversation terminal waits for its person first - idle, not working,
  // and closed by itself after an hour of nobody typing.
  tuiSessions.linger(spec.key);
  void followConversation(watch, terminal, handlers);
  return terminal;
}
