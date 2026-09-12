// Build a standalone npm package; workspace packages remain private.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, 'dist/npm');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const manifest = await readJson(resolve(root, 'package.json'));
const dependencies = {};
// Fixed generated directory, never a caller-supplied path.
if (out !== resolve(root, 'dist', 'npm')) throw new Error('Invalid package output directory');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const name of ['core', 'server', 'cli', 'web']) {
  const source = resolve(root, 'packages', name);
  const target = resolve(out, 'packages', name);
  await cp(resolve(source, 'dist'), resolve(target, 'dist'), { recursive: true });
  const pkg = await readJson(resolve(source, 'package.json'));
  await writeFile(resolve(target, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }));
  if (name !== 'web') Object.assign(dependencies, pkg.dependencies);
}
for (const key of Object.keys(dependencies)) if (key.startsWith('@rookery/')) delete dependencies[key];
// Keep the directory layout for MCP child entrypoints and static web assets.
for (const entry of await readdir(resolve(out, 'packages'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
  const path = resolve(entry.parentPath, entry.name);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/(['"])@rookery\/(core|server)(\/[^'"]+)?\1/g, (_, quote, name, subpath) => {
    const target = resolve(out, 'packages', name, 'dist', subpath ? subpath.slice(1) + '.js' : 'index.js');
    const specifier = relative(dirname(path), target).replaceAll('\\', '/');
    return quote + (specifier.startsWith('.') ? specifier : './' + specifier) + quote;
  }));
}
await mkdir(resolve(out, 'scripts'), { recursive: true });
await cp(resolve(root, 'scripts/rookery.mjs'), resolve(out, 'scripts/rookery.mjs'));
for (const file of ['README.md', 'LICENSE']) await cp(resolve(root, file), resolve(out, file));
await writeFile(resolve(out, 'package.json'), JSON.stringify({
  name: manifest.name, version: manifest.version, description: manifest.description,
  license: manifest.license, type: 'module', engines: manifest.engines,
  repository: { type: 'git', url: 'git+https://github.com/jonax1337/rookery-agent.git' },
  homepage: 'https://github.com/jonax1337/rookery-agent#readme',
  bin: { rookery: 'scripts/rookery.mjs', rk: 'scripts/rookery.mjs' },
  files: ['packages/*/dist', 'packages/*/package.json', 'scripts/rookery.mjs'],
  dependencies,
}, null, 2) + '\n');
console.log(`Standalone package ready: ${out}`);
