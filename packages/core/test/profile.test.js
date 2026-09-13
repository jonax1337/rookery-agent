import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Assistant, ProviderRegistry, loadConfig, applyConfig, readProfile, writeProfileFile, renderProfile, searchProfile, readProfileExcerpt, buildSystemPrompt, toolsFor, importMigration } from '../dist/index.js';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'rookery-profile-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('fresh profile is neutral and settings remain live; existing Jarvis upgrades without personality loss', (t) => {
  const home = fixture(t);
  const config = loadConfig({ home });
  assert.equal(readProfile(config).files.length, 6);
  assert.equal(config.voice.style, 'neutral');
  assert.equal(config.voice.jarvisEffect, false);
  assert.doesNotMatch(renderProfile(config), /billionaire|butler|sovereign|as "Sir"/);
  applyConfig(config, { assistantName: 'Alex', userName: 'Sam', formalAddress: true });
  assert.match(renderProfile(config), /Your name is Alex/);
  assert.match(renderProfile(config), /Use formal forms of address/);
  writeProfileFile(config, 'SOUL.md', 'I am a playful explorer.');
  assert.match(renderProfile(config), /only if SOUL.md does not specify your name, use Alex/);
  assert.equal(readProfile(loadConfig({ home })).files.find(f => f.name === 'SOUL.md').content, 'I am a playful explorer.');

  const oldHome = fixture(t);
  mkdirSync(join(oldHome, 'workspace'));
  writeFileSync(join(oldHome, 'workspace', 'CLAUDE.md'), 'Existing workspace');
  writeFileSync(join(oldHome, 'config.json'), JSON.stringify({ assistantName: 'Jarvis', userName: 'Jonas', honorific: 'Sir' }));
  const upgraded = loadConfig({ home: oldHome });
  assert.match(renderProfile(upgraded), /You are Jarvis/);
  assert.match(renderProfile(upgraded), /sovereign, composed, dry/);
  assert.equal(upgraded.voice.style, 'jarvis');
  assert.equal(loadConfig({ home: oldHome }).voice.style, 'jarvis');
  applyConfig(upgraded, { formalAddress: false, honorific: 'Friend' });
  assert.doesNotMatch(renderProfile(upgraded), /Always address the user formally|Call the user "Sir"/);
  assert.match(renderProfile(upgraded), /Preferred honorific: Friend/);
  assert.equal(readFileSync(join(oldHome, 'workspace', 'CLAUDE.md'), 'utf8'), 'Existing workspace');
});

test('Hermes soul owns identity, notes survive import and hot reload even in resumed voice turns', (t) => {
  const home = fixture(t);
  const source = fixture(t);
  writeFileSync(join(source, 'SOUL.md'), '# Soul\nYou are Nova, a cheerful companion.');
  mkdirSync(join(source, 'memories'));
  writeFileSync(join(source, 'memories', 'USER.md'), 'Sam loves astronomy.');
  const config = loadConfig({ home });
  importMigration(config, 'hermes', source);
  const prompt = () => buildSystemPrompt({ config, memories: [], resumed: true, voice: true });
  assert.match(prompt(), /You are Nova/);
  assert.match(prompt(), /Sam loves astronomy/);
  assert.doesNotMatch(prompt(), /Your name is Rookery|butler-AI|sovereign, composed/);
  writeProfileFile(config, 'SOUL.md', 'You are Nova. Speak gently.');
  assert.match(prompt(), /Speak gently/);
  assert.doesNotMatch(prompt(), /cheerful companion/);
});

