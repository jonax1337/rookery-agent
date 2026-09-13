import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  ProviderRegistry,
  SkillStore,
  SleepRunner,
  Store,
  admitCandidates,
  confirmedBy,
  describeSleep,
  linkEntities,
  normalizeTokens,
  recall,
  share,
  similarity,
} from '../dist/index.js';

/**
 * The write gate, the graph and the night shift.
 *
 * The model calls are faked: a scripted provider returns the JSON a real one
 * would, so the phases are tested for what they do to the bank rather than
 * for how well a model happened to write that night.
 */

const DAY = 24 * 60 * 60 * 1000;

function makeStore() {
  return new Store(':memory:');
}

/** The same normalisation the gate uses: lower case, no stop words. */
const tokens = normalizeTokens;

/** A provider that answers each phase's prompt from a scripted table. */
function scriptedProvider(replies = {}) {
  const prompts = [];
  return {
    prompts,
    provider: {
      id: 'claude',
      displayName: 'Scripted',
      models: () => ['fake'],
      async status() {
        return { id: 'claude', available: true, binary: 'fake', authenticated: true };
      },
      async *run(options) {
        const prompt = options.prompt ?? '';
        prompts.push(prompt);
        let text = '{}';
        if (prompt.includes('You are resolving a contradiction')) text = replies.resolve ?? '{"decision":"both"}';
        else if (prompt.includes('You are tidying')) text = replies.condense ?? '{"merge":false}';
        else if (prompt.includes('You are connecting')) text = replies.link ?? '{"edges":[],"entities":[]}';
        else if (prompt.includes('You are reflecting')) text = replies.insight ?? '{"insights":[]}';
        else if (prompt.includes('You turn what an assistant has learned')) {
          text = replies.skill ?? '{"skills":[]}';
        } else if (prompt.includes('You maintain one written procedure')) {
          text = replies.revise ?? '{"revise":false}';
        }
        yield { type: 'done', text };
      },
    },
  };
}

/**
 * Throwaway skills directories, swept up when the process ends.
 *
 * The night writes skills now, and `DEFAULT_CONFIG.skillsDir` points at the
 * real home directory - a test must never be able to drop a folder in there.
 * Every runner therefore gets its own temporary one.
 */
