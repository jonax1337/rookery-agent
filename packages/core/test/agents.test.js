import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt,
  buildAgentPrompt,
  assistantOrgBlock,
  renderOrgOverview,
  toSpeakableText,
  deriveTitle,
  toolsFor,
  DEFAULT_CONFIG,
  COMPUTER_TOOLS,
  computerEngine,
  computerPromptBlock,
  computerServerSpec,
  SkillStore,
  SKILL_SOURCES,
  parseSkillSource,
  renderSkillsIndex,
  toolServerStates,
  toolServersFor,
  withToolServer,
  withoutToolServer,
  customToolId,
  parseKeyCombo,
  parseKeySequence,
} from '../dist/index.js';

const now = Date.now();
const org = { id: 'org1', name: 'Rookery & Co.', mission: 'Testing.', createdAt: now, updatedAt: now };
const agent = {
  id: 'a1', orgId: 'org1', slug: 'mara', name: 'Mara', title: 'Backend Engineer',
  instructions: 'Keep the API small.', createdAt: now, updatedAt: now, archived: false,
};
const report = { ...agent, id: 'a2', slug: 'ben', name: 'Ben', title: 'Junior Engineer', managerId: 'a1' };
const snapshot = { organization: org, teams: [], agents: [agent, report], projects: [], active: [] };

/* --------------------------- one identity ---------------------------- */

test('nothing in the public API can select or switch the assistant', async () => {
  const core = await import('../dist/index.js');
  for (const name of ['route', 'parseMention', 'AGENT_ROLES', 'listRoles', 'getRole', 'listWorkers', 'Team', 'buildWorkerPrompt']) {
    assert.equal(core[name], undefined, name + ' must not come back');
  }
  assert.equal(DEFAULT_CONFIG.defaultAgent, undefined, 'the config has no agent to default to');
});

test('the system prompt carries identity, memories, history and the company block', () => {
  const prompt = buildSystemPrompt({
    config: { ...DEFAULT_CONFIG, assistantName: 'Rookery', userName: 'Alex' },
    memories: [{ kind: 'preference', content: 'The user prefers German.', score: 1, reason: 'test' }],
    history: [{ id: '1', sessionId: 's', role: 'user', content: 'Earlier question', createdAt: now }],
    resumed: false,
    orgBlock: assistantOrgBlock(DEFAULT_CONFIG, snapshot, []),
  });
  assert.match(prompt, /Rookery/);
  assert.match(prompt, /Alex/);
  assert.match(prompt, /prefers German/);
  assert.match(prompt, /Earlier question/);
  assert.match(prompt, /mara — Mara, Backend Engineer/, 'the org chart is in the prompt');
  assert.match(prompt, /never hand the/, 'the single-identity rule is stated');
  assert.doesNotMatch(prompt, /computer tools/, 'no screen talk unless the tools are attached');
});

test('computer control: prompt block, server spec and key combos', () => {
  const builtinPrompt = buildSystemPrompt({
    config: { ...DEFAULT_CONFIG, assistantName: 'Rookery' },
    memories: [], resumed: true, toolHints: [computerPromptBlock('builtin')],
  });
  assert.match(builtinPrompt, /screenshot first, act, screenshot again/);
  const zavoraPrompt = buildSystemPrompt({ config: DEFAULT_CONFIG, memories: [], resumed: true, toolHints: [computerPromptBlock('zavora')] });
  assert.match(zavoraPrompt, /click_element/);
  assert.match(zavoraPrompt, /pass target_app/);

  // The package is a dependency of core, so the engine is zavora with the profile in its env.
  assert.equal(computerEngine(), 'zavora');
  const zavora = computerServerSpec(DEFAULT_CONFIG, 'claude', 'scripting');
  assert.equal(zavora.name, 'computer');
  assert.match(zavora.args[0], /computer-use-mcp[\\/]dist[\\/]server\.js$/);
  assert.equal(zavora.env.COMPUTER_USE_PROFILE, 'scripting');
  assert.equal(zavora.env.COMPUTER_USE_PROVIDER, 'anthropic');
  assert.equal(computerServerSpec(DEFAULT_CONFIG, 'codex').env.COMPUTER_USE_PROVIDER, 'openai');
  assert.equal(computerServerSpec(DEFAULT_CONFIG, 'claude', 'bogus').env.COMPUTER_USE_PROFILE, 'ax', 'unknown profiles fall back');

  assert.deepEqual(parseKeyCombo('ctrl+l'), [0x11, 0x4c]);
  assert.deepEqual(parseKeyCombo('shift+ctrl+t'), [0x10, 0x11, 0x54], 'modifiers first, written order kept');
  assert.deepEqual(parseKeyCombo('Win+R'), [0x5b, 0x52]);
  assert.deepEqual(parseKeyCombo('ctrl++'), [0x11, 0xbb]);
  assert.deepEqual(parseKeySequence('ctrl+a backspace enter'), [[0x11, 0x41], [0x08], [0x0d]]);
  assert.throws(() => parseKeyCombo('ctrl+bogus'), /Unknown key/);
  assert.equal(COMPUTER_TOOLS.some((tool) => tool.name === 'screenshot'), true);
});

