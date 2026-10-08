import { isAbsolute, relative, sep } from 'node:path';

const MIB = 1024 * 1024;

/** Largest single file a migration reads, whether Markdown, a cron export or a script asset. */
export const MAX_FILE_BYTES = MIB;
/** Largest amount of source data (files, jobs.json) one migration reads. */
export const MAX_TOTAL_BYTES = 16 * MIB;

/** True when `child` is `parent` itself or lies below it. */
export function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** True when `child` lies below `parent` and is not `parent` itself. */
export function isStrictlyInside(parent: string, child: string): boolean {
  return relative(parent, child) !== '' && contains(parent, child);
}
