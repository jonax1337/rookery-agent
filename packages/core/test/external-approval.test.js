import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, refreshExternal } from '../dist/index.js';
import {
  externalAgentStates,
  externalHookStates,
  externalPluginStates,
  externalTurnExtras,
  withExternalApproval,
} from '../dist/tools/hub.js';

/**
 * The approval chain for what lies beside the skills in a Claude Code
 * installation: subagent types and hook sets.
 *
 * The things worth a test are the ones that are easy to get wrong: nothing
 * reaches a turn before a person said so, an edited file takes its own
 * approval down with it - body edits included, and dropdown edits excluded -
 * and a plugin loaded whole does not also arrive as curated copies, nor
 * around a hook approval that was never given.
 */

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

const HOOKS = {
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node gateguard.js' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'node doc-warning.js' }] },
    ],
    SessionStart: [{ hooks: [{ type: 'command', command: 'node hello.js' }] }],
  },
};

/** One installation: a plugin with two subagents and a hook set. */
function installation() {
  const root = mkdtempSync(join(tmpdir(), 'rookery-ext-'));
  const claude = join(root, '.claude');
  const plugin = join(claude, 'plugins', 'cache', 'shop', 'kit', '1.0.0');

  write(
    join(plugin, 'agents', 'architect.md'),
    '---\nname: architect\ndescription: Designs the thing.\nmodel: sonnet\ntools: Read, Grep\n---\n\nYou are the architect.\n',
  );
  write(
    join(plugin, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reads the diff.\n---\n\nYou are the reviewer.\n',
  );
  write(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(HOOKS));

  write(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'kit@shop': [{ scope: 'user', installPath: plugin, version: '1.0.0' }] } }),
  );
  write(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'kit@shop': true } }));

  process.env.CLAUDE_CONFIG_DIR = claude;
  refreshExternal();
  return { claude, plugin, sourceId: 'claude-code:plugin/kit@shop' };
}

const fresh = () => ({
  ...DEFAULT_CONFIG,
  tools: { servers: [] },
  external: { enabled: true, skillSources: {}, servers: {}, agents: {}, hooks: {}, plugins: {} },
});

/** Apply a pure patch the way the route does, without the server. */
function applyPatch(config, patch) {
  assert.ok(patch, 'the id was known');
  return { ...config, external: { ...config.external, ...patch.external } };
}

test('subagents and hook sets are found, and nothing is active unasked', () => {
  const { sourceId } = installation();
  const config = fresh();

  const agents = externalAgentStates(config);
  assert.deepEqual(agents.map((agent) => agent.name), ['architect', 'reviewer']);
  const architect = agents.find((agent) => agent.name === 'architect');
  assert.equal(architect.description, 'Designs the thing.');
  assert.equal(architect.model, 'sonnet');
  assert.deepEqual(architect.tools, ['Read', 'Grep']);
  assert.equal(architect.enabled, false);
  assert.equal(architect.active, false);

  const [hooks] = externalHookStates(config);
  assert.equal(hooks.sourceId, sourceId);
  assert.deepEqual(hooks.events, ['PreToolUse', 'SessionStart']);
  assert.equal(hooks.handlerCount, 3);
  assert.equal(
    hooks.commands.some((line) => line.startsWith('PreToolUse Bash: node gateguard.js')),
    true,
    'the command lines are on the page before anybody approves them',
  );
  assert.equal(hooks.active, false);

  // The floor rides along even when nothing was ever approved.
  const extras = externalTurnExtras(config, 'assistant');
  assert.equal(extras.handoffAgents, undefined);
  assert.equal(extras.hooks, undefined);
  assert.equal(extras.pluginDirs, undefined);
  assert.ok(extras.settings.permissions.deny.length > 0, 'a full turn has limits now');
});

test('an approved subagent reaches the turn as its file, for its audience', () => {
  const { plugin, sourceId } = installation();
  let config = fresh();

  config = applyPatch(
    config,
    withExternalApproval(config, 'agent', sourceId + '/architect', { enabled: true, audience: 'agents' }),
  );

  assert.equal(externalAgentStates(config).find((agent) => agent.name === 'architect').active, true);
  assert.equal(externalTurnExtras(config, 'assistant').handoffAgents, undefined, 'approved for agents only');

  // The file, not a prompt string: the provider copies it into the generated
  // plugin folder, so the bytes that run are the bytes that were approved.
  const forAgents = externalTurnExtras(config, 'agent');
  assert.deepEqual(forAgents.handoffAgents, [{ name: 'architect', path: join(plugin, 'agents', 'architect.md') }]);
});