const tempSkillDirs = [];
process.on('exit', () => {
  for (const dir of tempSkillDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRunner(store, replies, overrides = {}) {
  const scripted = scriptedProvider(replies);
  const skillsDir = mkdtempSync(join(tmpdir(), 'rookery-skills-'));
  tempSkillDirs.push(skillsDir);
  const config = {
    ...DEFAULT_CONFIG,
    skillsDir,
    memory: {
      ...DEFAULT_CONFIG.memory,
      sleep: { ...DEFAULT_CONFIG.memory.sleep, ...overrides },
    },
  };
  const runner = new SleepRunner({
    store,
    registry: new ProviderRegistry([scripted.provider]),
    config,
  });
  return { runner, scripted, config, skillsDir };
}

/* -------------------------------- the gate ------------------------------- */

test('similarity reads two wordings of one fact as the same fact', () => {
  const a = tokens('Der Nutzer arbeitet hauptsaechlich mit TypeScript');
  const b = tokens('Der Nutzer arbeitet mit TypeScript');
  assert.ok(similarity(a, b) > 0.82, 'near-identical sentences must clear the duplicate threshold');

  const c = tokens('Der Nutzer haelt Huehner im Garten');
  assert.ok(similarity(a, c) < 0.3, 'unrelated sentences must not');
  assert.equal(similarity(new Set(), a), 0);
});

test('the gate reinforces a reworded memory instead of storing it twice', () => {
  const store = makeStore();
  store.upsertMemory({
    kind: 'preference',
    content: 'Der Nutzer arbeitet hauptsaechlich mit TypeScript.',
    importance: 0.7,
  });

  const result = admitCandidates(store, {
    owner: 'assistant',
    config: DEFAULT_CONFIG.memory,
    sources: ['Ich arbeite hauptsaechlich mit TypeScript, seit Jahren schon.'],
    candidates: [
      {
        kind: 'fact',
        content: 'Der Nutzer arbeitet hauptsaechlich mit TypeScript.',
        tags: ['typescript'],
        importance: 0.8,
        evidence: 'Ich arbeite hauptsaechlich mit TypeScript',
      },
    ],
  });

  assert.equal(result.stored.length, 0, 'nothing new may be written');
  assert.equal(result.reinforced.length, 1);
  assert.equal(store.listMemories({ limit: 50 }).length, 1, 'the bank must not grow');
  store.close();
});

test('the gate drops weak candidates and stops at the per-turn cap', () => {
  const store = makeStore();
  const said =
    'Ich wohne in Hamburg. Das Wetter war heute freundlich. Ich fahre ein Lastenrad, ' +
    'mag Filterkaffee und spiele Klavier.';
  const result = admitCandidates(store, {
    owner: 'assistant',
    config: DEFAULT_CONFIG.memory,
    sources: [said],
    candidates: [
      { kind: 'fact', content: 'Der Nutzer wohnt in Hamburg.', tags: [], importance: 0.9, evidence: 'Ich wohne in Hamburg' },
      { kind: 'fact', content: 'Das Wetter war heute freundlich.', tags: [], importance: 0.2, evidence: 'Das Wetter war heute freundlich' },
      { kind: 'fact', content: 'Der Nutzer faehrt ein Lastenrad.', tags: [], importance: 0.7, evidence: 'Ich fahre ein Lastenrad' },
      { kind: 'fact', content: 'Der Nutzer mag Filterkaffee.', tags: [], importance: 0.7, evidence: 'mag Filterkaffee' },
      { kind: 'fact', content: 'Der Nutzer spielt Klavier.', tags: [], importance: 0.7, evidence: 'spiele Klavier' },
    ],
  });

  assert.equal(result.stored.length, DEFAULT_CONFIG.memory.gate.maxPerTurn);
  assert.ok(result.rejected.some((entry) => entry.reason === 'weak'), 'the 0.2 candidate is noise');
  assert.ok(result.rejected.some((entry) => entry.reason === 'over-budget'));
  store.close();
});

/* ---------------------------- the evidence rule --------------------------- */

test('confirmedBy accepts a real quote and refuses an assembled one', () => {
  const said = 'Ich arbeite unter Windows und deploye alles ueber Vercel, nie ueber Netlify.';

  assert.ok(confirmedBy('deploye alles ueber Vercel', [said]), 'a verbatim span');
  assert.ok(confirmedBy('Deploye alles ueber Vercel!', [said]), 'punctuation and case do not matter');
  assert.ok(confirmedBy('Ich arbeite unter Windows ... nie ueber Netlify', [said]), 'an elided quote');

  assert.ok(!confirmedBy('deploye ueber Netlify', [said]), 'words that never stood together');
  assert.ok(!confirmedBy('Der Nutzer bevorzugt Vercel', [said]), 'a paraphrase is not a quote');
  assert.ok(!confirmedBy('Vercel', [said]), 'one word confirms nothing');
  assert.ok(!confirmedBy('   ', [said]));
  assert.ok(!confirmedBy('deploye alles ueber Vercel', []), 'nothing to check against');
});

test('the gate refuses a candidate the user never said', () => {
  const store = makeStore();
  const result = admitCandidates(store, {
    owner: 'assistant',
    config: DEFAULT_CONFIG.memory,
    // What the user wrote was a question. It says nothing durable about them,
    // and the answer the assistant gave is not theirs to be quoted for.
    sources: ['Wie deploye ich das denn am besten?'],
    candidates: [
      {
        kind: 'preference',
        content: 'Der Nutzer deployt mit Vercel.',
        tags: ['vercel'],
        importance: 0.8,
        evidence: 'Du solltest das mit Vercel deployen',
      },
    ],
  });

  assert.equal(result.stored.length, 0, 'an unbacked claim never reaches the bank');
  assert.equal(result.rejected[0].reason, 'unconfirmed');
  assert.equal(store.listMemories({ limit: 50 }).length, 0);
  store.close();
});

test('a stored memory keeps the words it stands on', () => {
  const store = makeStore();
  const result = admitCandidates(store, {
    owner: 'assistant',
    config: DEFAULT_CONFIG.memory,
    sources: ['Ich schreibe am liebsten Rust, alles andere fuehlt sich zaeh an.'],
    candidates: [
      {
        kind: 'preference',
        content: 'Der Nutzer schreibt am liebsten Rust.',
        tags: ['rust'],
        importance: 0.8,
        evidence: 'Ich schreibe am liebsten Rust',
      },
    ],
  });

  assert.equal(result.stored.length, 1);
  assert.equal(result.stored[0].evidence, 'Ich schreibe am liebsten Rust');
  assert.equal(store.getMemory(result.stored[0].id).evidence, 'Ich schreibe am liebsten Rust');
  store.close();
});

test('reinforcement raises importance but never usefulness', () => {
  const store = makeStore();
  const first = store.upsertMemory({ kind: 'fact', content: 'Der Nutzer wohnt in Hamburg.', importance: 0.5 });
  store.upsertMemory({ kind: 'fact', content: 'Der Nutzer wohnt in Hamburg.', importance: 0.5 });
  const after = store.getMemory(first.id);

  assert.ok(after.importance > 0.5 && after.importance < 0.6, 'the bump is small on purpose');
  assert.equal(after.usefulness, 0, 'being written again is not evidence of being useful');

  store.touchMemories([first.id]);
  assert.ok(store.getMemory(first.id).usefulness > 0, 'an actual recall is');
  store.close();
});

/* -------------------------------- the graph ------------------------------ */

test('recall reaches a memory through a shared entity that no word matches', () => {
  const store = makeStore();
  const preference = store.upsertMemory({
    kind: 'preference',
    content: 'Der Nutzer schreibt am liebsten TypeScript.',
    tags: ['typescript'],
    importance: 0.6,
  });
  const project = store.upsertMemory({
    kind: 'project',
    content: 'Rookery ist in TypeScript geschrieben und laeuft auf Node.',
    tags: ['typescript'],
    importance: 0.6,
  });
  linkEntities(store, 'assistant', preference.id, ['typescript']);
  linkEntities(store, 'assistant', project.id, ['typescript']);

  const hits = recall(store, { text: 'Woran laeuft Rookery?', limit: 8, touch: false });
  const ids = hits.map((hit) => hit.id);
  assert.ok(ids.includes(project.id), 'the direct hit');
  assert.ok(ids.includes(preference.id), 'and the one only the graph could reach');
  assert.equal(hits.find((hit) => hit.id === preference.id).hop, 'entity');
  store.close();
});

test('a sleeping memory is out of recall but still in the bank', () => {
  const store = makeStore();
  const memory = store.upsertMemory({
    kind: 'fact',
    content: 'Der Nutzer nutzte frueher eine Kaffeemaschine von Jura.',
    importance: 0.6,
  });
  assert.equal(recall(store, { text: 'Kaffeemaschine Jura', touch: false }).length, 1);

  store.sleepMemory(memory.id);
  assert.equal(recall(store, { text: 'Kaffeemaschine Jura', touch: false }).length, 0, 'gone from recall');
  assert.equal(store.listMemories({ limit: 50 }).length, 1, 'still stored');
  assert.ok(store.getMemory(memory.id).dormantAt, 'and marked as asleep');

  store.wakeMemory(memory.id);
  assert.equal(recall(store, { text: 'Kaffeemaschine Jura', touch: false }).length, 1, 'and it comes back');
  store.close();
});

/* -------------------------------- the night ------------------------------ */

test('decay puts weak, unused memories to sleep and never touches protected ones', async () => {
  const store = makeStore();
  const old = Date.now() - 200 * DAY;

  const weak = store.upsertMemory({ kind: 'fact', content: 'Ein belangloser alter Hinweis.', importance: 0.2 });
  const mine = store.upsertMemory({
    kind: 'fact',
    content: 'Ein ebenso belangloser Hinweis, aber von Hand.',
    importance: 0.2,
    origin: 'user',
  });
  const pinned = store.upsertMemory({
    kind: 'fact',
    content: 'Ein angehefteter belangloser Hinweis.',
    importance: 0.2,
    pinned: true,
  });
  const strong = store.upsertMemory({ kind: 'fact', content: 'Der Nutzer heisst Jonas.', importance: 0.9 });

  // Age everything past the dormancy window.
  for (const id of [weak.id, mine.id, pinned.id, strong.id]) {
    store.db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(old, old, id);
  }

  const { runner } = makeRunner(store);
  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.status, 'done');
  assert.ok(store.getMemory(weak.id).dormantAt, 'the weak one sleeps');
  assert.equal(store.getMemory(mine.id).dormantAt, undefined, 'what the user wrote is untouchable');
  assert.equal(store.getMemory(pinned.id).dormantAt, undefined, 'so is what they pinned');
  assert.equal(store.getMemory(strong.id).dormantAt, undefined, 'and so is what carries weight');
  assert.equal(store.listMemories({ limit: 50 }).length, 4, 'nothing was deleted');
  store.close();
});

test('condensing folds a cluster into one memory and the originals sleep, not vanish', async () => {
  const store = makeStore();
  const first = store.upsertMemory({
    kind: 'project',
    content: 'Rookery nutzt Fastify im Server.',
    tags: ['rookery', 'server'],
    importance: 0.6,
  });
  const second = store.upsertMemory({
    kind: 'project',
    content: 'Der Rookery-Server liefert die Web-UI aus.',
    tags: ['rookery', 'server'],
    importance: 0.6,
  });
  for (const memory of [first, second]) {
    linkEntities(store, 'assistant', memory.id, ['rookery', 'server']);
  }

  const { runner } = makeRunner(store, {
    condense: JSON.stringify({
      merge: true,
      content: 'Der Rookery-Server nutzt Fastify und liefert die Web-UI aus.',
      kind: 'project',
      importance: 0.7,
      tags: ['rookery'],
      supersedes: [1, 2],
    }),
  });

  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.mergedCount, 1);
  assert.ok(store.getMemory(first.id).dormantAt, 'the originals sleep');
  assert.ok(store.getMemory(second.id).dormantAt);

  const live = store.liveMemories('assistant');
  assert.equal(live.length, 1);
  assert.match(live[0].content, /Fastify und liefert/);
  assert.equal(live[0].origin, 'sleep');
  assert.equal(store.getMemory(first.id).supersededBy, live[0].id);
  // The condensed memory inherits the entities, so the graph keeps its shape.
  assert.ok(store.entitiesFor(live[0].id).length >= 2);
  store.close();
});

test('a night can be taken back exactly', async () => {
  const store = makeStore();
  const first = store.upsertMemory({
    kind: 'project',
    content: 'Rookery nutzt Fastify im Server.',
    tags: ['rookery', 'server'],
    importance: 0.6,
  });
  const second = store.upsertMemory({
    kind: 'project',
    content: 'Der Rookery-Server liefert die Web-UI aus.',
    tags: ['rookery', 'server'],
    importance: 0.6,
  });
  for (const memory of [first, second]) {
    linkEntities(store, 'assistant', memory.id, ['rookery', 'server']);
  }
  const before = store
    .liveMemories('assistant')
    .map((memory) => memory.id)
    .sort();

  const { runner } = makeRunner(store, {
    condense: JSON.stringify({
      merge: true,
      content: 'Der Rookery-Server nutzt Fastify und liefert die Web-UI aus.',
      kind: 'project',
      importance: 0.7,
      tags: [],
      supersedes: [1, 2],
    }),
  });
  const run = await runner.run({ owner: 'assistant' });
  assert.equal(store.liveMemories('assistant').length, 1);

  const undone = runner.undo(run.id);
  assert.equal(undone.woken, 2);
  assert.equal(undone.removed, 1);

  const after = store
    .liveMemories('assistant')
    .map((memory) => memory.id)
    .sort();
  assert.deepEqual(after, before, 'the bank is exactly as it was');
  assert.ok(store.getSleepRun(run.id).undoneAt, 'and the night is marked as taken back');
  assert.equal(runner.undo(run.id), null, 'undoing twice is not a thing');
  store.close();
});

test('an insight needs at least two pieces of evidence', async () => {
  const store = makeStore();
  for (const content of [
    'Der Nutzer arbeitet abends an Rookery.',
    'Der Nutzer hat gestern am Gedaechtnis gearbeitet.',
    'Der Nutzer plant den Schlaf-Lauf fuer Rookery.',
    'Der Nutzer nutzt Windows als Arbeitsrechner.',
  ]) {
    store.upsertMemory({ kind: 'event', content, importance: 0.6 });
  }

  const { runner } = makeRunner(store, {
    insight: JSON.stringify({
      insights: [
        {
          content: 'Der Nutzer entwickelt Rookery abends und schwerpunktmaessig am Gedaechtnis.',
          importance: 0.8,
          evidence: [1, 3],
          tags: [],
        },
        { content: 'Der Nutzer mag vermutlich Katzen.', importance: 0.8, evidence: [2], tags: [] },
      ],
    }),
  });

  const run = await runner.run({ owner: 'assistant' });
  assert.equal(run.insightCount, 1, 'the one-source guess is thrown away');

  const insights = store.listMemories({ kinds: ['insight'], limit: 10 });
  assert.equal(insights.length, 1);
  assert.match(insights[0].content, /abends/);
  // An insight points at what it came from, so it can be checked.
  const neighbourhood = store.neighbourhood(insights[0].id);
  assert.equal(neighbourhood.outgoing.filter((edge) => edge.relation === 'refines').length, 2);
  store.close();
});

test('the night stays inside its model budget', async () => {
  const store = makeStore();
  // Twenty pairs: far more clusters than the budget allows.
  for (let index = 0; index < 20; index += 1) {
    const a = store.upsertMemory({
      kind: 'project',
      content: 'Thema ' + index + ': der erste Hinweis zu diesem Gegenstand.',
      importance: 0.6,
    });
    const b = store.upsertMemory({
      kind: 'project',
      content: 'Thema ' + index + ': der zweite Hinweis zu diesem Gegenstand.',
      importance: 0.6,
    });
    for (const memory of [a, b]) {
      linkEntities(store, 'assistant', memory.id, ['thema-' + index, 'hinweis']);
    }
  }

  const { runner } = makeRunner(store, {}, { maxMergeCalls: 3 });
  const run = await runner.run({ owner: 'assistant' });

  assert.ok(run.modelCalls <= 3 + 3 + 1 + 1, 'condense, link, insight and the skill call are all capped');
  store.close();
});

/* --------------------------- skills from memory --------------------------- */

test('the night writes a skill out of what the memory keeps repeating', async () => {
  const store = makeStore();
  for (let index = 0; index < 8; index += 1) {
    store.upsertMemory({
      kind: 'project',
      content: 'Beim Release Nummer ' + index + ' musste zuerst der Core gebaut werden.',
      importance: 0.7,
    });
  }

  const { runner, skillsDir } = makeRunner(store, {
    skill: JSON.stringify({
      skills: [
        {
          name: 'Release Checklist',
          description: 'Wenn ein Release des Web-Pakets rausgeht',
          body:
            '## Schritte\n1. `npm run build:core` zuerst, sonst zieht der Server alte Typen.\n' +
            '2. `npm test` gegen packages/core laufen lassen.\n3. Erst danach `npm run package`.\n' +
            'Falle: der Server listet statische Dateien beim Start, also nach dem Build neu starten.',
          evidence: [1, 2, 3],
        },
      ],
    }),
  });
  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.skillCount, 1, 'the run says it wrote one');
  const written = new SkillStore(skillsDir).get('release-checklist');
  assert.ok(written, 'and the file is really there, under the slugged name');
  assert.equal(written.origin, 'sleep', 'marked as the night, not as the user');
  assert.equal(written.audience, 'assistant', "the assistant's bank writes the assistant's skills");
  assert.match(run.report, /1 skill written/);
  store.close();
});

