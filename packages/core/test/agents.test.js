import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSystemPrompt,
  buildAgentPrompt,
  assistantOrgBlock,
  renderOrgOverview,
  toSpeakableText,
  deriveTitle,
  toolsFor,
  DEFAULT_CONFIG as BUILTIN_CONFIG,
  COMPUTER_TOOLS,
  computerEngine,
  computerPromptBlock,
  computerServerSpec,
  SkillStore,
  SKILL_SOURCES,
  parseSkillSource,
  renderSkillsIndex,
  toolServerStates,
  dormantToolsHint,
  toolServersFor,
  withToolServer,
  withoutToolServer,
  customToolId,
  parseKeyCombo,
  parseKeySequence,
} from '../dist/index.js';

const DEFAULT_CONFIG = { ...BUILTIN_CONFIG, workspace: mkdtempSync(join(tmpdir(), 'rookery-prompt-')) };

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
  assert.match(prompt, /Use British English by default/);
  assert.match(prompt, /Match the language the user writes or speaks in when they use another language/);
  assert.doesNotMatch(prompt, /computer tools/, 'no screen talk unless the tools are attached');
});

test('the prompt tells the assistant to find a way, and where finding a way stops', () => {
  const prompt = buildSystemPrompt({ config: DEFAULT_CONFIG, memories: [], resumed: true });
  assert.match(prompt, /You do not hit dead ends/, 'the doctrine is in every turn');
  assert.match(prompt, /three genuinely different routes/, 'it says how much trying is enough');
  assert.match(prompt, /a route you have not tried is still open/);
  assert.match(prompt, /still gets one short question first/, 'the brake survives the doctrine');
  assert.match(prompt, /"stop" stops you immediately/);
  assert.doesNotMatch(prompt, /set_tool_server/, 'which tools exist comes from the hub, not the identity');
});

test('the hub tells the assistant what it could attach and what only the user can fix', () => {
  const base = { ...DEFAULT_CONFIG, tools: { servers: [] } };
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  try {
    const hint = dormantToolsHint(base, 'assistant');
    assert.match(hint, /ready to attach with set_tool_server:/);
    assert.ok(hint.includes('computer (Computer control)'), 'a server that is merely off is reachable');
    assert.ok(hint.includes('github (GitHub): needs GITHUB_PERSONAL_ACCESS_TOKEN'), 'a missing key is a real wall');
    assert.match(hint, /Tools page/, 'and the wall names who can remove it');
    assert.equal(dormantToolsHint(base, 'agent'), '', 'agents cannot flip switches, so they hear nothing');

    const on = { ...base, ...withToolServer(base, 'computer', { enabled: true }) };
    assert.ok(!dormantToolsHint(on, 'assistant').includes('computer (Computer control)'), 'an attached server is not offered again');

    const forAgents = { ...base, ...withToolServer(base, 'computer', { enabled: true, audience: 'agents' }) };
    assert.ok(dormantToolsHint(forAgents, 'assistant').includes('computer (Computer control)'), 'on for the staff is still off for you');
  } finally {
    if (token) process.env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
  }
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

  let patch = withToolServer(base, 'computer', { enabled: true, options: { profile: 'core' } });
  patch = withToolServer({ ...base, ...patch }, 'playwright', { enabled: true, audience: 'both', options: { browser: 'chrome' } });
  patch = withToolServer({ ...base, ...patch }, 'github', { enabled: true });
  patch = withToolServer({ ...base, ...patch }, customToolId('My Notion'), {
    enabled: true, audience: 'agents', env: { NOTION_TOKEN: 'x' },
    custom: { name: 'My Notion', command: 'npx', args: ['-y', 'notion-mcp'], hint: 'Notion pages live here.' },
  });
  const config = { ...base, ...patch };

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
  // The bundled Playwright launches the browser itself, on its own saved
  // profile - and only when a browser tool is called, never up front.
  assert.match(assistant.specs[1].args[0], /@playwright[\\/]mcp[\\/]cli\.js$/, 'bundled, not npx');
  assert.ok(assistant.specs[1].args.join(' ').includes('--browser chrome'));
  assert.ok(assistant.specs[1].args.includes('--user-data-dir'));
  // A fresh profile per turn drops the saved one.
  const fresh = withToolServer(config, 'playwright', { options: { persistent: 'no', headless: 'yes' } });
  const freshSpec = toolServersFor({ ...base, ...fresh }, 'assistant', 'claude').specs[1];
  assert.ok(freshSpec.args.join(' ').includes('--browser chrome --headless'));
  assert.ok(!freshSpec.args.includes('--user-data-dir'));
  assert.equal(assistant.hints.length, 2);
  assert.match(assistant.hints[1], /browser_snapshot/);

  const agents = toolServersFor(config, 'agent', 'claude');
  assert.deepEqual(agents.specs.map((spec) => spec.name), ['playwright', 'custom-my-notion']);
  assert.equal(agents.specs[1].env.NOTION_TOKEN, 'x');
  assert.deepEqual(agents.hints, [agents.hints[0], 'Notion pages live here.']);

  const cleared = withToolServer(config, 'custom-my-notion', { env: { NOTION_TOKEN: '' } });
  assert.deepEqual(cleared.tools.servers.find((s) => s.id === 'custom-my-notion').env, {}, 'an empty value drops the key');
  const without = withoutToolServer(config, 'custom-my-notion');
  assert.equal(toolServerStates({ ...base, ...without }).some((s) => s.id === 'custom-my-notion'), false);
});

