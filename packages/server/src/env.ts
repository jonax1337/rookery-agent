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
    for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const at = line.indexOf('=');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim();
      let value = line.slice(at + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env) && value) process.env[key] = value;
    }
  }
}