/* ------------------------- skills that improve ---------------------------- */

/** A skill on disk plus the memories the night would have distilled it from. */
function seedSkill(store, skillsDir, { name = 'release-checklist', sources = 3 } = {}) {
  const skills = new SkillStore(skillsDir);
  const skill = skills.save({
    name,
    description: 'Wenn ein Release rausgeht',
    body: '## Schritte\n1. `npm run build:core` zuerst.\n2. `npm test` laufen lassen.\n3. Dann paketieren.',
    origin: 'sleep',
  });
  const memories = [];
  for (let index = 0; index < sources; index += 1) {
    memories.push(
      store.upsertMemory({
        kind: 'project',
        content: 'Beim Release Nummer ' + index + ' musste zuerst der Core gebaut werden.',
        importance: 0.7,
      }),
    );
  }
  store.setSkillSources(skill.name, 'assistant', memories.map((memory) => memory.id));
  return { skills, skill, memories };
}

/** The revision the scripted model hands back. */
const REVISION = JSON.stringify({
  revise: true,
  description: 'Wenn ein Release des Web-Pakets rausgeht',
  body:
    '## Schritte\n1. `npm run build:workspace` zuerst - `build:core` gibt es nicht mehr.\n' +
    '2. `npm test` laufen lassen.\n3. Dann paketieren.\nFalle: den Server nach dem Build neu starten.',
});

