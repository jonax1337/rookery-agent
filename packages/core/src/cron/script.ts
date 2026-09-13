import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { CronJob, CronScript } from '../types.js';
import { resolveBinary } from '../providers/process.js';

const EXTENSIONS: Record<CronScript['runtime'], string[]> = {
  python: ['.py'], node: ['.js', '.mjs', '.cjs'], bash: ['.sh', '.bash'], powershell: ['.ps1'],
};
const OUTPUT_LIMIT = 64_000;

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
  if (statSync(path).size > 256_000) throw new Error('The script is too large to preview; review the file locally.');
  return readFileSync(path, 'utf8');
}

/** Imported scripts run only after the user grants full access. This is not a sandbox. */
export async function runCronScript(home: string, job: CronJob, signal: AbortSignal, timeoutMs = 120_000): Promise<{ output: string; silent: boolean }> {
  if (job.permission !== 'full') throw new Error('Review the imported script and grant Full access before running it.');
  validateCronScript(job.script);
  signal.throwIfAborted();
  const script = job.script!;
  const path = managedScriptPath(home, script);
  const candidates = script.runtime === 'python' ? (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
    : script.runtime === 'powershell' ? ['pwsh', 'powershell'] : [script.runtime];
  const binary = script.runtime === 'node' ? process.execPath
    : candidates.map(resolveBinary).find((entry) => entry && !entry.isShim && !(process.platform === 'win32' && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(entry.path)))?.path;
  if (!binary) throw new Error('Install ' + script.runtime + ' and the imported script dependencies before running this schedule.');
  const args = script.runtime === 'powershell' ? ['-NoProfile', '-NonInteractive', '-File', path] : [path];
  // Only OS/runtime essentials; never forward provider keys, gateway tokens or source .env files.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|LANG|LC_ALL|APPDATA|LOCALAPPDATA)$/i.test(key)) env[key] = value;
  }
  if (script.runtime === 'python') {
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
  }
  const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let truncated = false;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: dirname(path), env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > OUTPUT_LIMIT) truncated = true;
      stdout = (stdout + chunk).slice(-OUTPUT_LIMIT);
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8000); });
    const cancel = (): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    abort.addEventListener('abort', cancel, { once: true });
    if (abort.aborted) cancel();
    child.on('error', (error) => { abort.removeEventListener('abort', cancel); reject(error); });
    child.on('close', (code) => {
      abort.removeEventListener('abort', cancel);
      if (abort.aborted) reject(new Error(signal.aborted ? 'The script run was cancelled.' : 'The script timed out.'));
      else if (code !== 0) reject(new Error('Script exited with code ' + code + ': ' + stderr.trim()));
      else resolve(stdout.trim());
    });
  });
  let silent = script.noAgent === true && !output;
  try {
    const lastLine = JSON.parse(output.split(/\r?\n/).at(-1) ?? '') as { wakeAgent?: boolean } | null;
    if (lastLine?.wakeAgent === false) silent = true;
  } catch { /* Plain stdout is a valid result. */ }
  return { output: truncated ? '[Script output truncated: only the last 64,000 characters are retained.]\n' + output : output, silent };
}
