import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_CONFIG,
  dormantToolsHint,
  externalScan,
  externalSkillsFor,
  externalSources,
  findExternalSkills,
  openExternalSkill,
  refreshExternal,
  renderExternalSkillsHint,
  toolServerStates,
  toolServersFor,
  withToolServer,
} from '../dist/index.js';
import { mcpConfig } from '../dist/providers/claude-code.js';

/**
 * Reading the Claude Code installed on the same machine.
 *
 * Every test builds its own home under the temp directory and points the
 * environment override at it, so nothing here depends on what the developer
 * happens to have installed - `test/setup.mjs` makes "nothing" the baseline
 * for the rest of the suite.
 */

function skill(dir, name, description, extra = '') {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, 'SKILL.md'),
    '---\nname: ' + name + '\ndescription: ' + description + '\n' + extra + '---\n\nBody of ' + name + '.\n',
    'utf8',
  );
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** What `.claude.json` holds in the fixture, so a test can rewrite one server. */
function claudeConfig(nodeRepl) {
  return JSON.stringify({
    mcpServers: {
      atlas: { command: 'atlas.exe', args: ['mcp'] },
      node_repl: nodeRepl,
      // The very server the enabled plugin declares, word for word: one
      // server, whichever of the two the scan happens to reach first.
      docs: { type: 'http', url: 'https://docs.example/mcp' },
    },
    projects: { 'E:/work/thing': { mcpServers: { local: { command: 'local.exe', args: [] } } } },
  });
}

/**
 * One installation: Claude Code with its own skills, one enabled plugin and
 * one switched off, plus the MCP servers a person added themselves.
 */
function installation() {
  const root = mkdtempSync(join(tmpdir(), 'rookery-cli-'));
  const claude = join(root, '.claude');

  skill(join(claude, 'skills'), 'invoice-run', 'Close the month and file the invoices.');
  skill(join(claude, 'skills'), 'ledger', 'Reconcile the ledger.');

  const on = join(claude, 'plugins', 'cache', 'shop', 'pdf-tools', '1.0.0');
  skill(join(on, 'skills'), 'pdf-forms', 'Fill in and flatten PDF forms.');
  skill(join(on, 'skills'), 'pdf-split', 'Split a PDF into pages.');
  skill(join(on, 'skills'), 'ledger', 'The plugin has one of these too.');
  write(join(on, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }));

  const off = join(claude, 'plugins', 'cache', 'shop', 'noisy', '1.0.0');
  skill(join(off, 'skills'), 'do-not-want', 'Should never turn up.');

  write(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({
      version: 2,
      plugins: {
        'pdf-tools@shop': [{ scope: 'user', installPath: on, version: '1.0.0' }],
        'noisy@shop': [{ scope: 'user', installPath: off, version: '1.0.0' }],
      },
    }),
  );
  write(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'pdf-tools@shop': true, 'noisy@shop': false } }));
  write(
    join(claude, '.claude.json'),
    claudeConfig({ command: 'C:\\tools\\node_repl.exe', args: ['--fast'], env: { NODE_PATH: 'C:/tools/node' } }),
  );

  process.env.CLAUDE_CONFIG_DIR = claude;
  refreshExternal();
  return { root, claude };
}

/** A config that reads the installation but has decided nothing yet. */
const fresh = () => ({
  ...DEFAULT_CONFIG,
  tools: { servers: [] },
  external: { enabled: true, skillSources: {}, servers: {} },
});

test('the installation is read, and a switched-off plugin stays out', () => {
  installation();
  const scan = externalScan();

  const ids = scan.sources.map((source) => source.id).sort();
  assert.deepEqual(ids, ['claude-code:home', 'claude-code:plugin/pdf-tools@shop']);
  assert.equal(
    scan.sources.find((source) => source.id === 'claude-code:plugin/pdf-tools@shop')?.label,
    'Claude Code - pdf-tools',
    'and it says where it came from',
  );

  assert.equal(scan.skills.some((entry) => entry.name === 'do-not-want'), false, 'a plugin set to false is not read');
  assert.equal(scan.skills.find((entry) => entry.name === 'pdf-split')?.description, 'Split a PDF into pages.');
  assert.equal(scan.skills.find((entry) => entry.name === 'invoice-run')?.audience, 'both', 'no audience means everyone');

  const byName = Object.fromEntries(scan.servers.map((server) => [server.name, server]));
  assert.deepEqual(Object.keys(byName).sort(), ['atlas', 'docs', 'local', 'node_repl']);
  // The plugin and the person's own file declare `docs` identically: one server.
  assert.equal(scan.servers.filter((server) => server.name === 'docs').length, 1);
  assert.match(byName.docs.id, /^ext-claude-code-/, 'the id survives a rescan, so a decision about it does too');
  assert.equal(byName.docs.transport, 'http');
  assert.equal(byName.docs.url, 'https://docs.example/mcp');
  assert.equal(byName.node_repl.command, 'C:\\tools\\node_repl.exe');
  assert.deepEqual(byName.node_repl.args, ['--fast']);
  assert.equal(byName.node_repl.env.NODE_PATH, 'C:/tools/node');
  assert.ok(byName.local.projectPath, 'a server kept under a project path carries it');
});