test('the night rewrites a skill whose source memory was replaced', async () => {
  const store = makeStore();
  const { runner, skillsDir } = makeRunner(store, { skill: '{"skills":[]}', revise: REVISION });
  const { skills, skill, memories } = seedSkill(store, skillsDir);

  // What the skill was built on no longer says what it said: the night
  // decided a contradiction and filed this one away behind a winner.
  const winner = store.upsertMemory({
    kind: 'project',
    content: 'Das Build-Skript heisst seit dem 12.09.2026 build:workspace.',
    importance: 0.8,
  });
  store.updateMemory(memories[0].id, { supersededBy: winner.id });

  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.skillRevisedCount, 1, 'the moved ground was noticed');
  assert.match(skills.get(skill.name).body, /build:workspace/, 'the skill now names the command that exists');
  assert.match(run.report, /1 skill revised/);

  // The trigger is consumed: the source now points at the memory that holds,
  // so a second night has nothing to react to and spends no call on it.
  const settled = store.skillSourceIds(skill.name);
  assert.ok(settled.includes(winner.id), 'the chain followed the replacement');
  assert.ok(!settled.includes(memories[0].id), 'and let go of the retired one');
  store.close();
});

test('the night rewrites a skill that a failed run had open', async () => {
  const store = makeStore();
  const { runner, skillsDir } = makeRunner(store, { skill: '{"skills":[]}', revise: REVISION });
  const { skills, skill } = seedSkill(store, skillsDir);

  const org = store.org.createOrganization({ name: 'Rookery' });
  const agent = store.org.createAgent({ orgId: org.id, name: 'Ada', title: 'Engineer', instructions: 'Work.' });
  const assignment = store.org.createAssignment({
    orgId: org.id,
    agentId: agent.id,
    task: 'Ein Release rausbringen',
    requesterKind: 'assistant',
  });
  store.org.updateAssignment(assignment.id, {
    status: 'failed',
    error: 'npm error Missing script: "build:core"',
    finishedAt: Date.now(),
  });
  store.recordSkillUse({ skill: skill.name, owner: 'assistant', assignmentId: assignment.id });

  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.skillRevisedCount, 1, 'a run that followed it and failed is evidence enough');
  assert.match(skills.get(skill.name).body, /build:workspace/);
  store.close();
});

