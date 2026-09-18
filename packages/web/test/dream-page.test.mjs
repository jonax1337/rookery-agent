import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

/**
 * The dream section of the nights page (AP16).
 *
 * Both subjects pull in the whole component tree, so nothing here renders
 * anything: the pure declarations are read out of the real source with the
 * TypeScript compiler and run in isolation, the route `sleep-phases.test.mjs`
 * and `config-save.test.mjs` already take. What cannot be run - which template
 * a card stands on, which route a button posts to - is asserted against the
 * source text, because that is exactly where those mistakes are made.
 *
 * They run under `npm test -w @rookery/web`; the root `npm test` only collects
 * `packages/core/test/*.test.js` and never sees this file.
 */

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8');

/**
 * The same file with every comment gone.
 *
 * What a card must not *do* cannot be asserted against a file whose doc block
 * explains at length what it must not do: the prose would trip every one of
 * those assertions. So the checks that look for machinery look at the code
 * alone.
 */
function code(relativePath) {
  return ts.transpileModule(read(relativePath), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.Preserve, removeComments: true },
  }).outputText;
}

const PAGE = '../src/pages/MemorySleepPage.tsx';
const SECTION = '../src/components/common/dream-section.tsx';
const CURVE = '../src/components/blocks/version-curve-card.tsx';
const API = '../src/lib/api.ts';
const CORE_TYPES = '../../core/src/types.ts';

/**
 * Run one or more top-level declarations of a `.tsx` file on their own.
 *
 * Type annotations go through the transpiler, imports do not come along - so
 * only declarations that stand by themselves can be asked for, which is the
 * whole set this file is interested in.
 */
