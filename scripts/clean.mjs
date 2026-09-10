#!/usr/bin/env node
/** Remove build output from every workspace. Leaves node_modules and ~/.rookery alone. */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'packages/core/dist', 'packages/core/tsconfig.tsbuildinfo',
  'packages/server/dist', 'packages/server/tsconfig.tsbuildinfo',
  'packages/cli/dist', 'packages/cli/tsconfig.tsbuildinfo',
  'packages/web/dist', 'packages/web/tsconfig.tsbuildinfo',
];

for (const target of targets) {
  rmSync(join(root, target), { recursive: true, force: true });
  console.log('removed ' + target);
}
