import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env support for the optional voice keys (ELEVENLABS_API_KEY,
 * OPENAI_API_KEY): `~/.rookery/.env` for an installed copy, the repo root's
 * `.env` for a checkout. Values already in the environment win, so a shell
 * export still overrides the file. No dependency, no interpolation.
 */
export function loadDotEnv(): void {
  const candidates = [
    join(process.env.ROOKERY_HOME || join(homedir(), '.rookery'), '.env'),
    fileURLToPath(new URL('../../../.env', import.meta.url)),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) setFromLine(line.trim());
  }
}

/** `KEY=value`; comments, blanks and empty values are skipped, and a variable already set is never overwritten. */
function setFromLine(line: string): void {
  if (!line || line.startsWith('#')) return;
  const separator = line.indexOf('=');
  if (separator <= 0) return;
  const key = line.slice(0, separator).trim();
  const value = unquote(line.slice(separator + 1).trim());
  if (key && !(key in process.env) && value) process.env[key] = value;
}

function unquote(value: string): string {
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}