test('the tool hub resolves catalogue and custom servers per audience', () => {
  const base = { ...DEFAULT_CONFIG, tools: { servers: [] } };
  const off = toolServersFor(base, 'assistant', 'claude');
  assert.deepEqual(off.specs, [], 'nothing runs until the user switches it on');

  let tools = withToolServer(base, 'computer', { enabled: true, options: { profile: 'core' } });
  tools = withToolServer({ ...base, tools }, 'playwright', { enabled: true, audience: 'both', options: { browser: 'chrome' } });
  tools = withToolServer({ ...base, tools }, 'github', { enabled: true });
  tools = withToolServer({ ...base, tools }, customToolId('My Notion'), {
    enabled: true, audience: 'agents', env: { NOTION_TOKEN: 'x' },
    custom: { name: 'My Notion', command: 'npx', args: ['-y', 'notion-mcp'], hint: 'Notion pages live here.' },
  });
  const config = { ...base, tools };

  const states = toolServerStates(config);
  const byId = Object.fromEntries(states.map((state) => [state.id, state]));
  assert.equal(byId.computer.active, true);
  assert.equal(byId.computer.options.profile, 'core');
  assert.equal(byId.playwright.options.headless, 'no', 'defaults fill the gaps');
  assert.equal(byId.github.active, false, 'a required key that is missing keeps the server off');
  assert.deepEqual(byId.github.missingEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.equal(byId['custom-my-notion'].install, 'custom');

  const assistant = toolServersFor(config, 'assistant', 'codex');
  assert.deepEqual(assistant.specs.map((spec) => spec.name), ['computer', 'playwright']);
  assert.equal(assistant.specs[0].env.COMPUTER_USE_PROFILE, 'core');
  // The bundled Playwright attaches to the shared browser by default...
  assert.match(assistant.specs[1].args[0], /@playwright[\\/]mcp[\\/]cli\.js$/, 'bundled, not npx');
  assert.ok(assistant.specs[1].args.join(' ').includes('--cdp-endpoint http://127.0.0.1:9333'));
  // ...and launches its own only when asked for a fresh one per turn.
  const fresh = withToolServer(config, 'playwright', { options: { persistent: 'no', headless: 'yes' } });
  const freshSpec = toolServersFor({ ...base, tools: fresh }, 'assistant', 'claude').specs[1];
  assert.ok(freshSpec.args.join(' ').includes('--browser chrome --headless'));
  assert.ok(!freshSpec.args.join(' ').includes('--cdp-endpoint'));
  assert.equal(assistant.hints.length, 2);
  assert.match(assistant.hints[1], /browser_snapshot/);

  const agents = toolServersFor(config, 'agent', 'claude');
  assert.deepEqual(agents.specs.map((spec) => spec.name), ['playwright', 'custom-my-notion']);
  assert.equal(agents.specs[1].env.NOTION_TOKEN, 'x');
  assert.deepEqual(agents.hints, [agents.hints[0], 'Notion pages live here.']);

  const cleared = withToolServer(config, 'custom-my-notion', { env: { NOTION_TOKEN: '' } });
  assert.deepEqual(cleared.servers.find((s) => s.id === 'custom-my-notion').env, {}, 'an empty value drops the key');
  const without = withoutToolServer(config, 'custom-my-notion');
  assert.equal(toolServerStates({ ...base, tools: without }).some((s) => s.id === 'custom-my-notion'), false);
});

test('a skill source is owner/repo, a path below it, or a GitHub URL', () => {
  assert.deepEqual(parseSkillSource('anthropics/skills/skills/pdf'), { owner: 'anthropics', repo: 'skills', path: 'skills/pdf' });
  assert.deepEqual(parseSkillSource('vercel-labs/skills'), { owner: 'vercel-labs', repo: 'skills', path: '' });
  assert.deepEqual(parseSkillSource('https://github.com/anthropics/skills/tree/main/skills/xlsx/'), {
    owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/xlsx',
  });
  assert.deepEqual(parseSkillSource('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo', ref: undefined, path: '' });
  assert.throws(() => parseSkillSource('just-a-name'), /owner\/repo/);
  assert.ok(SKILL_SOURCES.every((entry) => entry.source.startsWith('anthropics/skills/skills/')));
});

test('skills live as SKILL.md folders and render into an index per audience', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rookery-skills-'));
  const store = new SkillStore(dir);
  assert.deepEqual(store.list(), []);

  const saved = store.save({ name: 'Wochen Bericht!', description: 'Den Wochenbericht schreiben.', audience: 'assistant', body: '1. Sammeln\n2. Schreiben' });
  assert.equal(saved.name, 'wochen-bericht');
  assert.equal(saved.audience, 'assistant');
  // A folder dropped in by hand, with a file alongside, counts too.
  mkdirSync(join(dir, 'deploy'));
  writeFileSync(join(dir, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Release ausrollen.\naudience: agents\n---\nSchritte hier.\n');
  writeFileSync(join(dir, 'deploy', 'checklist.txt'), 'x');
  const deploy = store.get('deploy');
  assert.equal(deploy.body, 'Schritte hier.');
  assert.deepEqual(deploy.files, ['checklist.txt']);

  assert.deepEqual(store.for('assistant').map((s) => s.name), ['wochen-bericht']);
  assert.deepEqual(store.for('agent').map((s) => s.name), ['deploy']);
  assert.match(renderSkillsIndex(store.for('assistant')), /use_skill.*\n- wochen-bericht: Den Wochenbericht schreiben\./);
  assert.equal(renderSkillsIndex([]), '');
  assert.throws(() => store.save({ name: '', description: 'x', body: '' }), /name/);
  assert.equal(store.remove('deploy'), true);
  assert.equal(store.get('deploy'), null);
});

test('the company block lists staff, the chain of command and the inbox', () => {
  const block = assistantOrgBlock(DEFAULT_CONFIG, snapshot, [
    { id: 'm1', orgId: 'org1', fromAgentId: 'a1', content: 'Build is green.', createdAt: now },
  ]);
  assert.match(block, /ben — Ben, Junior Engineer .* reports to: mara/);
  assert.match(block, /reports to: the assistant/);
  assert.match(block, /from mara: Build is green/);
  assert.match(renderOrgOverview({ ...snapshot, agents: [] }), /none yet/);
});

test('an agent prompt is a member of staff, never the assistant', () => {
  const prompt = buildAgentPrompt({
    config: DEFAULT_CONFIG, agent, snapshot, memories: [], inbox: [],
    assignmentId: 'abcdef12-0000', requestedBy: 'the assistant',
  });
  assert.match(prompt, /You are Mara, Backend Engineer at Rookery & Co\./);
  assert.match(prompt, /Keep the API small/);
  assert.match(prompt, /direct reports: ben/);
  assert.match(prompt, /report to whoever assigned it/);
  assert.doesNotMatch(prompt, /You are Rookery/);
});

test('agents see the staff subset of the tools', () => {
  const assistant = toolsFor('assistant').map((tool) => tool.name);
  const staff = toolsFor('agent').map((tool) => tool.name);
  assert.ok(assistant.includes('hire_agent') && assistant.includes('assign'));
  assert.ok(staff.includes('assign') && staff.includes('send_message'));
  assert.ok(!staff.includes('hire_agent') && !staff.includes('create_project'));
});

/* ------------------------------ text utils ---------------------------- */

test('speakable text strips markdown and code', () => {
  const spoken = toSpeakableText('# Title\n\nSome **bold** text.\n\n```js\nconst x = 1;\n```\n\n- item');
  assert.doesNotMatch(spoken, /[#*`]/);
  assert.match(spoken, /code is on screen/);
});

test('titles come from the first sentence', () => {
  assert.equal(deriveTitle('plan my week. then more.'), 'Plan my week.');
  assert.equal(deriveTitle('   '), 'New conversation');
});