test('a reviewed skill is not asked about again the next night', async () => {
  const store = makeStore();
  const { runner, scripted, skillsDir } = makeRunner(store, {
    skill: '{"skills":[]}',
    // The model looks and decides the skill still holds.
    revise: '{"revise":false}',
  });
  const { skill, memories } = seedSkill(store, skillsDir);
  store.sleepMemory(memories[0].id);

  await runner.run({ owner: 'assistant' });
  const askedFirst = scripted.prompts.filter((prompt) => prompt.includes('You maintain one written procedure')).length;
  assert.equal(askedFirst, 1, 'the sleeping source put it in front of the model once');

  await runner.run({ owner: 'assistant' });
  const askedTotal = scripted.prompts.filter((prompt) => prompt.includes('You maintain one written procedure')).length;
  assert.equal(askedTotal, 1, 'and looking at it cleared the trigger, so the second night skips it');
  assert.ok(!store.skillSourceIds(skill.name).includes(memories[0].id), 'the sleeping source was let go');
  store.close();
});

test('undoing a night puts the skills back as they were', async () => {
  const store = makeStore();
  const { runner, skillsDir } = makeRunner(store, {
    revise: REVISION,
    skill: JSON.stringify({
      skills: [
        {
          name: 'deploy-notes',
          description: 'Wie deployt wird',
          body: 'Ein Rumpf, der lang genug ist, um die Mindestlaenge fuer einen Skill zu erreichen, ' +
            'und der eine Prozedur beschreibt, die so vorher nicht aufgeschrieben war.',
          evidence: [1, 2, 3],
        },
      ],
    }),
  });
  // Seven, because the creation pass needs a bank with something in it
  // before it will consider writing anything at all.
  const { skills, skill, memories } = seedSkill(store, skillsDir, { sources: 7 });
  const before = skills.raw(skill.name);

  const winner = store.upsertMemory({
    kind: 'project',
    content: 'Das Build-Skript heisst seit dem 12.09.2026 build:workspace.',
    importance: 0.8,
  });
  store.updateMemory(memories[0].id, { supersededBy: winner.id });

  const run = await runner.run({ owner: 'assistant' });
  assert.equal(run.skillRevisedCount, 1, 'one rewritten');
  assert.equal(run.skillCount, 1, 'and one newly written');
  assert.ok(skills.get('deploy-notes'), 'the new one is there');

  const result = runner.undo(run.id);

  assert.equal(result.skills, 2, 'both the rewrite and the creation were taken back');
  assert.equal(skills.raw(skill.name), before, 'the rewritten skill reads exactly as it did');
  assert.equal(skills.get('deploy-notes'), null, 'and the one the night invented is gone again');
  store.close();
});