test('portable Unicode notes are retrieved and paged; path escapes and links are rejected', (t) => {
  const config = loadConfig({ home: fixture(t) });
  mkdirSync(join(config.workspace, 'memory'));
  writeFileSync(join(config.workspace, 'memory', '2026-09-13-Erinnerungen-夜.md'), 'x'.repeat(13000) + ' The telescope is named Stardust.');
  assert.match(searchProfile(config, 'Stardust'), /The telescope is named Stardust/);
  assert.match(renderProfile(config, 'Stardust'), /Stardust/);
  assert.match(readProfileExcerpt(config, 'memory/2026-09-13-Erinnerungen-夜.md', 13000), /Stardust/);
  assert.throws(() => readProfileExcerpt(config, 'memory/../config.md'), /Invalid profile path/);
  assert.throws(() => writeProfileFile(config, '../SOUL.md', 'bad'), /standard profile files/);
  assert.throws(() => writeProfileFile(config, 'SOUL.md', '\0'), /UTF-8/);
  const outside = fixture(t);
  symlinkSync(outside, join(config.workspace, 'memory', 'linked'), 'junction');
  assert.throws(() => readProfileExcerpt(config, 'memory/linked/private.md'), /symbolic links/);
  assert.throws(() => searchProfile(config, 'secret'), /symbolic links/);
  assert.ok(!toolsFor('agent').some(tool => ['search_profile', 'read_profile'].includes(tool.name)));
});

test('runtime supplies the portable profile through MCP-only assistant turns and reloads on resume', async (t) => {
  const runs = [];
  const provider = { id: 'claude', displayName: 'Fake', models: () => [], async status() { return { id: 'claude', available: true, authenticated: true }; }, async *run(options) { runs.push(options); yield { type: 'session', providerSessionId: 'fake-session' }; yield { type: 'text', delta: 'Hello' }; yield { type: 'done' }; } };
  const home = mkdtempSync(join(tmpdir(), 'rookery-profile-runtime-'));
  const assistant = new Assistant({ config: { home, logLevel: 'silent', memory: { autoExtract: false }, tools: { servers: [] } }, registry: new ProviderRegistry([provider]) });
  t.after(async () => { await assistant.org.bridge.close(); assistant.close(); rmSync(home, { recursive: true, force: true }); });
  writeProfileFile(assistant.config, 'SOUL.md', 'You are Nova.');
  let sessionId;
  for await (const event of assistant.chat({ text: 'Hello' })) if (event.type === 'session') sessionId = event.sessionId;
  writeProfileFile(assistant.config, 'SOUL.md', 'You are Nova. Prefer concise answers.');
  for await (const event of assistant.chat({ text: 'Again', sessionId })) { /* drain */ }
  assert.equal(runs.length, 2);
  assert.match(runs[1].systemPrompt, /Prefer concise answers/);
  assert.equal(runs[1].cwd, assistant.config.workspace);
  assert.ok(runs[1].mcp);
  const orgId = assistant.org.activeOrganization().id;
  const result = await assistant.org.handle({ orgId, audience: 'assistant', depth: -1 }, 'read_profile', { name: 'SOUL.md' });
  assert.match(result.text, /Nova/);
  const denied = await assistant.org.handle({ orgId, audience: 'agent', depth: 0 }, 'read_profile', { name: 'SOUL.md' });
  assert.equal(denied.isError, true);
  const staff = assistant.store.org.createAgent({ orgId, name: 'Mara', title: 'Helper', instructions: 'Help.' });
  await assistant.org.run({ orgId, agent: staff, task: 'Hello', requesterKind: 'user', depth: 0, emit() {} });
  assert.equal(runs.at(-1).cwd, join(home, 'agent-workspaces', staff.id));
});

test('a maximum-size imported note set does not break subsequent assistant turns', (t) => {
  const config = loadConfig({ home: fixture(t) });
  const source = fixture(t);
  mkdirSync(join(source, 'memory'));
  for (let index = 0; index < 16; index++) writeFileSync(join(source, 'memory', `${index}.md`), 'a'.repeat(1024 * 1024));
  importMigration(config, 'openclaw', source);
  assert.match(renderProfile(config, 'Hello'), /Partial search/);
  writeFileSync(join(config.workspace, 'memory', '0.md'), Buffer.from([255]));
  assert.match(renderProfile(config, 'Hello'), /Portable note retrieval is unavailable/);
});
