import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { CronScript, RookeryConfig } from './types.js';
import { MAX_FILE_BYTES, contains, isStrictlyInside } from './migration-shared.js';

export interface ScriptAsset {
  sourcePath: string;
  targetPath: string;
  bytes: number;
  content: Buffer;
  previous?: Buffer;
}

export interface ScriptBundle {
  script: CronScript;
  assets: ScriptAsset[];
  warnings: string[];
}

/** The scheduled job a script belongs to. */
export interface ScriptJob {
  root: string;
  id: string;
  file: string;
  noAgent: boolean;
}

const SCRIPT_RUNTIMES: Record<string, CronScript['runtime']> = {
  '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell',
};
const MAX_BUNDLE_FILES = 64;
const MAX_BUNDLE_BYTES = 8 * MAX_FILE_BYTES;
const CREDENTIAL_FILE_NAME = /auth|token|secret|credential|password/i;
const CREDENTIAL_JSON_KEY = /"(?:[^"]*(?:password|secret|token|api[_-]?key|authorization)[^"]*)"\s*:/i;
const ENVIRONMENT_REFERENCE = /(?:[a-zA-Z]:[\\/]|\/home\/|~\/|HERMES_HOME|\.hermes[\\/])/i;
const PYTHON_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import\s|import\s+([\w.]+))/gm;
const RELATIVE_MODULE_REFERENCE = /(?:from\s+|require\(|import\()['"](\.[^'"]+)['"]/g;
const JSON_SIDECAR_REFERENCE = /['"]([^'"\/\\]+\.json)['"]/gi;
const BUNDLE_WARNING = 'Script files can contain embedded credentials and perform system actions. Review the copied code and dependencies before granting Full access. Separate credential stores and installed runtimes are not copied.';

function posixPath(path: string): string {
  return path.split(sep).join('/');
}

function readAsset(path: string, check: (path: string) => void): Buffer {
  check(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Script assets must be regular UTF-8 files of at most 1 MiB.');
  const content = readFileSync(path);
  if (content.length > MAX_FILE_BYTES) throw new Error('Script asset exceeds 1 MiB.');
  new TextDecoder('utf-8', { fatal: true }).decode(content);
  if (content.includes(0)) throw new Error('Binary script assets are not supported.');
  return content;
}

/** Sidecar state is useful, but unknown token stores are not portable script state. */
function isCredentialSidecar(path: string, text: string): boolean {
  const document: unknown = JSON.parse(text);
  return CREDENTIAL_FILE_NAME.test(basename(path)) || CREDENTIAL_JSON_KEY.test(JSON.stringify(document));
}

/** Existing files a script refers to: imported modules first, then JSON sidecars it names. */
// ponytail: static imports and relative JSON sidecars only; dynamic imports and external packages need review.
function localDependencies(path: string, extension: string, text: string, sourceRoot: string): string[] {
  const isPython = extension === '.py';
  const specifiers = isPython
    ? [...text.matchAll(PYTHON_IMPORT)].map(match => (match[1] ?? match[2])!.replaceAll('.', '/'))
    : [...text.matchAll(RELATIVE_MODULE_REFERENCE)].map(match => match[1]!);
  const modules = specifiers.flatMap(specifier => {
    const candidates = isPython
      ? [join(dirname(path), specifier + '.py'), join(sourceRoot, specifier + '.py'), join(sourceRoot, specifier, '__init__.py')]
      : [resolve(dirname(path), specifier), resolve(dirname(path), specifier + '.js')];
    const found = candidates.find(candidate => existsSync(candidate));
    return found ? [found] : [];
  });
  const sidecars = [...text.matchAll(JSON_SIDECAR_REFERENCE)]
    .map(match => join(dirname(path), match[1]!))
    .filter(sidecar => existsSync(sidecar));
  return [...modules, ...sidecars];
}

/** Copy a script's locally resolvable helpers; never import a harness installation or credential store. */
export function inspectScriptBundle(config: RookeryConfig, job: ScriptJob, check: (path: string) => void): ScriptBundle {
  const { root, id, file, noAgent } = job;
  const sourceRoot = resolve(root, 'scripts');
  const main = resolve(sourceRoot, file);
  if (!isStrictlyInside(sourceRoot, main)) throw new Error('The script must be inside the source scripts folder.');
  const runtime = SCRIPT_RUNTIMES[extname(main).toLowerCase()];
  if (!runtime) throw new Error('Supported script extensions are .py, .js, .mjs, .cjs, .sh, .bash and .ps1.');
  const bundle = 'imported-scripts/hermes-' + createHash('sha256').update(JSON.stringify([root, id])).digest('hex').slice(0, 20);
  const bundleRoot = resolve(config.home, bundle);
  if (contains(root, bundleRoot) || contains(bundleRoot, root)) throw new Error('Source scripts and their Rookery destination must not overlap.');
  const assets: ScriptAsset[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const add = (candidate: string): void => {
    const path = resolve(candidate);
    if (seen.has(path)) return;
    if (!isStrictlyInside(sourceRoot, path)) throw new Error('A script dependency escapes the scripts folder.');
    if (seen.size >= MAX_BUNDLE_FILES) throw new Error(`A script bundle exceeds ${MAX_BUNDLE_FILES} files.`);
    seen.add(path);
    const displayPath = relative(sourceRoot, path);
    const rel = posixPath(displayPath);
    const extension = extname(path).toLowerCase();
    if (!SCRIPT_RUNTIMES[extension] && extension !== '.json') {
      warnings.push(`Dependency ${displayPath} was not copied: only script modules and noncredential JSON sidecars are supported.`);
      return;
    }
    const content = readAsset(path, check);
    const text = content.toString('utf8');
    if (extension === '.json' && isCredentialSidecar(path, text)) {
      warnings.push(`Credential-like sidecar ${displayPath} was not copied. Configure its access separately.`);
      return;
    }
    total += content.length;
    if (total > MAX_BUNDLE_BYTES) throw new Error('A script bundle exceeds 8 MiB.');
    const targetPath = `${bundle}/${rel}`;
    const target = resolve(config.home, targetPath);
    check(target);
    const previous = existsSync(target) ? readAsset(target, check) : undefined;
    assets.push({ sourcePath: `scripts/${rel}`, targetPath, bytes: content.length, content, previous });
    if (extension === '.json') return;
    if (ENVIRONMENT_REFERENCE.test(text)) warnings.push(`${displayPath} contains environment or absolute path references. They are preserved; review them before enabling the schedule on another installation.`);
    for (const dependency of localDependencies(path, extension, text, sourceRoot)) add(dependency);
  };
  add(main);
  const script: CronScript = { path: resolve(config.home, bundle, relative(sourceRoot, main)), runtime, noAgent };
  warnings.push(BUNDLE_WARNING);
  return { script, assets, warnings: [...new Set(warnings)] };
}