test('the night refuses to overwrite a skill the user wrote', async () => {
  const store = makeStore();
  for (let index = 0; index < 8; index += 1) {
    store.upsertMemory({
      kind: 'project',
      content: 'Beim Release Nummer ' + index + ' musste zuerst der Core gebaut werden.',
      importance: 0.7,
    });
  }

  const { runner, skillsDir } = makeRunner(store, {
    skill: JSON.stringify({
      skills: [
        {
          name: 'release-checklist',
          description: 'Die Nacht haette gern diesen Namen',
          body: 'Ein Text, der lang genug ist, um die Mindestlaenge fuer einen Skill zu erreichen, ' +
            'und der die vom Nutzer geschriebene Anleitung ueberschreiben wuerde.',
          evidence: [1, 2, 3],
        },
      ],
    }),
  });

  const skills = new SkillStore(skillsDir);
  skills.save({
    name: 'release-checklist',
    description: 'Vom Nutzer geschrieben',
    body: 'Das hier hat ein Mensch aufgeschrieben und es bleibt so.',
  });

  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.skillCount, 0, 'nothing was written');
  assert.equal(skills.get('release-checklist').description, 'Vom Nutzer geschrieben');
  assert.equal(skills.get('release-checklist').origin, 'user');
  store.close();
});

