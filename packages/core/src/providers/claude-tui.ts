import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentEvent } from '../types.js';
import { quoteForCmd, type ResolvedBinary } from './process.js';

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

/** How much screen output a late viewer gets replayed, in characters. */
const REPLAY_LIMIT = 1_000_000;

/** How long a finished agent's terminal stays open before it is killed. */
export const TUI_LINGER_MS = 10 * 60 * 1000;

/** A size that fits the run page; the browser resizes to its own right away. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;

/** Longer prompts go to a file: argv on Windows ends at 32 767 characters. */
const INLINE_PROMPT_LIMIT = 12_000;

/**
 * No screen output and no transcript growth for this long means the terminal
 * waits for input nobody is giving - a permission question, or a run that
 * was interrupted with Esc and never told what to do next. Until then a
 * person can still answer it from the run page.
 */
const IDLE_LIMIT_MS = 15 * 60 * 1000;

/** How long the transcript may trail the Stop hook before it is read as is. */
const SETTLE_LIMIT_MS = 3000;

const POLL_MS = 250;

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

class TuiSession {
  buffer = '';
  lingerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly info: TuiSessionInfo,
    readonly pty: PtyProcess,
    readonly cleanup: () => void,
    readonly lingerMs: number,
  ) {}
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
    pty.onData((data) => {
      if (this.#sessions.get(key) !== session) return;
      session.buffer = (session.buffer + data).slice(-REPLAY_LIMIT);
      this.emit('data', key, data);
    });
    pty.onExit(() => {
      clearTimeout(session.lingerTimer);
      session.cleanup();
      if (this.#sessions.get(key) !== session) return;
      this.#sessions.delete(key);
      session.info.state = 'exited';
      this.emit('state', { ...session.info });
      this.emit('exit', key);
    });
    this.emit('state', { ...session.info });
  }

  info(key: string): TuiSessionInfo | null {
    const session = this.#sessions.get(key);
    return session ? { ...session.info } : null;
  }

  list(): TuiSessionInfo[] {
    return [...this.#sessions.values()].map((session) => ({ ...session.info }));
  }

  /** The screen so far, for a viewer that opens the terminal late. */
  snapshot(key: string): { info: TuiSessionInfo; data: string } | null {
    const session = this.#sessions.get(key);
    return session ? { info: { ...session.info }, data: session.buffer } : null;
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
    const c = Math.max(20, Math.min(400, Math.floor(cols)));
    const r = Math.max(5, Math.min(200, Math.floor(rows)));
    if (c === session.info.cols && r === session.info.rows) return;
    try {
      session.pty.resize(c, r);
      session.info.cols = c;
      session.info.rows = r;
    } catch {
      // A pty that is exiting refuses a resize; nothing to keep.
    }
  }

  /** The work is over: the terminal stays open, then goes. */
  linger(key: string): void {
    const session = this.#sessions.get(key);
    if (!session) return;
    const ms = session.lingerMs;
    clearTimeout(session.lingerTimer);
    if (session.info.state !== 'idle') {
      session.info.state = 'idle';
      this.emit('state', { ...session.info });
    }
    session.lingerTimer = setTimeout(() => this.kill(key), ms);
    session.lingerTimer.unref?.();
  }

  kill(key: string): boolean {
    const session = this.#sessions.get(key);
    if (!session) return false;
    clearTimeout(session.lingerTimer);
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
}

export const tuiSessions = new TuiSessionRegistry();

/* --------------------------------- the run -------------------------------- */

export interface TuiRunSpec {
  /** Registry key - the assignment id. */
  key: string;
  binary: ResolvedBinary;
  /** Everything but the prompt. */
  args: string[];
  prompt: string;
  cwd?: string;
  /** Additions to the environment; inherited Claude Code markers are removed first. */
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Claude Code's session id, pinned with `--session-id` in `args`. */
  sessionId: string;
  /** A folder of this run's own; the prompt file goes here. */
  workDir: string;
  /** Where the Stop hook writes its payload. */
  markerFile: string;
  /** Turns one transcript entry into the events a print run would have sent. */
  mapEntry: (entry: Record<string, unknown>) => AgentEvent[];
  /** Runs once the process is gone - the temp folders go then, not earlier. */
  cleanup: () => void;
  lingerMs?: number;
}

/** The Stop hook's command: the payload on stdin, verbatim into the marker file. */
export function stopHookCommand(markerFile: string): string {
  const node = process.execPath.replace(/\\/g, '/');
  const target = markerFile.replace(/\\/g, '/').replace(/'/g, "\\'");
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
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

const ESC = String.fromCharCode(27);

/** Screen text without escape sequences and whitespace, for spotting a dialog. */
function flatten(screen: string): string {
  return screen
    .split(ESC)
    .join('')
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\s+/g, '');
}

/**
 * First-run dialogs a print run never shows, and the answer a person would
 * give. The folder is one Rookery already works in; the bypass warning only
 * appears for a `full` agent, which is a setting somebody chose.
 */
const STARTUP_DIALOGS: { marker: string; keys: string }[] = [
  { marker: 'Yes,Itrustthisfolder', keys: ESC + '[B' },
  { marker: 'Yes,Iaccept', keys: ESC + '[B' },
];

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
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Reads a growing JSONL file from where the last call stopped. */
class TranscriptTail {
  #offset = 0;
  #partial = '';
  readonly #seen = new Set<string>();

  constructor(readonly path: string) {}

  async read(): Promise<Record<string, unknown>[]> {
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch {
      return [];
    }
    try {
      const { size } = await handle.stat();
      if (size <= this.#offset) return [];
      const buffer = Buffer.alloc(size - this.#offset);
      await handle.read(buffer, 0, buffer.length, this.#offset);
      this.#offset = size;
      const text = this.#partial + buffer.toString('utf8');
      const lines = text.split('\n');
      this.#partial = lines.pop() ?? '';
      const entries: Record<string, unknown>[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const id = typeof entry.uuid === 'string' ? entry.uuid : undefined;
          if (id) {
            if (this.#seen.has(id)) continue;
            this.#seen.add(id);
          }
          entries.push(entry);
        } catch {
          // A torn line is completed by the next read; a broken one is skipped.
        }
      }
      return entries;
    } finally {
      await handle.close();
    }
  }
}

/**
 * Runs Claude Code in a pty and yields what a print run would have yielded.
 * Throws only before the process exists; afterwards failures are events.
 */
export async function* runTui(spec: TuiRunSpec): AsyncGenerator<AgentEvent, void, unknown> {
  const pty = await loadPty();
  if (!pty) throw new Error('Terminal support is not available on this system.');

  // Through a `.cmd` shim the whole command line is cmd.exe's to parse, and
  // a task is outside text - a mail can carry quotes, `&` or `%VAR%`. It
  // never goes on that line: the file holds it, the line only points there.
  let prompt = spec.prompt;
  if (prompt.length > INLINE_PROMPT_LIMIT || spec.binary.isShim) {
    const file = join(spec.workDir, 'task.md');
    await writeFile(file, prompt);
    prompt =
      'Your task is written down in the file ' +
      file.replace(/\\/g, '/') +
      ' - read all of it first, then do exactly what it says.';
  }

  const env = childEnv(spec.env);
  const argv = [...spec.args, prompt];
  const options = {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env,
  };
  const child = spec.binary.isShim
    ? pty.spawn(env.COMSPEC ?? 'cmd.exe', '/d /s /c ' + quoteForCmd([spec.binary.path, ...argv]), options)
    : pty.spawn(spec.binary.path, argv, options);

  let exitCode: number | null = null;
  let screen = '';
  let lastActivity = Date.now();
  const answered = new Set<string>();
  child.onExit((event) => {
    exitCode = event.exitCode;
  });
  child.onData(() => {
    lastActivity = Date.now();
  });
  child.onData((data) => {
    if (answered.size === STARTUP_DIALOGS.length) return;
    screen = (screen + data).slice(-20_000);
    const flat = flatten(screen);
    for (const dialog of STARTUP_DIALOGS) {
      if (answered.has(dialog.marker) || !flat.includes(dialog.marker)) continue;
      answered.add(dialog.marker);
      // Down to "Yes", then Enter - the same two keys a person presses.
      setTimeout(() => {
        child.write(dialog.keys);
        setTimeout(() => child.write('\r'), 150);
      }, 150);
    }
  });
  tuiSessions.attach(spec.key, child, spec.sessionId, spec.cleanup, spec.lingerMs);

  const started = Date.now();
  const root = configDir(spec.env);
  let tail: TranscriptTail | null = null;
  /** The newest text block - what a print run reports as its result. */
  let lastBlock = '';
  /** Assistant entries read so far; growth after a Stop means work went on. */
  let assistantEntries = 0;
  let apiError: string | null = null;
  let contextTokens: number | undefined;
  let finished = false;

  async function* drain(): AsyncGenerator<AgentEvent> {
    if (!tail) {
      const path = await findTranscript(root, spec.sessionId);
      if (path) tail = new TranscriptTail(path);
    }
    if (!tail) return;
    for (const entry of await tail.read()) {
      lastActivity = Date.now();
      if (entry.isSidechain === true) continue;
      if (entry.type === 'assistant') {
        assistantEntries += 1;
        const message = entry.message as Record<string, unknown> | undefined;
        const usage = message?.usage as Record<string, unknown> | undefined;
        if (usage) {
          const parts = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].filter(
            (value): value is number => typeof value === 'number',
          );
          if (parts.length) contextTokens = parts.reduce((sum, value) => sum + value, 0);
        }
        if (entry.isApiErrorMessage === true) {
          const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
          apiError =
            content
              .map((block) => (typeof block.text === 'string' ? block.text : ''))
              .join(' ')
              .trim() || 'The API returned an error.';
          continue;
        }
        apiError = null;
      }
      for (const event of spec.mapEntry(entry)) {
        if (event.type === 'text') lastBlock = event.delta.replace(/^\n\n/, '');
        yield event;
      }
    }
  }

  try {
    yield { type: 'status', label: 'terminal', detail: 'Claude Code is running in a terminal.' };

    while (true) {
      if (spec.signal?.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      yield* drain();

      let payload: Record<string, unknown> | null = null;
      try {
        const raw = await readFile(spec.markerFile, 'utf8');
        if (raw.trim()) payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // Missing or half-written: not stopped yet.
      }

      if (payload) {
        const reported =
          typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
        // The transcript can trail the hook: read until the message the hook
        // reported is in it, or the settle time is up.
        for (let waited = 0; waited < SETTLE_LIMIT_MS; waited += POLL_MS) {
          yield* drain();
          if (!reported || lastBlock.trim() === reported) break;
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        // A Stop hook of the person's own may have answered "block": then
        // Claude Code keeps working, and this stop was not the end. New
        // assistant entries a moment later say so.
        const before = assistantEntries;
        await new Promise((resolve) => setTimeout(resolve, 4 * POLL_MS));
        yield* drain();
        if (assistantEntries > before) {
          await writeFile(spec.markerFile, '').catch(() => undefined);
          continue;
        }
        if (apiError) {
          yield { type: 'error', message: apiError, fatal: true };
          return;
        }
        const text = reported || lastBlock;
        finished = true;
        yield {
          type: 'done',
          text,
          providerSessionId: spec.sessionId,
          usage: {
            durationMs: Date.now() - started,
            ...(contextTokens !== undefined ? { contextTokens } : {}),
          },
        };
        return;
      }

      if (Date.now() - lastActivity > IDLE_LIMIT_MS) {
        yield {
          type: 'error',
          message:
            'The terminal showed no activity for 15 minutes - it was most likely waiting for an answer nobody gave.',
          fatal: true,
        };
        return;
      }

      if (exitCode !== null) {
        yield* drain();
        yield {
          type: 'error',
          message: apiError ?? 'Claude Code closed its terminal (exit code ' + exitCode + ') before finishing.',
          fatal: true,
        };
        return;
      }
    }
  } finally {
    // Done: keep the terminal for a while. Anything else - cancelled, timed
    // out, failed, or the consumer walking away - ends it now.
    if (finished) tuiSessions.linger(spec.key);
    else tuiSessions.kill(spec.key);
  }
}
