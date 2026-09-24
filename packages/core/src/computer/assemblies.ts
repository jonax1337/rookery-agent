import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The worker's C# helpers live as files, not as text inside the PowerShell
 * script, for two reasons:
 *
 * - Speed: compiling them costs about two seconds per turn; a DLL named by
 *   the hash of its source is compiled once per version and then loads in
 *   milliseconds. A changed source gets a new name, so nothing stale loads.
 * - Antivirus: AMSI scores the script text as a whole, and screen capture,
 *   input injection and image encoding side by side read like spyware to it.
 *   Kept in .cs files, the script itself stays a thin list of calls.
 */
const CACHE = process.env.ROOKERY_COMPUTER_DIR
  ? join(process.env.ROOKERY_COMPUTER_DIR, 'cache', 'computer')
  : join(tmpdir(), 'rookery-computer');

export interface CompiledSource {
  /** The C# file Add-Type compiles. */
  source: string;
  /** The cached DLL it compiles to. */
  assembly: string;
}

/** Paths for a named source; write it with writeSource before the worker starts. */
export function compiledSource(name: string, text: string): CompiledSource {
  const base = join(CACHE, name + '-' + createHash('sha256').update(text).digest('hex').slice(0, 16));
  return { source: base + '.cs', assembly: base + '.dll' };
}

/** Write the .cs once; concurrent sessions write identical bytes, and a rename is atomic. */
export function writeSource(paths: CompiledSource, text: string): void {
  if (existsSync(paths.source)) return;
  mkdirSync(CACHE, { recursive: true });
  const temporary = paths.source + '.' + process.pid + '.tmp';
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, paths.source);
}

/**
 * The PowerShell loader. Compiles to a private temporary file and moves it
 * into place, so a concurrent session never loads a half-written DLL; if the
 * cache fails, it compiles the source in memory instead.
 */
export const ASSEMBLY_LOADER = `
function Rk-Assembly($assembly, $source, $type, $refs) {
  if ($type -as [type]) { return }
  $options = @{ Path = $source }
  if ($refs) { $options.ReferencedAssemblies = $refs }
  try {
    if (-not [IO.File]::Exists($assembly)) {
      $tmp = $assembly + '.' + $PID + '.tmp'
      Add-Type @options -OutputAssembly $tmp -OutputType Library
      try { [IO.File]::Move($tmp, $assembly) } catch { [IO.File]::Delete($tmp) }
    }
    Add-Type -Path $assembly
  } catch {
    if (-not ($type -as [type])) { Add-Type @options }
  }
}
`;
