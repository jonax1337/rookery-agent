import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_SKILLS,
  SkillStore,
  externalSkillsFor,
  externalSources,
  isBuiltinSkill,
  loadConfig,
  matchSkills,
  openExternalSkill,
  refreshExternal,
  renderSkillMatches,
  renderSkillsIndex,
} from '../dist/index.js';

/**
 * The skill shelf, and above all the lowest layer of it: what Rookery ships
 * is there before anybody has written anything, and stays read-only without
 * being immovable - a person can put their own version over it.
 */

function home() {
  return mkdtempSync(join(tmpdir(), 'rookery-skills-'));
}

/** A skill folder written by hand, the way an import or a person leaves one. */
function writeSkill(dir, name, meta, body) {
  mkdirSync(join(dir, name), { recursive: true });
  const front = Object.entries(meta).map(([key, value]) => key + ': ' + value).join('\n');
  writeFileSync(join(dir, name, 'SKILL.md'), '---\n' + front + '\n---\n\n' + body + '\n', 'utf8');
}

test('an empty installation already has the shipped skills, for both audiences', () => {
  const store = new SkillStore(home());
  const names = store.list().map((skill) => skill.name);

  for (const builtin of BUILTIN_SKILLS) {
    assert.ok(names.includes(builtin.name), 'shipped skill ' + builtin.name + ' is on the shelf');
    assert.ok(isBuiltinSkill(builtin.name));

    const skill = store.get(builtin.name);
    assert.equal(skill.origin, 'builtin');
    assert.equal(skill.path, '', 'a shipped skill has no folder on disk');
    assert.deepEqual(skill.files, []);
    assert.ok(skill.body.length > 500, 'it carries real instructions, not a stub');
    assert.ok(skill.description.trim().length > 0, 'and a line for the prompt index');
  }

  assert.ok(renderSkillsIndex(store.for('agent')).includes('claude-code'));
  assert.ok(renderSkillsIndex(store.for('assistant')).includes('claude-code'));
});

test('the claude-code skill says what a Rookery turn cannot do', () => {
  const body = new SkillStore(home()).get('claude-code').body;

  // The whole point of shipping it: an agent that believes in tools this
  // harness does not have burns a run finding out.
  assert.match(body, /ultracode/i);
  // Verified against the harness rather than assumed: `--restricted` is what
  // removes the Workflow tool, so the skill must tie it to the permission
  // level instead of denying it outright.
  assert.match(body, /Workflow tool/);
  assert.match(body, /only at permission/);
  assert.match(body, /restricted/);
  assert.match(body, /No slash commands/);
  assert.match(body, /Task/);
});

test('a person may put their own version over a shipped skill, and get it back', () => {
  const dir = home();
  const store = new SkillStore(dir);

  const mine = store.save({ name: 'claude-code', description: 'My own take', body: 'Do it my way.' });
  assert.equal(mine.origin, 'user');
  assert.equal(store.get('claude-code').description, 'My own take');
  assert.equal(store.list().filter((skill) => skill.name === 'claude-code').length, 1, 'one row, not two');

  assert.equal(store.remove('claude-code'), true, 'the copy is what gets deleted');
  assert.equal(store.get('claude-code').origin, 'builtin', 'and the shipped text is back');
  assert.equal(store.remove('claude-code'), false, 'the shipped one itself cannot be deleted');
});

test('nothing unattended may shadow a shipped skill', () => {
  const store = new SkillStore(home());

  for (const origin of ['agent', 'sleep']) {
    assert.throws(
      () => store.save({ name: 'claude-code', description: 'rewritten', body: 'new text', origin }),
      /ships with Rookery/,
      origin + ' may not write it',
    );
  }
});

test('a folder cannot claim to be shipped by saying so in its frontmatter', () => {
  const dir = home();
  writeSkill(dir, 'claude-code', { name: 'claude-code', description: 'Mine', origin: 'builtin' }, 'Text.');

  const skill = new SkillStore(dir).get('claude-code');
  assert.equal(skill.origin, 'user', 'an unrecognised origin stays the user\'s');
  assert.notEqual(skill.path, '', 'and it is the folder that was read');
});

test('a project skill still wins over both the home shelf and the shipped one', () => {
  const dir = home();
  const project = home();
  writeSkill(project, 'claude-code', { name: 'claude-code', description: 'Project rules' }, 'Project text.');

  const store = new SkillStore([dir, project]);
  assert.equal(store.get('claude-code').description, 'Project rules');
  // Writing still lands in the home directory: an assignment never leaves a
  // skill behind in the project it was working in.
  const saved = store.save({ name: 'other', description: 'x', body: 'y' });
  assert.ok(saved.path.startsWith(dir));
});