test('the report says what happened in words a person reads', () => {
  assert.equal(
    describeSleep({ readCount: 42, mergedCount: 0, dormantCount: 0, edgeCount: 0, insightCount: 0, conflictCount: 0 }),
    '42 memories read, nothing to do.',
  );
  // A decided contradiction reads as decided; only what is left over is "offen".
  assert.match(
    describeSleep({
      readCount: 42,
      mergedCount: 2,
      dormantCount: 9,
      edgeCount: 14,
      insightCount: 1,
      conflictCount: 3,
      resolvedCount: 2,
    }),
    /2 condensed, 9 tidied, 14 connections added, 2 contradictions resolved, 1 contradiction open, 1 insight recorded\./,
  );
});

test('the call budget is split across cycles, front- or back-loaded', () => {
  // Whatever the weighting, the parts add up to exactly the budget.
  for (const cycles of [1, 2, 3, 4]) {
    for (const bias of ['early', 'late']) {
      let sum = 0;
      for (let cycle = 1; cycle <= cycles; cycle += 1) sum += share(12, cycles, cycle, bias);
      assert.equal(sum, 12, cycles + ' cycles, ' + bias);
    }
  }
  // Deep work leans on the first cycle, dreaming on the last.
  assert.ok(share(12, 2, 1, 'early') > share(12, 2, 2, 'early'));
  assert.ok(share(12, 2, 2, 'late') > share(12, 2, 1, 'late'));
});

