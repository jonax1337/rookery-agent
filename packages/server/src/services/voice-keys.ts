import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const voiceKeysSchema = z.object({
  openai: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/).nullable().optional(),
  elevenlabs: z.string().trim().max(4096).regex(/^[\x21-\x7e]*$/).nullable().optional(),
}).strict();
export type VoiceKeys = Partial<Record<'openai' | 'elevenlabs', string>>;
const names = ['openai', 'elevenlabs'] as const;

function savedKeys(home: string): VoiceKeys {
  const file = join(home, 'voice-keys.json');
  try {
    return existsSync(file) ? voiceKeysSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) as VoiceKeys : {};
  } catch {
    throw new Error('Voice key storage could not be read. Check voice-keys.json in your Rookery home.');
  }
}

export function voiceKeys(home?: string): VoiceKeys {
  const saved = home ? savedKeys(home) : {};
  return { openai: saved.openai || process.env.OPENAI_API_KEY, elevenlabs: saved.elevenlabs || process.env.ELEVENLABS_API_KEY };
}

export function voiceKeyStatus(home: string) {
  const saved = savedKeys(home);
  const effective = voiceKeys(home);
  return Object.fromEntries(names.map((name) => [name, {
    configured: Boolean(effective[name]),
    source: saved[name] ? 'saved' : effective[name] ? 'environment' : 'none',
  }]));
}

export function saveVoiceKeys(home: string, patch: z.infer<typeof voiceKeysSchema>) {
  const saved = savedKeys(home);
  for (const name of names) {
    if (patch[name] === null) delete saved[name];
    else if (patch[name]) saved[name] = patch[name];
  }
  const file = join(home, 'voice-keys.json');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(saved) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return voiceKeyStatus(home);
}