test('a plugin shelf is offered but not taken, and the prompt only says it is there', () => {
  installation();
  const config = fresh();

  const sources = Object.fromEntries(externalSources(config).map((entry) => [entry.source.id, entry.enabled]));
  assert.equal(sources['claude-code:home'], true, "the person's own folder is their own set");
  assert.equal(sources['claude-code:plugin/pdf-tools@shop'], false, 'a plugin waits to be asked');

  assert.equal(openExternalSkill(config, 'assistant', 'pdf-split'), null, 'a shelf nobody switched on cannot be opened');
  assert.deepEqual(findExternalSkills(config, 'assistant', 'pdf'), []);

  const hint = renderExternalSkillsHint(config, 'assistant');
  assert.match(hint, /find_skill/);
  assert.match(hint, /invoice-run/, 'the own folder is named with a few examples');
  assert.equal(hint.includes('Body of'), false, 'never the instructions themselves');

  // Switch the plugin on and its skills become findable - still not listed.
  const on = {
    ...config,
    external: { ...config.external, skillSources: { 'claude-code:plugin/pdf-tools@shop': true } },
  };
  const hits = findExternalSkills(on, 'assistant', 'pdf');
  assert.deepEqual(hits.map((hit) => hit.name), ['pdf-forms', 'pdf-split']);
  assert.match(hits[0].label, /Claude Code - pdf-tools/);
  const opened = openExternalSkill(on, 'assistant', 'pdf-split');
  assert.match(opened.body, /Body of pdf-split/, 'the body is read only when it is asked for');
  assert.match(opened.source, /Claude Code - pdf-tools/);

  // `ledger` is on two switched-on shelves. The one a person put in their own
  // folder is the one that counts, and it counts once.
  const ledgers = externalSkillsFor(on, 'assistant').filter((entry) => entry.name === 'ledger');
  assert.equal(ledgers.length, 1, 'the same name on two shelves is offered once');
  assert.equal(ledgers[0].sourceId, 'claude-code:home', "and it is the person's own copy");

  // Switch that folder off and the plugin's copy takes over - which is why
  // this cannot be decided once while reading the disk.
  const pluginOnly = {
    ...on,
    external: { ...on.external, skillSources: { ...on.external.skillSources, 'claude-code:home': false } },
  };
  assert.equal(
    externalSkillsFor(pluginOnly, 'assistant').find((entry) => entry.name === 'ledger')?.sourceId,
    'claude-code:plugin/pdf-tools@shop',
  );
});

test('a discovered MCP server waits for a person, and an edited one stops attaching', () => {
  const { claude } = installation();
  const config = fresh();

  const state = toolServerStates(config).find((entry) => entry.name === 'node_repl');
  assert.equal(state.install, 'external');
  assert.equal(state.enabled, false, 'nothing found starts by itself');
  assert.equal(state.approvalRequired, true, 'and the assistant may not switch it on');
  assert.deepEqual(toolServersFor(config, 'assistant', 'claude').specs, []);

  // The assistant is told they exist without being told it can have them.
  const hint = dormantToolsHint(config, 'assistant');
  assert.match(hint, /further MCP servers are installed/);
  assert.equal(hint.includes(state.id), false, 'not offered by id, since it cannot attach one');

  const approved = { ...config, ...withToolServer(config, state.id, { enabled: true }) };
  const specs = toolServersFor(approved, 'assistant', 'claude').specs;
  assert.deepEqual(specs.map((spec) => spec.name), ['node_repl'], 'only the one that was approved');
  assert.equal(specs[0].command, 'C:\\tools\\node_repl.exe');
  assert.equal(approved.external.servers[state.id].fingerprint, state.external.fingerprint);

  // The same server, started differently: approval was for what was there.
  writeFileSync(join(claude, '.claude.json'), claudeConfig({ command: 'C:\\tools\\other.exe', args: [] }), 'utf8');
  refreshExternal();
  const after = toolServerStates(approved).find((entry) => entry.name === 'node_repl');
  assert.equal(after.changed, true, 'the definition moved on');
  assert.equal(after.active, false, 'so it stays out until somebody looks');
  assert.deepEqual(toolServersFor(approved, 'assistant', 'claude').specs, []);
});

test('a hosted endpoint reaches the harness in the shape it speaks', () => {
  const http = {
    name: 'context7',
    transport: 'http',
    args: [],
    env: {},
    url: 'https://mcp.context7.com/mcp',
    headers: { Authorization: 'token' },
  };
  const stdio = { name: 'atlas', transport: 'stdio', command: 'C:\\bin\\atlas.exe', args: ['mcp'], env: { A: 'b' } };

  const claude = mcpConfig([http, stdio]);
  assert.deepEqual(claude.mcpServers.context7, {
    type: 'http',
    url: 'https://mcp.context7.com/mcp',
    headers: { Authorization: 'token' },
  });
  assert.equal(claude.mcpServers.atlas.command, 'C:/bin/atlas.exe', 'paths go over in forward slashes');
  assert.deepEqual(claude.mcpServers.atlas.args, ['mcp']);
  assert.equal(claude.mcpServers.atlas.env.A, 'b');
});

test('looking at the installation can be switched off entirely', () => {
  installation();
  const config = { ...fresh(), external: { enabled: false, skillSources: {}, servers: {} } };

  assert.deepEqual(externalSources(config), []);
  assert.equal(renderExternalSkillsHint(config, 'assistant'), '');
  assert.equal(toolServerStates(config).some((state) => state.install === 'external'), false);
});