test('an edited hooks.json locks itself out again', () => {
  const { plugin, sourceId } = installation();
  let config = fresh();

  config = applyPatch(config, withExternalApproval(config, 'hook', sourceId, { enabled: true, audience: 'assistant' }));
  const approved = externalTurnExtras(config, 'assistant');
  assert.deepEqual(Object.keys(approved.hooks).sort(), ['PreToolUse', 'SessionStart']);
  assert.equal(approved.hooks.PreToolUse.length, 2, 'the document goes over as declared');
  assert.ok(approved.settings.permissions.deny.length > 0, 'the floor stays under the hooks');

  // Somebody edits the file after the approval. The scan is cached for
  // minutes, so the second read at spawn time is what has to catch this.
  const edited = JSON.parse(JSON.stringify(HOOKS));
  edited.hooks.PreToolUse[0].hooks[0].command = 'node something-else.js';
  write(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(edited));

  assert.equal(externalTurnExtras(config, 'assistant').hooks, undefined, 'not handed over any more');

  refreshExternal();
  const state = externalHookStates(config)[0];
  assert.equal(state.enabled, true, 'the decision is still on record');
  assert.equal(state.changed, true);
  assert.equal(state.active, false, 'but it waits for somebody to look again');
});

test('a dropdown change is not a second look: it does not re-approve an edited file', () => {
  const { plugin, sourceId } = installation();
  let config = fresh();

  config = applyPatch(config, withExternalApproval(config, 'hook', sourceId, { enabled: true, audience: 'assistant' }));

  // The file changes under the approval.
  const edited = JSON.parse(JSON.stringify(HOOKS));
  edited.hooks.PreToolUse[0].hooks[0].command = 'node something-else.js';
  write(join(plugin, 'hooks', 'hooks.json'), JSON.stringify(edited));
  refreshExternal();
  assert.equal(externalHookStates(config)[0].changed, true);

  // An audience-only patch, or an empty one, must not stamp the new
  // fingerprint: that would unlock the edit without anybody reading it.
  config = applyPatch(config, withExternalApproval(config, 'hook', sourceId, { audience: 'both' }));
  assert.equal(externalHookStates(config)[0].changed, true, 'still locked');
  assert.equal(externalHookStates(config)[0].active, false);
  assert.equal(externalTurnExtras(config, 'assistant').hooks, undefined, 'and still not handed over');

  // Saying "enabled" again is the explicit second look; that re-approves.
  config = applyPatch(config, withExternalApproval(config, 'hook', sourceId, { enabled: true, audience: 'both' }));
  assert.equal(externalHookStates(config)[0].active, true);
});

test('an edited subagent body takes its approval down with it', () => {
  const { plugin, sourceId } = installation();
  let config = fresh();

  config = applyPatch(
    config,
    withExternalApproval(config, 'agent', sourceId + '/architect', { enabled: true, audience: 'agents' }),
  );
  assert.equal(externalTurnExtras(config, 'agent').handoffAgents.length, 1);

  // Same frontmatter, different instructions: the fingerprint covers the
  // body, because the body is what the spawned subagent runs under.
  write(
    join(plugin, 'agents', 'architect.md'),
    '---\nname: architect\ndescription: Designs the thing.\nmodel: sonnet\ntools: Read, Grep\n---\n\nYou are someone else entirely.\n',
  );
  refreshExternal();

  const state = externalAgentStates(config).find((agent) => agent.name === 'architect');
  assert.equal(state.changed, true, 'the body edit is visible');
  assert.equal(state.active, false);
  assert.equal(externalTurnExtras(config, 'agent').handoffAgents, undefined, 'not copied anywhere');
});

test('a plugin loaded whole arrives once, and not around a missing hook approval', () => {
  const { plugin, sourceId } = installation();
  let config = fresh();

  // The whole-plugin switch without the hook set approved: loading the folder
  // would bring the hooks along whatever the per-capability switch says, so
  // the source is left out entirely for that audience.
  config = applyPatch(
    config,
    withExternalApproval(config, 'plugin', sourceId, { loadWhole: true, audience: 'both' }),
  );
  assert.equal(externalTurnExtras(config, 'agent').pluginDirs, undefined, 'no hooks approved, no folder');

  // With the hooks approved too, the folder goes over whole - and the
  // curated copies stay home so nothing arrives twice.
  config = applyPatch(config, withExternalApproval(config, 'hook', sourceId, { enabled: true, audience: 'both' }));
  config = applyPatch(
    config,
    withExternalApproval(config, 'agent', sourceId + '/architect', { enabled: true, audience: 'both' }),
  );
  assert.equal(externalPluginStates(config)[0].active, true);

  const extras = externalTurnExtras(config, 'agent');
  assert.deepEqual(extras.pluginDirs, [plugin]);
  assert.equal(extras.handoffAgents, undefined, 'the curated copy stays home');
  assert.equal(extras.hooks, undefined, 'so does the curated hook set');
});

test('reading the installation at all can be switched off', () => {
  installation();
  const config = { ...fresh(), external: { ...fresh().external, enabled: false } };
  assert.deepEqual(externalAgentStates(config), []);
  assert.deepEqual(externalHookStates(config), []);
  const extras = externalTurnExtras(config, 'assistant');
  assert.equal(extras.handoffAgents, undefined);
  assert.ok(extras.settings.permissions.deny.length > 0, "the floor is Rookery's own, not the installation's");
});
