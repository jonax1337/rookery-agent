#!/usr/bin/env node
/**
 * Run the Rookery server and the Vite dev server together.
 *
 * Each child gets a coloured prefix so the two logs stay readable, and either
 * one exiting takes the whole thing down: a half-dead dev environment is
 * worse than no dev environment.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const ESC = String.fromCharCode(27);
const colour = (code, text) => ESC + '[' + code + 'm' + text + ESC + '[0m';

const serverEntry = join(root, 'packages', 'server', 'dist', 'main.js');
if (!existsSync(serverEntry)) {
  console.error('The server is not built yet. Run: npm run build');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function start(name, code, command, args, { shell = isWindows } = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    env: process.env,
  });

  const prefix = colour(code, name.padEnd(6)) + ' | ';
  const pipe = (stream, target) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        target.write(prefix + buffer.slice(0, index) + '\n');
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (exitCode) => {
    if (shuttingDown) return;
    console.log(prefix + 'exited with code ' + exitCode);
    shutdown(exitCode ?? 0);
  });

  children.push(child);
  return child;
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Spawned directly (no shell): process.execPath can contain spaces
// (e.g. "C:\Program Files\nodejs\node.exe"), and a shell on Windows only
// gets the command and args concatenated, not quoted, splitting the path.
start('server', 33, process.execPath, [serverEntry], { shell: false });
start('web', 36, 'npm', ['run', 'dev', '-w', '@rookery/web']);

console.log('\nRookery dev: API on http://127.0.0.1:4317, UI on http://localhost:5317\n');