test('a server scoped to specific projects only serves those, and is left out of the dormant hint elsewhere', () => {
  const base = { ...DEFAULT_CONFIG, tools: { servers: [] } };
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  try {
    // Active and scoped: attached only where it actually applies.
    let patch = withToolServer(base, 'github', { enabled: true, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' } });
    patch = withToolServer({ ...base, ...patch }, 'github', { projectIds: ['proj-a'] });
    const active = { ...base, ...patch };

    assert.deepEqual(toolServerStates(active).find((s) => s.id === 'github').projectIds, ['proj-a']);
    assert.deepEqual(toolServersFor(active, 'assistant', 'claude').specs, [], 'no project: scoped server withheld');
    assert.deepEqual(
      toolServersFor(active, 'assistant', 'claude', 'proj-b').specs,
      [],
      'a different project: still withheld',
    );
    assert.deepEqual(
      toolServersFor(active, 'assistant', 'claude', 'proj-a').specs.map((spec) => spec.name),
      ['github'],
      'the matching project: attached',
    );

    // Not enabled (missing its key) and scoped: a real wall, but only in the
    // project it belongs to - elsewhere it is left out entirely rather than
    // listed as blocked, since it is not this conversation's wall to climb.
    const blocked = { ...base, ...withToolServer(base, 'github', { enabled: true, projectIds: ['proj-a'] }) };
    assert.ok(!dormantToolsHint(blocked, 'assistant').includes('github (GitHub)'), 'no project: left out');
    assert.ok(!dormantToolsHint(blocked, 'assistant', 'proj-b').includes('github (GitHub)'), 'other project: left out');
    assert.ok(
      dormantToolsHint(blocked, 'assistant', 'proj-a').includes('github (GitHub): needs GITHUB_PERSONAL_ACCESS_TOKEN'),
      'its own project: still a wall',
    );
  } finally {
    if (token) process.env.GITHUB_PERSONAL_ACCESS_TOKEN = token;
  }
});

test('a skill source is owner/repo, a path below it, or a GitHub URL', () => {
  assert.deepEqual(parseSkillSource('anthropics/skills/skills/pdf'), { owner: 'anthropics', repo: 'skills', path: 'skills/pdf' });
  assert.deepEqual(parseSkillSource('vercel-labs/skills'), { owner: 'vercel-labs', repo: 'skills', path: '' });
  assert.deepEqual(parseSkillSource('https://github.com/anthropics/skills/tree/main/skills/xlsx/'), {
    owner: 'anthropics', repo: 'skills', ref: 'main', path: 'skills/xlsx',
  });
  assert.deepEqual(parseSkillSource('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo', ref: undefined, path: '' });
  assert.throws(() => parseSkillSource('just-a-name'), /owner\/repo/);
  // The shelf is no longer only Anthropic's, but every entry still has to name
  // one skill folder rather than a whole repo, so importing it lands a skill
  // instead of a list of candidates to pick from.
  assert.ok(SKILL_SOURCES.every((entry) => parseSkillSource(entry.source).path !== ''));
});

test('skills live as SKILL.md folders and render into an index per audience', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rookery-skills-'));
  const store = new SkillStore(dir);
  // Everything below is about folders, so the skills Rookery ships with -
  // which have none - are filtered out; `skills.test.js` covers those.
  const written = () => store.list().filter((skill) => skill.origin !== 'builtin');
  assert.deepEqual(written(), []);

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

  const mine = (who) => store.for(who).filter((skill) => skill.origin !== 'builtin');
  assert.deepEqual(mine('assistant').map((s) => s.name), ['wochen-bericht']);
  assert.deepEqual(mine('agent').map((s) => s.name), ['deploy']);
  assert.match(renderSkillsIndex(mine('assistant')), /use_skill.*\n- wochen-bericht: Den Wochenbericht schreiben\./);
  assert.equal(renderSkillsIndex([]), '');
  assert.throws(() => store.save({ name: '', description: 'x', body: '' }), /name/);
  assert.equal(store.remove('deploy'), true);
  assert.equal(store.get('deploy'), null);
});

test('the company block lists staff, the chain of command and the mail', () => {
  const block = assistantOrgBlock(DEFAULT_CONFIG, snapshot, [
    {
      id: 'm1', orgId: 'org1', fromKind: 'agent', fromAgentId: 'a1', subject: 'Build status', body: 'Build is green.',
      threadId: 'm1', depth: 0, createdAt: now,
      recipients: [{ id: 'r1', mailId: 'm1', recipientKind: 'assistant', box: 'to' }],
    },
  ]);
  assert.match(block, /ben — Ben, Junior Engineer .* reports to: mara/);
  assert.match(block, /reports to: the assistant/);
  assert.match(block, /from mara to assistant - subject: Build status\n\s*Build is green/);
  assert.match(renderOrgOverview({ ...snapshot, agents: [] }), /none yet/);
});

test('an agent prompt is a member of staff, never the assistant', () => {
  const prompt = buildAgentPrompt({
    config: DEFAULT_CONFIG, agent, snapshot, memories: [], mail: [],
    assignmentId: 'abcdef12-0000', requestedBy: 'the assistant',
  });
  assert.match(prompt, /You are Mara, Backend Engineer at Rookery & Co\./);
  assert.match(prompt, /Keep the API small/);
  assert.match(prompt, /direct reports: ben/);
  assert.match(prompt, /report to whoever asked for it/);
  assert.doesNotMatch(prompt, /You are Rookery/);

  // org.lazyCoding is on by default, and off has to mean off: a switch that
  // silently changes nothing is the failure worth catching here.
  assert.match(prompt, /stop at the first rung that holds/);
  const eager = buildAgentPrompt({
    config: { ...DEFAULT_CONFIG, org: { ...DEFAULT_CONFIG.org, lazyCoding: false } },
    agent, snapshot, memories: [], mail: [],
    assignmentId: 'abcdef12-0000', requestedBy: 'the assistant',
  });
  assert.doesNotMatch(eager, /stop at the first rung that holds/);
  assert.match(eager, /Keep the API small/);
});

test('an agent prompt tells the agent to reply by mail when the assignment came from one', () => {
  const prompt = buildAgentPrompt({
    config: DEFAULT_CONFIG, agent, snapshot, memories: [], mail: [],
    assignmentId: 'abcdef12-0000', requestedBy: 'Ben (ben)', sourceMailSubject: 'Status update',
  });
  assert.match(prompt, /arrived as an email from Ben \(ben\), subject "Status update"/);
  assert.match(prompt, /reply's body/);
});

test('agents see the staff subset of the tools', () => {
  const assistant = toolsFor('assistant').map((tool) => tool.name);
  const staff = toolsFor('agent').map((tool) => tool.name);
  assert.ok(assistant.includes('hire_agent') && assistant.includes('assign'));
  assert.ok(staff.includes('assign') && staff.includes('send_mail'));
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