/**
 * The second shelf: one plugin installation, read out of a fake
 * CLAUDE_CONFIG_DIR. `setup.mjs` points that variable at an empty directory
 * for every other test, so this one builds its own and puts it back.
 */
function installation() {
  const root = mkdtempSync(join(tmpdir(), 'rookery-shelf-'));
  const claude = join(root, '.claude');
  const plugin = join(claude, 'plugins', 'cache', 'ecc', 'ecc', '2.2.0');
  mkdirSync(join(plugin, 'skills', 'react-performance'), { recursive: true });
  writeFileSync(
    join(plugin, 'skills', 'react-performance', 'SKILL.md'),
    '---\nname: react-performance\ndescription: Make React fast.\n---\n\nMeasure first.\n',
    'utf8',
  );
  writeFileSync(
    join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'ecc@ecc': [{ scope: 'user', installPath: plugin, version: '2.2.0' }] } }),
    'utf8',
  );
  writeFileSync(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'ecc@ecc': true } }), 'utf8');
  return claude;
}

test('a plugin skill opens by bare name, by qualified id and the way Claude Code spells it', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = installation();
  try {
    refreshExternal();
    const config = loadConfig({ home: home() });
    const source = externalSources(config).find((entry) => entry.source.origin === 'plugin');
    assert.ok(source, 'the plugin shelf was found');
    config.external.skillSources = { [source.source.id]: true };

    const found = externalSkillsFor(config, 'agent');
    assert.deepEqual(found.map((skill) => skill.name), ['react-performance']);

    // The three spellings a model can arrive with. The third is Claude Code's
    // own (`ecc:react-performance`) and used to come back null.
    for (const spelling of ['react-performance', found[0].id, 'ecc:react-performance']) {
      const opened = openExternalSkill(config, 'agent', spelling);
      assert.ok(opened, 'use_skill(' + JSON.stringify(spelling) + ') opens the skill');
      assert.equal(opened.body, 'Measure first.');
    }

    assert.equal(openExternalSkill(config, 'agent', 'nope:react-performance'), null, 'a wrong plugin still misses');
    assert.equal(openExternalSkill(config, 'agent', 'ecc:not-a-skill'), null);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    refreshExternal();
  }
});

test('a task gets its matching skills named without anybody searching', () => {
  const dir = home();
  const store = new SkillStore(dir);
  store.save({
    name: 'wochenbericht',
    description: 'Den Wochenbericht schreiben: Zahlen sammeln, Text bauen, an den Nutzer schicken.',
    body: '1. Sammeln\n2. Schreiben',
  });
  const config = loadConfig({ home: dir });
  const own = store.for('agent');

  const hit = matchSkills(config, 'agent', own, 'Schreib bitte den Wochenbericht fuer diese Woche');
  assert.deepEqual(hit.map((match) => match.name), ['wochenbericht']);
  assert.match(renderSkillMatches(hit), /use_skill/);
  assert.match(renderSkillMatches(hit), /- wochenbericht:/);

  // The guard that makes the block worth reading: no match, no paragraph.
  assert.deepEqual(matchSkills(config, 'agent', own, 'Bitte die Kaffeemaschine entkalken'), []);
  assert.equal(renderSkillMatches([]), '');
});

test('the installed shelf is searched too, and a task about nothing matches nothing', () => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = installation();
  try {
    refreshExternal();
    const dir = home();
    const config = loadConfig({ home: dir });
    const source = externalSources(config).find((entry) => entry.source.origin === 'plugin');
    config.external.skillSources = { [source.source.id]: true };
    const own = new SkillStore(dir).for('agent');

    const matches = matchSkills(config, 'agent', own, 'Die React Performance der Seite ist schlecht');
    assert.ok(
      matches.some((match) => match.name === 'react-performance'),
      'the plugin skill is offered without find_skill being called',
    );

    // And the case that made the bar necessary: a German sentence shares one
    // word with an English description, thirty skills share it equally, and
    // naming three of them alphabetically is worse than saying nothing.
    assert.deepEqual(
      matchSkills(config, 'agent', own, 'Mach die Seite schneller, sie laedt zu lang'),
      [],
      'one coincidental word is not a match',
    );
    const block = renderSkillMatches(matches);
    assert.match(block, /react-performance/);
    assert.match(block, /Claude Code - ecc/, 'and it says which shelf it came from');

    assert.deepEqual(matchSkills(config, 'agent', own, 'Urlaubsantrag fuer Jonas eintragen'), []);
    // Only what this audience may open: a skill for agents is not offered to
    // the assistant and the other way round.
    assert.deepEqual(matchSkills(config, 'assistant', [], ''), []);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    refreshExternal();
  }
});
