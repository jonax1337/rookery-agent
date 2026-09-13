import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CronScript, RookeryConfig } from './types.js';

export interface ScriptAsset {
  sourcePath: string;
  targetPath: string;
  bytes: number;
  content: Buffer;
  previous?: Buffer;
}

/** Copy a script's locally resolvable helpers; never import a harness installation or credential store. */
export function inspectScriptBundle(config: RookeryConfig, root: string, id: string, file: string, noAgent: boolean, check: (path: string) => void) {
  const sourceRoot = resolve(root, 'scripts');
  const main = resolve(sourceRoot, file);
  const relativeMain = relative(sourceRoot, main);
  if (!relativeMain || isAbsolute(relativeMain) || relativeMain === '..' || relativeMain.startsWith('..' + sep)) throw new Error('The script must be inside the source scripts folder.');
  const runtimes: Record<string, CronScript['runtime']> = { '.py': 'python', '.js': 'node', '.mjs': 'node', '.cjs': 'node', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell' };
  const runtime = runtimes[extname(main).toLowerCase()];
  if (!runtime) throw new Error('Supported script extensions are .py, .js, .mjs, .cjs, .sh, .bash and .ps1.');
  const bundle = 'imported-scripts/hermes-' + createHash('sha256').update(JSON.stringify([root, id])).digest('hex').slice(0, 20);
  const bundleRoot = resolve(config.home, bundle);
  const contains = (parent: string, child: string) => { const path = relative(resolve(parent), resolve(child)); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)); };
  if (contains(root, bundleRoot) || contains(bundleRoot, root)) throw new Error('Source scripts and their Rookery destination must not overlap.');
  const assets: ScriptAsset[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  const read = (path: string): Buffer => {
    check(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Script assets must be regular UTF-8 files of at most 1 MiB.');
    const content = readFileSync(path);
    if (content.length > 1024 * 1024) throw new Error('Script asset exceeds 1 MiB.');
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (content.includes(0)) throw new Error('Binary script assets are not supported.');
    return content;
  };
  const add = (path: string): void => {
    path = resolve(path);
    if (seen.has(path)) return;
    const rel = relative(sourceRoot, path);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('A script dependency escapes the scripts folder.');
    if (seen.size >= 64) throw new Error('A script bundle exceeds 64 files.');
    seen.add(path);
    const extension = extname(path).toLowerCase();
    if (!runtimes[extension] && extension !== '.json') {
      warnings.push(`Dependency ${rel} was not copied: only script modules and noncredential JSON sidecars are supported.`);
      return;
    }
    const content = read(path);
    const text = content.toString('utf8');
    if (extension === '.json') {
      const document = JSON.parse(text);
      // Sidecar state is useful, but unknown token stores are not portable script state.
      if (/auth|token|secret|credential|password/i.test(basename(path)) || /"(?:[^"]*(?:password|secret|token|api[_-]?key|authorization)[^"]*)"\s*:/i.test(JSON.stringify(document))) {
        warnings.push(`Credential-like sidecar ${rel} was not copied. Configure its access separately.`);
        return;
      }
    }
    total += content.length;
    if (total > 8 * 1024 * 1024) throw new Error('A script bundle exceeds 8 MiB.');
    const targetPath = bundle + '/' + rel.split(sep).join('/');
    const target = resolve(config.home, targetPath);
    check(target);
    const previous = existsSync(target) ? read(target) : undefined;
    assets.push({ sourcePath: 'scripts/' + rel.split(sep).join('/'), targetPath, bytes: content.length, content, previous });
    if (extension === '.json') return;
    if (/(?:[a-zA-Z]:[\\/]|\/home\/|~\/|HERMES_HOME|\.hermes[\\/])/i.test(text)) warnings.push(`${rel} contains environment or absolute path references. They are preserved; review them before enabling the schedule on another installation.`);
    // ponytail: static imports and relative JSON sidecars only; dynamic imports and external packages need review.
    const imports = extension === '.py'
      ? [...text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import\s|import\s+([\w.]+))/gm)].map(match => (match[1] ?? match[2])!.replaceAll('.', '/'))
      : [...text.matchAll(/(?:from\s+|require\(|import\()['"](\.[^'"]+)['"]/g)].map(match => match[1]!);
    for (const dependency of imports) {
      const candidates = extension === '.py'
        ? [join(dirname(path), dependency + '.py'), join(sourceRoot, dependency + '.py'), join(sourceRoot, dependency, '__init__.py')]
        : [resolve(dirname(path), dependency), resolve(dirname(path), dependency + '.js')];
      const candidate = candidates.find(candidate => existsSync(candidate));
      if (candidate) add(candidate);
    }
    for (const match of text.matchAll(/['"]([^'"\/\\]+\.json)['"]/gi)) {
      const sidecar = join(dirname(path), match[1]!);
      if (existsSync(sidecar)) add(sidecar);
    }
  };
  add(main);
  const script: CronScript = { path: resolve(config.home, bundle, relativeMain), runtime, noAgent };
  warnings.push('Script files can contain embedded credentials and perform system actions. Review the copied code and dependencies before granting Full access. Separate credential stores and installed runtimes are not copied.');
  return { script, assets, warnings: [...new Set(warnings)] };
}