test('the night decides a contradiction and files the losing side away', async () => {
  const store = makeStore();
  const windows = store.upsertMemory({
    kind: 'fact',
    content: 'Der Nutzer arbeitet an einem Rechner mit Windows 11.',
    importance: 0.7,
  });
  const linux = store.upsertMemory({
    kind: 'fact',
    content: 'Der Nutzer ist inzwischen auf Linux umgestiegen.',
    importance: 0.7,
  });
  store.addEdge({
    owner: 'assistant',
    srcId: windows.id,
    dstId: linux.id,
    relation: 'contradicts',
    weight: 0.9,
    origin: 'sleep',
  });

  // The model picks the second sentence: the newer state holds.
  const { runner } = makeRunner(store, { resolve: JSON.stringify({ decision: 'second' }) });
  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.resolvedCount, 1);
  assert.ok(store.getMemory(windows.id).dormantAt, 'the outdated side is filed away');
  assert.equal(store.getMemory(windows.id).supersededBy, linux.id);
  assert.equal(store.getMemory(linux.id).dormantAt, undefined, 'the one that holds stays');
  assert.equal(store.listMemories({ limit: 10 }).length, 2, 'nothing was deleted');

  // Recall now answers with one side instead of two contradicting ones.
  const hits = recall(store, { text: 'Welches Betriebssystem nutzt der Nutzer?', touch: false });
  assert.equal(hits.length, 1);
  assert.match(hits[0].content, /Linux/);
  store.close();
});

test('what the user wrote wins a contradiction without asking a model', async () => {
  const store = makeStore();
  const mine = store.upsertMemory({
    kind: 'preference',
    content: 'Der Nutzer moechte immer deutsche Oberflaechentexte.',
    importance: 0.8,
    origin: 'user',
  });
  const guessed = store.upsertMemory({
    kind: 'preference',
    content: 'Der Nutzer moechte englische Oberflaechentexte.',
    importance: 0.8,
  });
  store.addEdge({
    owner: 'assistant',
    srcId: guessed.id,
    dstId: mine.id,
    relation: 'contradicts',
    weight: 0.9,
    origin: 'sleep',
  });

  // No resolve reply is scripted: if a model were asked, the decision would fail.
  const { runner, scripted } = makeRunner(store);
  const run = await runner.run({ owner: 'assistant' });

  assert.equal(run.resolvedCount, 1);
  assert.equal(store.getMemory(mine.id).dormantAt, undefined, 'the user always wins');
  assert.ok(store.getMemory(guessed.id).dormantAt, 'the inferred one is filed away');
  assert.ok(
    !scripted.prompts.some((prompt) => prompt.includes('You are resolving a contradiction')),
    'and it cost no model call',
  );
  store.close();
});
