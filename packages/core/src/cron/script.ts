import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { CronJob, CronScript } from '../types.js';
import { resolveBinary } from '../providers/process.js';

const EXTENSIONS: Record<CronScript['runtime'], string[]> = {
  python: ['.py'], node: ['.js', '.mjs', '.cjs'], bash: ['.sh', '.bash'], powershell: ['.ps1'],
};
const OUTPUT_LIMIT = 64_000;
const STDERR_LIMIT = 8_000;
const PREVIEW_LIMIT_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 120_000;
/** Only OS/runtime essentials reach the script; never provider keys, gateway tokens or source .env files. */
const FORWARDED_ENV =
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|LANG|LC_ALL|APPDATA|LOCALAPPDATA)$/i;
const WINDOWS_STORE_STUB = /[\\/]Microsoft[\\/]WindowsApps[\\/]/i;
const FULL_ACCESS_REQUIRED = 'Review the imported script and grant Full access before running it.';

const isWindows = process.platform === 'win32';

export function validateCronScript(script: CronScript | undefined): void {
  if (!script || typeof script.path !== 'string' || !isAbsolute(script.path) ||
      !Object.hasOwn(EXTENSIONS, script.runtime) || !EXTENSIONS[script.runtime].includes(extname(script.path).toLowerCase()) ||
      (script.noAgent !== undefined && typeof script.noAgent !== 'boolean')) {
    throw new Error('A script schedule needs a supported script file and interpreter.');
  }
}

function managedScriptPath(home: string, script: CronScript): string {
  validateCronScript(script);
  const root = realpathSync(join(home, 'imported-scripts'));
  const path = realpathSync(script.path);
  const within = relative(root, path);
  if (!within || within.startsWith('..') || isAbsolute(within) || !statSync(path).isFile()) {
    throw new Error('The script must stay inside Rookery imported-scripts.');
  }
  return path;
}

export function readCronScript(home: string, script: CronScript): string {
  const path = managedScriptPath(home, script);
  if (statSync(path).size > PREVIEW_LIMIT_BYTES) throw new Error('The script is too large to preview; review the file locally.');
  return readFileSync(path, 'utf8');
}

/** Imported scripts run only after the user grants full access. This is not a sandbox. */
export async function runCronScript(home: string, job: CronJob, signal: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ output: string; silent: boolean }> {
  if (job.permission !== 'full') throw new Error(FULL_ACCESS_REQUIRED);
  validateCronScript(job.script);
  signal.throwIfAborted();
  const script = job.script!;
  const path = managedScriptPath(home, script);
  const binary = interpreterFor(script.runtime);
  const args = script.runtime === 'powershell' ? ['-NoProfile', '-NonInteractive', '-File', path] : [path];
  const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const { stdout, truncated } = await spawnScript(binary, args, path, script.runtime, signal, abort);
  const output = stdout.trim();
  const silent = (script.noAgent === true && !output) || asksToStayAsleep(output);
  return { output: truncated ? '[Script output truncated: only the last 64,000 characters are retained.]\n' + output : output, silent };
}

function interpreterFor(runtime: CronScript['runtime']): string {
  if (runtime === 'node') return process.execPath;
  const candidates =
    runtime === 'python' ? (isWindows ? ['python', 'python3'] : ['python3', 'python'])
      : runtime === 'powershell' ? ['pwsh', 'powershell']
        : [runtime];
  // A shim or the Microsoft Store stub opens an installer instead of running the script.
  const binary = candidates
    .map(resolveBinary)
    .find((entry) => entry && !entry.isShim && !(isWindows && WINDOWS_STORE_STUB.test(entry.path)))?.path;
  if (!binary) throw new Error('Install ' + runtime + ' and the imported script dependencies before running this schedule.');
  return binary;
}

function scriptEnvironment(runtime: CronScript['runtime']): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (FORWARDED_ENV.test(key)) env[key] = value;
  }
  if (runtime === 'python') {
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
  }
  return env;
}

/** The script's last stdout line may be JSON `{"wakeAgent": false}`; plain stdout is a valid result too. */
function asksToStayAsleep(output: string): boolean {
  try {
    const lastLine = JSON.parse(output.split(/\r?\n/).at(-1) ?? '') as { wakeAgent?: boolean } | null;
    return lastLine?.wakeAgent === false;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number, child: ChildProcess): void {
  if (isWindows) {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill('SIGKILL'));
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** Run the interpreter to completion; `abort` is the cancel-or-timeout signal, `cancelled` only the caller's. */
function spawnScript(
  binary: string,
  args: string[],
  scriptPath: string,
  runtime: CronScript['runtime'],
  cancelled: AbortSignal,
  abort: AbortSignal,
): Promise<{ stdout: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: dirname(scriptPath), env: scriptEnvironment(runtime), shell: false, windowsHide: true,
      detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > OUTPUT_LIMIT) truncated = true;
      stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_LIMIT); });
    const cancel = (): void => {
      if (child.pid) killProcessTree(child.pid, child);
    };
    abort.addEventListener('abort', cancel, { once: true });
    if (abort.aborted) cancel();
    child.on('error', (error) => { abort.removeEventListener('abort', cancel); reject(error); });
    child.on('close', (code) => {
      abort.removeEventListener('abort', cancel);
      if (abort.aborted) reject(new Error(cancelled.aborted ? 'The script run was cancelled.' : 'The script timed out.'));
      else if (code !== 0) reject(new Error('Script exited with code ' + code + ': ' + stderr.trim()));
      else resolve({ stdout, truncated });
    });
  });
}
