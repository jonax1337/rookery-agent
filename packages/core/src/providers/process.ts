import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter, extname, join } from 'node:path';
import { accessSync, constants } from 'node:fs';

/**
 * Spawning CLI shims portably.
 *
 * On Windows, npm-installed binaries are `.cmd` shims. Since the Node
 * security fix for CVE-2024-27980, spawning a `.cmd` without a shell throws
 * EINVAL, so those have to go through `cmd.exe /d /s /c` with verbatim
 * arguments. Native `.exe` binaries are spawned directly.
 */

const IS_WINDOWS = process.platform === 'win32';

export interface ResolvedBinary {
  /** Absolute path to the file that was found on PATH. */
  path: string;
  /** True when it needs the cmd.exe wrapper. */
  isShim: boolean;
}

/**
 * Find an executable on PATH without shelling out.
 * Prefers a real executable over a script shim so we avoid cmd.exe when we can.
 */
export function resolveBinary(name: string): ResolvedBinary | null {
  const pathValue = process.env.PATH ?? '';
  const dirs = pathValue.split(delimiter).filter(Boolean);
  // Order matters: .exe/.com run directly, .cmd/.bat need the shell wrapper.
  const extensions = IS_WINDOWS ? ['.exe', '.com', '.cmd', '.bat', ''] : [''];

  for (const ext of extensions) {
    for (const dir of dirs) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        const suffix = extname(candidate).toLowerCase();
        return { path: candidate, isShim: suffix === '.cmd' || suffix === '.bat' };
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface SpawnOptions {
  /** Keep the pipe open for CLI control-protocol requests. */
  interactive?: boolean;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin, then stdin is closed. */
  stdin?: string;
  signal?: AbortSignal;
}

export interface SpawnHandle {
  child: ChildProcessWithoutNullStreams;
  /** Resolves with the exit code and everything written to stderr. */
  done: Promise<{ code: number | null; stderr: string }>;
}

/** Provider CLIs can be chatty about MCP warnings; only the tail of stderr is kept. */
const STDERR_TAIL_CHARS = 8000;

/**
 * Spawn a resolved CLI, wiring stdin and collecting stderr.
 * The caller consumes `child.stdout` (usually via `readJsonLines`).
 */
export function spawnCli(binary: ResolvedBinary, options: SpawnOptions): SpawnHandle {
  const { args, cwd, env, stdin, signal } = options;
  const { command, spawnArgs, verbatim } = commandLineFor(binary, args);

  const child = spawn(command, spawnArgs, {
    cwd,
    env: { ...process.env, ...env },
    windowsVerbatimArguments: verbatim,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });

  if (signal) killOnAbort(child, signal);

  if (stdin !== undefined) {
    child.stdin.on('error', () => {
      // The child may exit before we finish writing; not fatal.
    });
    child.stdin.end(stdin, 'utf8');
  } else if (!options.interactive) {
    child.stdin.end();
  }

  const done = new Promise<{ code: number | null; stderr: string }>((resolvePromise, reject) => {
    child.on('error', (error) => reject(error));
    child.on('close', (code) => resolvePromise({ code, stderr }));
  });

  return { child, done };
}

function commandLineFor(
  binary: ResolvedBinary,
  args: string[],
): { command: string; spawnArgs: string[]; verbatim: boolean } {
  if (!binary.isShim) return { command: binary.path, spawnArgs: args, verbatim: false };
  // cmd.exe needs the whole command line quoted by us, verbatim.
  return {
    command: process.env.COMSPEC ?? 'cmd.exe',
    spawnArgs: ['/d', '/s', '/c', quoteForCmd([binary.path, ...args])],
    verbatim: true,
  };
}

/** The listener goes with the child, so a long-lived signal does not keep every finished process reachable. */
function killOnAbort(child: ChildProcessWithoutNullStreams, signal: AbortSignal): void {
  if (signal.aborted) {
    child.kill();
    return;
  }
  const kill = (): void => {
    child.kill();
  };
  signal.addEventListener('abort', kill, { once: true });
  child.once('close', () => signal.removeEventListener('abort', kill));
}

/** Quote an argv for cmd.exe verbatim mode. */
export function quoteForCmd(argv: string[]): string {
  return argv
    .map((arg) => {
      if (arg === '') return '""';
      // MSVCRT rules: a quote is escaped as \", and any run of backslashes
      // right before a quote (or the end of a quoted arg) is doubled. Then wrap
      // anything with whitespace or shell metachars.
      const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
      return /[\s&|<>^"()]/.test(arg) ? '"' + escaped + '"' : escaped;
    })
    .join(' ');
}

/**
 * Turn a readable stream of newline-delimited JSON into parsed objects.
 * Malformed lines are skipped rather than aborting the turn - provider CLIs
 * occasionally interleave a plain-text warning into stdout.
 */
export async function* readJsonLines(
  stream: NodeJS.ReadableStream,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  let buffer = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream as AsyncIterable<string>) {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const parsed = tryParse(line);
        if (parsed) yield parsed;
      }
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) {
    const parsed = tryParse(tail);
    if (parsed) yield parsed;
  }
}

function tryParse(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{') && !line.startsWith('[')) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const CAPTURE_TIMEOUT_MS = 15000;
const STDOUT_TAIL_CHARS = 16000;

/** Run a short-lived command and capture stdout. Used for version/auth probes. */
export async function runCapture(
  binary: ResolvedBinary,
  args: string[],
  timeoutMs = CAPTURE_TIMEOUT_MS,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const handle = spawnCli(binary, { args, signal: controller.signal, env });

  let stdout = '';
  handle.child.stdout.setEncoding('utf8');
  handle.child.stdout.on('data', (chunk: string) => {
    stdout = (stdout + chunk).slice(-STDOUT_TAIL_CHARS);
  });

  try {
    const { code, stderr } = await handle.done;
    return { code, stdout, stderr };
  } catch (error) {
    return { code: null, stdout, stderr: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