function declarations(relativePath, names) {
  const source = ts.createSourceFile(
    relativePath,
    read(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = {};
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.getText(source))) {
      found[node.name.getText(source)] = node.getText(source).replace(/^export\s+/, '');
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (names.includes(name) && declaration.initializer) {
          found[name] = 'const ' + name + ' = ' + declaration.initializer.getText(source) + ';';
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const name of names) assert.ok(found[name], relativePath + ' still declares ' + name);
  const js = ts.transpileModule(names.map((name) => found[name]).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(js + '\nreturn { ' + names.join(', ') + ' };')();
}

/** A finished night that changed nothing - every counter at zero. */
function night(extra = {}) {
  return {
    id: 'run-1',
    status: 'done',
    mergedCount: 0,
    dormantCount: 0,
    edgeCount: 0,
    insightCount: 0,
    skillCount: 0,
    skillRevisedCount: 0,
    learnedCount: 0,
    ...extra,
  };
}

/* ------------------------------ the counters ------------------------------ */

test('the five dream counters have a column label', () => {
  const { COLUMN_LABELS } = declarations(PAGE, ['COLUMN_LABELS']);
  for (const key of [
    'dreamTracesSeen',
    'dreamFramesScored',
    'dreamCandidates',
    'dreamPromoted',
    'dreamLabelsWritten',
  ]) {
    assert.ok(COLUMN_LABELS[key], 'COLUMN_LABELS has no label for ' + key);
  }
});

test('every dream counter the night writes is named in the column list', () => {
  // The source of truth is core's own `SleepRun`, so a sixth counter added
  // there fails here rather than staying invisible in the table.
  const types = read(CORE_TYPES);
  const declared = [...types.matchAll(/^\s+(dream[A-Z]\w*)\?:/gm)].map((match) => match[1]);
  assert.ok(declared.length >= 5, 'core SleepRun declares its dream counters');
  const { COLUMN_LABELS } = declarations(PAGE, ['COLUMN_LABELS']);
  for (const key of declared) {
    assert.ok(COLUMN_LABELS[key], 'COLUMN_LABELS has no label for ' + key);
  }
});

test('the report drawer lists every dream counter it has a column for', () => {
  const page = read(PAGE);
  for (const key of [
    'dreamTracesSeen',
    'dreamFramesScored',
    'dreamCandidates',
    'dreamPromoted',
    'dreamLabelsWritten',
  ]) {
    // Once as a table column, once in the drawer's MetaList.
    const uses = page.split('report.' + key).length - 1;
    assert.equal(uses, 1, 'the report drawer reads report.' + key + ' exactly once');
    assert.ok(page.includes("countColumn('" + key + "'"), 'the table has a column for ' + key);
  }
});

/* -------------------------------- undoable -------------------------------- */

test('a night whose only effect was a promotion is undoable (E18)', () => {
  const { undoable } = declarations(PAGE, ['undoable']);
  assert.equal(undoable(night({ dreamPromoted: 1 })), true);
});

test('a night whose only effect was dream labels is undoable', () => {
  const { undoable } = declarations(PAGE, ['undoable']);
  assert.equal(undoable(night({ dreamLabelsWritten: 4 })), true);
});

test('measuring alone leaves nothing to undo', () => {
  const { undoable } = declarations(PAGE, ['undoable']);
  // Looking at traces, scoring frames and writing an unmeasured candidate
  // change nothing an undo could take back.
  assert.equal(
    undoable(night({ dreamTracesSeen: 40, dreamFramesScored: 12, dreamCandidates: 6 })),
    false,
  );
});

test('a promotion does not resurrect the undo button on a failed or undone night', () => {
  const { undoable } = declarations(PAGE, ['undoable']);
  assert.equal(undoable(night({ dreamPromoted: 1, status: 'failed' })), false);
  assert.equal(undoable(night({ dreamPromoted: 1, undoneAt: 1 })), false);
});

test('a night from before the dream counters is read as zero, not as undefined', () => {
  const { undoable } = declarations(PAGE, ['undoable']);
  assert.equal(undoable(night()), false);
});

/* ------------------------------ the curve --------------------------------- */

test('the version curve is its own card, not the calendar trend card', () => {
  // The whole point of AP16's curve: `TrendChartCard` filters against a window
  // relative to Date.now() and stacks its series, so version-indexed rows in
  // 0..1 would render an empty card rather than an error - the one failure
  // nothing on screen would report.
  const curve = code(CURVE);
  assert.ok(curve.includes('ChartContainer'), 'the version curve stands on ChartContainer');
  assert.ok(!curve.includes('trend-chart-card'), 'the version curve does not reuse the trend card');
  assert.ok(!curve.includes('stackId'), 'the version curve stacks nothing');
  assert.ok(!/Date\.now\(\)/.test(curve), 'the version curve filters against no calendar window');

  const section = code(SECTION);
  assert.ok(section.includes('VersionCurveCard'), 'the dream section draws the version curve');
  assert.ok(!section.includes('TrendChartCard'), 'the dream section does not draw a trend card');
});

test('the curve reads a missing measurement as a gap, never as zero', () => {
  const { seriesValue } = declarations(CURVE, ['seriesValue']);
  assert.equal(seriesValue({ version: 1, recall: 0.42 }, 'recall'), 0.42);
  assert.equal(seriesValue({ version: 1 }, 'recall'), null);
  assert.equal(seriesValue({ version: 1, recall: Number.NaN }, 'recall'), null);
});

/* ------------------------------- freezing --------------------------------- */

test('all four freeze reasons of concept 10.3 have a label and a sentence', () => {
  const types = read(CORE_TYPES);
  const union = /export type DreamSlotFreezeReason = ([^;]+);/.exec(types);
  assert.ok(union, 'core types.ts declares the DreamSlotFreezeReason union');
  const declared = [...union[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(declared, ['calibration', 'staleness', 'agreement', 'manual']);

  const { FREEZE_REASON } = declarations(SECTION, ['FREEZE_REASON']);
  assert.deepEqual(Object.keys(FREEZE_REASON).sort(), [...declared].sort());
  for (const reason of declared) {
    assert.ok(FREEZE_REASON[reason].label, reason + ' has a label');
    assert.ok(FREEZE_REASON[reason].detail.length > 20, reason + ' says what happened');
  }
});

test('a frozen slot says which of the two things it is doing', () => {
  const section = read(SECTION);
  // Concept 10.3: it keeps measuring and stops promoting. Both halves of that
  // sentence have to be on screen, or the action item is only half honest.
  assert.match(section, /keeps measuring/);
  assert.match(section, /no longer promotes/);
  assert.ok(section.includes('is frozen'), 'the action item names the slot as frozen');
});

/* ------------------------------ the diff sheet ---------------------------- */

test('the diff sheet names every number a promotion stood on', () => {
  const section = read(SECTION);
  for (const label of ['ci_low', 'audit_ci_low', 'Delta', 'Baseline', 'Holdout score']) {
    assert.ok(section.includes(label), 'the diff sheet shows ' + label);
  }
  // Field, before, after, delta - the parameter table itself.
  for (const head of ['Field', 'Before', 'After']) {
    assert.ok(section.includes('<TableHead>' + head + '</TableHead>'), 'the diff table has ' + head);
  }
  assert.ok(section.includes('sheet.rationale'), 'the diff sheet shows the rationale');
  assert.ok(section.includes('DetailDrawer'), 'the diff sheet is the existing drawer template');
});

test('the diff sheet computes a delta only where both sides are numbers', () => {
  const { diffParams } = declarations(SECTION, ['flattenParams', 'diffParams']);
  const rows = diffParams({ limit: 8, mode: 'wide' }, { limit: 12, mode: 'narrow' });
  const limit = rows.find((row) => row.field === 'limit');
  const mode = rows.find((row) => row.field === 'mode');
  assert.equal(limit.delta, 4);
  assert.equal(limit.changed, true);
  assert.equal(mode.delta, undefined);
  assert.equal(mode.changed, true);

  // A first promotion has nothing before it: every field is new, and no delta
  // may be invented against a default the version does not carry.
  const first = diffParams(undefined, { limit: 12 });
  assert.equal(first.length, 1);
  assert.equal(first[0].delta, undefined);
  assert.equal(first[0].changed, true);

  // The weights are the policy. `w` as one cell of raw JSON would hide that
  // three of four moved, so one level of nesting is flattened into its own
  // rows - and each of those rows gets a real delta.
  const weighted = diffParams(
    { w: { relevance: 0.55, usage: 0.1 } },
    { w: { relevance: 0.5, usage: 0.1 } },
  );
  assert.deepEqual(
    weighted.map((row) => row.field),
    ['w.relevance', 'w.usage'],
  );
  assert.ok(Math.abs(weighted[0].delta + 0.05) < 1e-9);
  assert.equal(weighted[0].changed, true);
  assert.equal(weighted[1].changed, false);

  // An unchanged field is kept and marked, not dropped: the sheet shows the
  // whole parameter set, and it has to be visible what did not move.
  const same = diffParams({ limit: 12 }, { limit: 12 });
  assert.equal(same[0].changed, false);
  assert.equal(same[0].delta, 0);
});

test('the revert button posts to the route the concept names', () => {
  const api = read(API);
  assert.match(api, /revertPolicy:/);
  assert.ok(
    api.includes("'/api/dream/policies/' + encodeURIComponent(id) + '/revert'"),
    'revertPolicy posts to /api/dream/policies/:id/revert',
  );
  assert.match(api, /revert'[\s\S]{0,160}method: 'POST'/);

  const section = read(SECTION);
  assert.ok(section.includes('api.revertPolicy('), 'the diff sheet calls it');
  assert.ok(section.includes('Revert this promotion'), 'the button says what it does');
  assert.ok(section.includes('confirm('), 'reverting is confirmed first, like undoing a night');
});

/* ------------------------------ the empty case ---------------------------- */

test('the switched-off dream reads as switched off', () => {
  const section = read(SECTION);
  assert.ok(section.includes('The dream is switched off'), 'the empty state names the cause');
  assert.ok(
    section.includes('memory.dream.enabled'),
    'the empty state names the setting it read, not an invented reason',
  );
  assert.ok(section.includes('dream.enabled'), 'the section reads the served config');

  // Three states, not two. The served config arrives behind the provider probe,
  // which takes seconds on a real installation; claiming "nothing written yet"
  // in the meantime asserts a cause the page does not know, and on a default
  // installation that cause is wrong.
  assert.ok(
    section.includes('Reading the dream settings'),
    'an unknown config says it is unknown rather than naming a reason',
  );
  assert.ok(
    /!dream[\s\S]{0,120}Reading the dream settings/.test(section),
    'the unknown state is keyed on the absent config, not on a counter',
  );
});

test('the capped history names its own base', () => {
  const section = read(SECTION);
  assert.ok(section.includes('HISTORY_LIMIT'), 'the section knows its own limit');
  assert.ok(section.includes('cappedBadge('), 'a capped list wears the house badge');
  assert.match(section, /versions per slot/, 'the card says what its numbers rest on');
});

/* ------------------------------ no fourth tab ----------------------------- */

test('the dream stays a section of the nights page', () => {
  const page = read(PAGE);
  assert.ok(page.includes('<DreamSection'), 'the nights page renders the dream section');
  const navigation = read('./page-navigation.test.mjs');
  assert.ok(
    navigation.includes('children'),
    'page-navigation still guards the child routes of /memory',
  );
});
