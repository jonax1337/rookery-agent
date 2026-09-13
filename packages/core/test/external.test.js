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
import { readToml } from '../dist/external/toml.js';
import { mcpConfig } from '../dist/providers/claude-code.js';
import { mcpArgs } from '../dist/providers/codex.js';

/**
 * Reading the Claude Code and Codex installed on the same machine.
 *
 * Every test builds its own pair of homes under the temp directory and points
 * the two environment overrides at them, so nothing here depends on what the
 * developer happens to have installed - `test/setup.mjs` makes "nothing"
 * the baseline for the rest of the suite.
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

/**
 * A pair of installations: Claude Code with an own skill, one enabled plugin
 * and one switched off, and Codex with its own skill and an MCP server.
 */
function installations() {
  const root = mkdtempSync(join(tmpdir(), 'rookery-cli-'));
  const claude = join(root, '.claude');
  const codex = join(root, '.codex');

  skill(join(claude, 'skills'), 'invoice-run', 'Close the month and file the invoices.');

  const on = join(claude, 'plugins', 'cache', 'shop', 'pdf-tools', '1.0.0');
  skill(join(on, 'skills'), 'pdf-forms', 'Fill in and flatten PDF forms.');
  skill(join(on, 'skills'), 'pdf-split', 'Split a PDF into pages.');
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
    JSON.stringify({
      mcpServers: { atlas: { command: 'atlas.exe', args: ['mcp'] } },
      projects: { 'E:/work/thing': { mcpServers: { local: { command: 'local.exe', args: [] } } } },
    }),
  );

  skill(join(codex, 'skills'), 'ledger', 'Reconcile the ledger.');
  write(
    join(codex, 'config.toml'),
    [
      'model = "gpt-5"',
      '',
      '[mcp_servers.node_repl]',
      "command = 'C:\\tools\\node_repl.exe'",
      'args = ["--fast"]',
      '',
      '[mcp_servers.node_repl.env]',
      'NODE_PATH = "C:/tools/node"',
      '',
      '[plugins."pdf-tools@shop"]',
      'enabled = true',
      '',
      '[plugins."noisy@shop"]',
      'enabled = false',
      '',
      '[hooks.state]',
      '',
      'this line is not TOML at all',
      '',
      '[desktop]',
      'efforts = ["low", "high"]',
    ].join('\n'),
  );
  // The same plugin, installed in Codex too and one version further along -
  // three skills against the two in Claude Code, so this is the copy that
  // survives the fold. It declares the same MCP server, word for word.
  const codexPlugin = join(codex, 'plugins', 'cache', 'shop', 'pdf-tools', 'latest');
  skill(join(codexPlugin, 'skills'), 'pdf-sign', 'Sign a PDF.');
  skill(join(codexPlugin, 'skills'), 'pdf-notes', 'Annotate a PDF.');
  skill(join(codexPlugin, 'skills'), 'ledger', 'The plugin has one of these too.');
  write(join(codexPlugin, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp' } } }));
  skill(join(codex, 'plugins', 'cache', 'shop', 'pdf-tools', '0.9.0', 'skills'), 'old-one', 'An older version.');
  skill(join(codex, 'plugins', 'cache', 'shop', 'noisy', '1.0.0', 'skills'), 'also-not-wanted', 'Switched off in Codex too.');

  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
  refreshExternal();
  return { root, claude, codex };
}

/** A config that reads the installations but has decided nothing yet. */
const fresh = () => ({
  ...DEFAULT_CONFIG,
  tools: { servers: [] },
  external: { enabled: true, skillSources: {}, servers: {} },
});

test('the TOML reader keeps what it understands and steps over the rest', () => {
  const doc = readToml(
    [
      '# a comment',
      'name = "rookery"',
      'count = 12',
      '[a.b]',
      "path = 'C:\\Program Files\\thing'",
      'list = [',
      '  "one",',
      '  "two",',
      ']',
      'this line is not TOML at all',
      'after = true',
      '[plugins."x@y"]',
      'enabled = false',
    ].join('\n'),
  );

  assert.equal(doc.name, 'rookery');
  assert.equal(doc.count, 12);
  assert.equal(doc.a.b.path, 'C:\\Program Files\\thing', 'a literal string keeps its backslashes');
  assert.deepEqual(doc.a.b.list, ['one', 'two']);
  assert.equal(doc.a.b.this, undefined, 'a line that does not read is skipped');
  assert.equal(doc.a.b.after, true, 'and what follows it is still read');
  assert.equal(doc.plugins['x@y'].enabled, false, 'a quoted table key stays whole');
});

test('both installations are read, and a switched-off plugin stays out', () => {
  installations();
  const scan = externalScan();

  // One plugin, installed in both CLIs, is one shelf - not two switches that
  // mean the same thing.
  const ids = scan.sources.map((source) => source.id).sort();
  assert.deepEqual(ids, ['claude-code:home', 'codex:home', 'plugin/pdf-tools@shop']);
  assert.equal(
    scan.sources.find((source) => source.id === 'plugin/pdf-tools@shop')?.label,
    'Claude Code and Codex - pdf-tools',
    'and it says so',
  );

  assert.equal(scan.skills.some((entry) => entry.name === 'do-not-want'), false, 'a plugin set to false is not read');
  assert.equal(scan.skills.some((entry) => entry.name === 'also-not-wanted'), false, 'nor in Codex');
  assert.equal(scan.skills.some((entry) => entry.name === 'old-one'), false, 'the older version folder loses to latest');
  assert.equal(scan.skills.find((entry) => entry.name === 'pdf-sign')?.description, 'Sign a PDF.');
  assert.equal(scan.skills.some((entry) => entry.name === 'pdf-forms'), false, 'the poorer of the two installs is dropped');
  assert.equal(scan.skills.find((entry) => entry.name === 'invoice-run')?.audience, 'both', 'no audience means everyone');

  const byName = Object.fromEntries(scan.servers.map((server) => [server.name, server]));
  assert.deepEqual(Object.keys(byName).sort(), ['atlas', 'docs', 'local', 'node_repl']);
  // Both copies of the plugin declare `docs` with the same URL: one server.
  assert.equal(scan.servers.filter((server) => server.name === 'docs').length, 1);
  assert.equal(byName.docs.label, 'Claude Code and Codex - pdf-tools');
  assert.match(byName.docs.id, /^ext-both-/, 'the id belongs to neither, so a rescan cannot flip it');
  assert.equal(byName.docs.transport, 'http');
  assert.equal(byName.docs.url, 'https://docs.example/mcp');
  assert.equal(byName.node_repl.command, 'C:\\tools\\node_repl.exe');
  assert.deepEqual(byName.node_repl.args, ['--fast']);
  assert.equal(byName.node_repl.env.NODE_PATH, 'C:/tools/node');
  assert.ok(byName.local.projectPath, 'a server kept under a project path carries it');
});

test('a plugin shelf is offered but not taken, and the prompt only says it is there', () => {
  installations();
  const config = fresh();

  const sources = Object.fromEntries(externalSources(config).map((entry) => [entry.source.id, entry.enabled]));
  assert.equal(sources['claude-code:home'], true, "a CLI's own folder is the person's own set");
  assert.equal(sources['plugin/pdf-tools@shop'], false, 'a plugin waits to be asked');

  assert.equal(openExternalSkill(config, 'assistant', 'pdf-sign'), null, 'a shelf nobody switched on cannot be opened');
  assert.deepEqual(findExternalSkills(config, 'assistant', 'pdf'), []);

  const hint = renderExternalSkillsHint(config, 'assistant');
  assert.match(hint, /find_skill/);
  assert.match(hint, /invoice-run/, 'the own folders are named with a few examples');
  assert.equal(hint.includes('Body of'), false, 'never the instructions themselves');

  // Switch the plugin on and its skills become findable - still not listed.
  const on = { ...config, external: { ...config.external, skillSources: { 'plugin/pdf-tools@shop': true } } };
  const hits = findExternalSkills(on, 'assistant', 'pdf');
  assert.deepEqual(hits.map((hit) => hit.name), ['pdf-notes', 'pdf-sign']);
  assert.match(hits[0].label, /Claude Code and Codex/);
  const opened = openExternalSkill(on, 'assistant', 'pdf-sign');
  assert.match(opened.body, /Body of pdf-sign/, 'the body is read only when it is asked for');
  assert.match(opened.source, /Claude Code and Codex/);

  // `ledger` is on two switched-on shelves. The one a person put in the CLI's
  // own folder is the one that counts, and it counts once.
  const both = { ...on, external: { ...on.external, skillSources: { ...on.external.skillSources, 'codex:home': true } } };
  const ledgers = externalSkillsFor(both, 'assistant').filter((entry) => entry.name === 'ledger');
  assert.equal(ledgers.length, 1, 'the same name on two shelves is offered once');
  assert.equal(ledgers[0].sourceId, 'codex:home', "and it is the person's own copy");

  // Switch that folder off and the plugin's copy takes over - which is why
  // this cannot be decided once while reading the disk.
  const pluginOnly = { ...on, external: { ...on.external, skillSources: { ...on.external.skillSources, 'codex:home': false } } };
  assert.equal(
    externalSkillsFor(pluginOnly, 'assistant').find((entry) => entry.name === 'ledger')?.sourceId,
    'plugin/pdf-tools@shop',
  );
});

test('a discovered MCP server waits for a person, and an edited one stops attaching', () => {
  const { codex } = installations();
  const config = fresh();

  const state = toolServerStates(config).find((entry) => entry.name === 'node_repl');
  assert.equal(state.install, 'external');
  assert.equal(state.enabled, false, 'nothing found starts by itself');
  assert.equal(state.approvalRequired, true, 'and the assistant may not switch it on');
  assert.deepEqual(toolServersFor(config, 'assistant', 'codex').specs, []);

  // The assistant is told they exist without being told it can have them.
  const hint = dormantToolsHint(config, 'assistant');
  assert.match(hint, /further MCP servers are installed/);
  assert.equal(hint.includes(state.id), false, 'not offered by id, since it cannot attach one');

  const approved = { ...config, ...withToolServer(config, state.id, { enabled: true }) };
  const specs = toolServersFor(approved, 'assistant', 'codex').specs;
  assert.deepEqual(specs.map((spec) => spec.name), ['node_repl'], 'only the one that was approved');
  assert.equal(specs[0].command, 'C:\\tools\\node_repl.exe');
  assert.equal(approved.external.servers[state.id].fingerprint, state.external.fingerprint);

  // The same server, started differently: approval was for what was there.
  writeFileSync(
    join(codex, 'config.toml'),
    ['[mcp_servers.node_repl]', "command = 'C:\\tools\\other.exe'", 'args = []'].join('\n'),
    'utf8',
  );
  refreshExternal();
  const after = toolServerStates(approved).find((entry) => entry.name === 'node_repl');
  assert.equal(after.changed, true, 'the definition moved on');
  assert.equal(after.active, false, 'so it stays out until somebody looks');
  assert.deepEqual(toolServersFor(approved, 'assistant', 'codex').specs, []);
});

test('a hosted endpoint reaches both CLIs in the shape each of them speaks', () => {
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

  // Codex takes a streamable HTTP server by URL and has nowhere to put a
  // header, so the header is dropped rather than smuggled in somewhere else.
  const codex = mcpArgs(http).join(' ');
  assert.match(codex, /mcp_servers\.context7\.url = "https:\/\/mcp\.context7\.com\/mcp"/);
  assert.equal(codex.includes('Authorization'), false);
  assert.equal(codex.includes('.command'), false);
  assert.match(mcpArgs(stdio).join(' '), /mcp_servers\.atlas\.command = "C:\/bin\/atlas\.exe"/);
});

test('looking at the two installations can be switched off entirely', () => {
  installations();
  const config = { ...fresh(), external: { enabled: false, skillSources: {}, servers: {} } };

  assert.deepEqual(externalSources(config), []);
  assert.equal(renderExternalSkillsHint(config, 'assistant'), '');
  assert.equal(toolServerStates(config).some((state) => state.install === 'external'), false);
});
