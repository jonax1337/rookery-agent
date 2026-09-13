import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { DEFAULT_CONFIG } from '@rookery/core';
import { registerTtsRoutes } from '../dist/routes/tts.js';
import { createAuthHook } from '../dist/auth.js';
import { voiceKeys, voiceKeyStatus } from '../dist/services/voice-keys.js';
import { synthesize, ttsEngines, elevenLabsVoices } from '../dist/services/tts.js';

test('speech keys are write-only, persistent, authenticated, and used immediately by every paid speech path', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rookery-voice-keys-'));
  const app = Fastify();
  const context = { config: { ...DEFAULT_CONFIG, home, token: 'test-auth' }, log: { debug() {} } };
  app.addHook('preHandler', createAuthHook(context));
  await registerTtsRoutes(app, context);
  const headers = { authorization: 'Bearer test-auth' };
  const patch = (payload) => app.inject({ method: 'PATCH', url: '/api/tts/keys', headers, payload });
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.OPENAI_API_KEY;
  try {
    assert.equal((await app.inject({ method: 'PATCH', url: '/api/tts/keys', payload: { openai: 'leak' } })).statusCode, 401);
    const response = await patch({ openai: 'fake-openai-secret', elevenlabs: 'fake-eleven-secret' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().openai.source, 'saved');
    assert.ok(!response.body.includes('fake-'));
    assert.ok(!(await app.inject({ url: '/api/tts/keys', headers })).body.includes('fake-'));
    assert.equal(voiceKeys(home).openai, 'fake-openai-secret');
    assert.equal(JSON.parse(readFileSync(join(home, 'voice-keys.json'))).elevenlabs, 'fake-eleven-secret');
    await patch({ openai: '' });
    assert.equal(voiceKeys(home).openai, 'fake-openai-secret');
    assert.equal((await patch({ openai: 'bad\nheader' })).statusCode, 400);
    assert.equal((await patch({ unknown: 'secret' })).statusCode, 400);
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, headers: options.headers });
      return new Response(url.includes('/voices?') ? JSON.stringify({ voices: [] }) : 'fake audio');
    };
    assert.equal(ttsEngines(voiceKeys(home)).openai, true);
    await synthesize({ ...DEFAULT_CONFIG.voice, engine: 'openai' }, 'test', voiceKeys(home));
    await synthesize({ ...DEFAULT_CONFIG.voice, engine: 'elevenlabs' }, 'test', voiceKeys(home));
    await elevenLabsVoices(voiceKeys(home));
    assert.equal(calls[0].headers.Authorization, 'Bearer fake-openai-secret');
    assert.equal(calls[1].headers['xi-api-key'], 'fake-eleven-secret');
    assert.equal(calls[2].headers['xi-api-key'], 'fake-eleven-secret');
    await patch({ openai: 'replacement-secret' });
    await synthesize({ ...DEFAULT_CONFIG.voice, engine: 'openai' }, 'test', voiceKeys(home));
    assert.equal(calls[3].headers.Authorization, 'Bearer replacement-secret');
    process.env.OPENAI_API_KEY = 'environment-secret';
    await patch({ openai: null });
    assert.equal(voiceKeys(home).openai, 'environment-secret');
    assert.equal(voiceKeyStatus(home).openai.source, 'environment');
    assert.ok(!readFileSync(join(home, 'voice-keys.json'), 'utf8').includes('openai'));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalEnv;
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
