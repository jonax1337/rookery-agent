import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROXY_AGREEMENT_FLOOR,
  PROXY_MIN_SAMPLES,
  TOOL_INPUT_LIMIT,
  argsHashOf,
  canonicalJson,
  divergenceProxyReport,
  episodeFromEvents,
  hashCanonicalJson,
  judgeEpisode,
} from '../dist/memory/dream/trajectory.js';

/**
 * Recorder fidelity and first-divergence judging (dream stage 2, AP7;
 * concept 7.2 and 11, Phase 6). Two claims are on trial here.
 *
 * The first is the precondition (S28): an `Edit(file_path, old_string,
 * new_string)` used to be journalled as its path alone, so any two edits of
 * one file were indistinguishable. If the hash of the three arguments does
 * not separate them, Phase 6 cannot detect a divergence and the rest of this
 * file measures nothing.
 *
 * The second is the keying (S29): observations live under `(step, argsHash)`,
 * so a diverging action can structurally not look one up. That is asserted
 * from inside a decider, not by reading the implementation - if the lookup
 * ever succeeded for an action that was never recorded, off-policy invention
 * would be back and every number after it would be fiction.
 *
 * Frozen clock: `episodeFromEvents` stamps `createdAt` from `Date.now()`, so
 * the same pattern as dream-frame.test.js holds the value still.
 */

const FIXED_NOW = Date.parse('2026-09-18T09:00:00.000Z');
const STARTED_AT = Date.parse('2026-09-18T08:59:00.000Z');

function withFrozenClock(run) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

/** A start event exactly as the recorder in claude-code.ts now yields it. */
function toolStart(name, input, id) {
  const canonical = canonicalJson(input);
  return {
    type: 'tool',
    name,
    status: 'start',
    id,
    detail: 'whatever the feed renders',
    argsHash: hashCanonicalJson(canonical),
    input: canonical.length > TOOL_INPUT_LIMIT ? canonical.slice(0, TOOL_INPUT_LIMIT) : canonical,
  };
}

/** An end event, carrying the real tool name since S28. */
function toolEnd(name, id, result, isError) {
  return { type: 'tool', name, status: 'end', id, result, ...(isError ? { isError } : {}) };
}

/** What `TurnJournal.events` hands back: each event under its sequence number. */
function journalled(events) {
  return events.map((event, index) => ({ seq: index + 1, event }));
}

const SOURCE = { owner: 'assistant', kind: 'turn', slot: 'recall', startedAt: STARTED_AT };

/** Two edits of one file plus a read - the case the old recorder flattened. */
function editEpisode() {
  const first = { file_path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' };
  const second = { file_path: 'src/a.ts', old_string: 'gamma', new_string: 'delta' };
  const events = [
    toolStart('Read', { file_path: 'src/a.ts' }, 't1'),
    toolEnd('Read', 't1', 'alpha gamma'),
    toolStart('Edit', first, 't2'),
    toolEnd('Edit', 't2', 'ok'),
    toolStart('Edit', second, 't3'),
    toolEnd('Edit', 't3', 'ok'),
    { type: 'done', text: 'done' },
  ];
  return { events, inputs: [{ file_path: 'src/a.ts' }, first, second] };
}

/** A decider that names exactly what was recorded, hashing it itself. */
function faithful(inputs, names) {
  return ({ step }) => ({ name: names[step], input: inputs[step] });
}

test('canonical JSON does not depend on the order the keys arrived in', () => {
  const one = { file_path: 'src/a.ts', old_string: 'alpha', new_string: 'beta' };
  const other = { new_string: 'beta', file_path: 'src/a.ts', old_string: 'alpha' };
  assert.equal(canonicalJson(one), canonicalJson(other));
  assert.equal(argsHashOf(one), argsHashOf(other));
  assert.equal(
    canonicalJson({ b: { z: 1, a: 2 }, a: [3, 1, 2] }),
    '{"a":[3,1,2],"b":{"a":2,"z":1}}',
    'nested keys sort too, and array order is data, not spelling',
  );
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}', 'undefined is absence');
  assert.equal(canonicalJson([undefined, 1]), '[null,1]', 'inside an array it is a hole');
  assert.equal(canonicalJson({ n: Number.NaN, i: Infinity }), '{"i":null,"n":null}');
  assert.equal(canonicalJson(undefined), 'null', 'a call with no arguments at all still hashes');
});

test('the hash separates two edits of one file - the precondition of phase 6 (S28)', () => {
  const { inputs } = editEpisode();
  const [read, first, second] = inputs;
  assert.notEqual(
    argsHashOf(first),
    argsHashOf(second),
    'same file, different replacement: the old recorder saw one path twice',
  );
  assert.notEqual(argsHashOf(first), argsHashOf(read), 'and the arguments are more than the path');
  assert.equal(argsHashOf(first).length, 64, 'sha256, hex');
});

test('truncating the recorded input never moves the hash', () => {
  const huge = { file_path: 'src/a.ts', new_string: 'x'.repeat(TOOL_INPUT_LIMIT * 2) };
  const canonical = canonicalJson(huge);
  assert.ok(canonical.length > TOOL_INPUT_LIMIT, 'the fixture is past the limit');
  const event = toolStart('Edit', huge, 't1');
  assert.equal(event.input.length, TOOL_INPUT_LIMIT, 'what is carried is cut');
  assert.equal(event.argsHash, hashCanonicalJson(canonical), 'what is keyed on is not');
  assert.notEqual(
    event.argsHash,
    hashCanonicalJson(event.input),
    'a hash over the truncation would collide for every long edit of one file',
  );
});

test('an episode is an index over the journal, not a second store', () => {
  const { events, inputs } = editEpisode();
  const { episode, steps } = withFrozenClock(() =>
    episodeFromEvents('turn-1', journalled(events), { ...SOURCE, sessionId: 's1' }),
  );

  assert.equal(episode.id, 'turn-1');
  assert.equal(episode.steps, 3, 'three tool calls, six tool events');
  assert.equal(episode.outcome, 'success', 'a `done` with no error before it');
  assert.equal(episode.holdout, false);
  assert.equal(episode.audit, false);
  assert.equal(episode.sessionId, 's1');
  assert.equal(episode.createdAt, FIXED_NOW);
  assert.equal(episode.startedAt, STARTED_AT);

  assert.deepEqual(
    steps.map((step) => [step.step, step.name, step.result]),
    [
      [0, 'Read', 'alpha gamma'],
      [1, 'Edit', 'ok'],
      [2, 'Edit', 'ok'],
    ],
    'the end event closes the start that carries its id',
  );
  assert.deepEqual(
    steps.map((step) => step.argsHash),
    inputs.map((input) => argsHashOf(input)),
    'and the arguments survive the round trip',
  );
  assert.deepEqual(
    steps.map((step) => step.at),
    [STARTED_AT, STARTED_AT, STARTED_AT],
    'turn_events has no per-step clock, so the episode start is repeated, never interpolated',
  );
});

test('bare events, out-of-order ends and errors are all read the same way', () => {
  const events = [
    toolStart('Read', { file_path: 'a' }, 't1'),
    toolStart('Read', { file_path: 'b' }, 't2'),
    toolEnd('Read', 't2', 'second first'),
    toolEnd('Read', 't1', 'boom', true),
    { type: 'error', message: 'failed', fatal: true },
  ];
  const { episode, steps } = withFrozenClock(() => episodeFromEvents('turn-2', events, SOURCE));

  assert.equal(episode.outcome, 'failure');
  assert.equal(steps[0].result, 'boom', 'correlation is on the id, not on arrival order');
  assert.equal(steps[0].isError, true);
  assert.equal(steps[1].result, 'second first');

  const overridden = withFrozenClock(() =>
    episodeFromEvents('turn-2', events, { ...SOURCE, outcome: 'success', audit: true }),
  );
  assert.equal(overridden.episode.outcome, 'success', 'an assignment knows its own result');
  assert.equal(overridden.episode.audit, true);

  const anonymous = withFrozenClock(() =>
    episodeFromEvents(
      'turn-4',
      [
        toolStart('Read', { file_path: 'a' }, undefined),
        { type: 'tool', name: 'Read', status: 'end', result: 'read it' },
      ],
      SOURCE,
    ),
  );
  assert.equal(
    anonymous.steps[0].result,
    'read it',
    'a provider that omits the id still closes the newest open step - stream order is the correlation it has',
  );
});

test('a candidate that reproduces the trajectory is no-change, and it counts', () => {
  const { events, inputs } = editEpisode();
  const { episode, steps } = withFrozenClock(() => episodeFromEvents('turn-1', journalled(events), SOURCE));
  const names = steps.map((step) => step.name);

  const judgement = judgeEpisode(steps, faithful(inputs, names), episode.outcome);
  assert.equal(judgement.verdict, 'no-change');
  assert.equal(judgement.reason, 'reproduced');
  assert.equal(judgement.divergedAt, undefined, 'k = n, so there is no k to name');
  assert.equal(judgement.agreed, 3);
  assert.equal(judgement.steps, 3);
  assert.equal(judgement.counts, true);
  assert.equal(
    judgeEpisode([], () => null, 'success').verdict,
    'no-change',
    'an episode with no tool step is reproduced trivially',
  );
});

test('a divergence on a successful episode is a regression risk at k', () => {
  const { events, inputs } = editEpisode();
  const { episode, steps } = withFrozenClock(() => episodeFromEvents('turn-1', journalled(events), SOURCE));
  const names = steps.map((step) => step.name);

  const judgement = judgeEpisode(
    steps,
    ({ step }) =>
      step === 1
        ? { name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'alpha', new_string: 'other' } }
        : { name: names[step], input: inputs[step] },
    episode.outcome,
  );
  assert.equal(judgement.verdict, 'regression-risk');
  assert.equal(judgement.reason, 'action-mismatch');
  assert.equal(judgement.divergedAt, 1);
  assert.equal(judgement.agreed, 1, 'k is what was reproduced, and nothing after it is claimed');
  assert.equal(judgement.counts, true);

  const byName = judgeEpisode(
    steps,
    ({ step }) => ({ name: step === 0 ? 'Grep' : names[step], input: inputs[step] }),
    episode.outcome,
  );
  assert.equal(byName.divergedAt, 0, 'the name alone is enough to diverge');
});

test('the same divergence on a failed episode counts for nothing', () => {
  const { events, inputs } = editEpisode();
  const failed = [...events.slice(0, -1), { type: 'error', message: 'nope', fatal: true }];
  const { episode, steps } = withFrozenClock(() => episodeFromEvents('turn-3', journalled(failed), SOURCE));
  const names = steps.map((step) => step.name);
  assert.equal(episode.outcome, 'failure');

  const judgement = judgeEpisode(
    steps,
    ({ step }) => (step === 2 ? { name: 'Bash', input: { command: 'ls' } } : { name: names[step], input: inputs[step] }),
    episode.outcome,
  );
  assert.equal(judgement.verdict, 'may-avoid-failure');
  assert.equal(judgement.divergedAt, 2);
  assert.equal(judgement.counts, false, 'the other branch was never run, so nothing verified it');

  const unknown = judgeEpisode(steps, () => ({ name: 'Bash', input: { command: 'ls' } }));
  assert.equal(unknown.verdict, 'may-avoid-failure', 'an unknown outcome carries no regression claim either');
  assert.equal(unknown.counts, false);
});

test('a diverging action can structurally not look up an observation (S29)', () => {
  const { events, inputs } = editEpisode();
  const { steps } = withFrozenClock(() => episodeFromEvents('turn-1', journalled(events), SOURCE));
  const names = steps.map((step) => step.name);
  const seen = [];

  judgeEpisode(
    steps,
    (context) => {
      const { step, prefix, observe } = context;
      assert.equal(prefix.length, step, 'the prefix is everything before k, and nothing else');
      assert.deepEqual(
        Object.keys(context).sort(),
        ['observe', 'prefix', 'step'],
        'no step count reaches the candidate: it must not be able to learn where to stop',
      );
      const invented = { file_path: 'src/a.ts', old_string: 'never', new_string: 'recorded' };
      seen.push({
        recorded: observe(step, steps[step].argsHash)?.result,
        invented: observe(step, argsHashOf(invented)),
        elsewhere: observe(step + 1, steps[step].argsHash),
      });
      return { name: names[step], input: inputs[step] };
    },
    'success',
  );

  assert.deepEqual(
    seen.map((entry) => entry.recorded),
    ['alpha gamma', 'ok', 'ok'],
    'the recorded action is served its own observation',
  );
  for (const entry of seen) {
    assert.equal(entry.invented, undefined, 'an action nobody ran has no observation to read');
    assert.equal(entry.elsewhere, undefined, 'and the same action at another step has none either');
  }
});

test('an episode recorded before S28 is missing evidence, not evidence', () => {
  const { events, inputs } = editEpisode();
  const { steps } = withFrozenClock(() => episodeFromEvents('turn-1', journalled(events), SOURCE));
  const names = steps.map((step) => step.name);
  const legacy = steps.map((step, index) => (index === 1 ? { ...step, argsHash: undefined } : step));

  const judgement = judgeEpisode(legacy, faithful(inputs, names), 'success');
  assert.equal(judgement.reason, 'unrecorded-args');
  assert.equal(judgement.divergedAt, 1);
  assert.equal(
    judgement.verdict,
    'may-avoid-failure',
    'it lands on the side that claims nothing, which is the only side a missing recording belongs on',
  );
  assert.equal(
    judgement.counts,
    false,
    'the recorder ran out, not the policy - calling that a regression would be an invented finding',
  );
});

test('a candidate that stops, or throws, ends the replay without ending the night', () => {
  const { events, inputs } = editEpisode();
  const { steps } = withFrozenClock(() => episodeFromEvents('turn-1', journalled(events), SOURCE));
  const names = steps.map((step) => step.name);

  const stopped = judgeEpisode(
    steps,
    ({ step }) => (step === 1 ? null : { name: names[step], input: inputs[step] }),
    'success',
  );
  assert.equal(stopped.reason, 'no-action');
  assert.equal(stopped.divergedAt, 1, 'the episode had a step there; naming none is a divergence');

  const threw = judgeEpisode(
    steps,
    ({ step }) => {
      if (step === 2) throw new Error('candidate blew up');
      return { name: names[step], input: inputs[step] };
    },
    'success',
  );
  assert.equal(threw.reason, 'decider-error');
  assert.equal(threw.divergedAt, 2);
});

test('the validation gate reports its disagreement instead of routing around it', () => {
  const agreeing = Array.from({ length: PROXY_MIN_SAMPLES }, (_, index) => ({
    id: 'e' + index,
    judgedAt: index % 3 === 0 ? undefined : 2,
    observedAt: index % 3 === 0 ? undefined : 2,
    steps: 5,
  }));
  const passed = divergenceProxyReport(agreeing);
  assert.equal(passed.samples, PROXY_MIN_SAMPLES);
  assert.equal(passed.agreement, 1);
  assert.equal(passed.passed, true);
  assert.equal(passed.agreementFloor, PROXY_AGREEMENT_FLOOR);
  assert.equal(passed.bothReproduced, agreeing.filter((sample) => sample.judgedAt === undefined).length);
  assert.deepEqual(passed.disagreements, []);
  assert.match(passed.note, /100%/);

  const failing = agreeing.map((sample, index) =>
    index < 10 ? { ...sample, judgedAt: 1, observedAt: 4 } : sample,
  );
  const dead = divergenceProxyReport(failing);
  assert.equal(dead.passed, false);
  assert.equal(dead.agreement, 0.5);
  assert.equal(dead.disagreements.length, 10, 'every disagreement is listed, never summarised away');
  assert.equal(dead.early, 10, 'the proxy called it before the free run had one');
  assert.equal(dead.late, 0);
  assert.match(dead.note, /Phase 6 is dead/, 'the gate says so rather than proposing a lower floor');
  assert.match(dead.note, /double run/, 'and names the only honest way back');
});

test('the gate does not pass on a sample too thin to mean anything', () => {
  const thin = divergenceProxyReport([
    { id: 'a', judgedAt: 1, observedAt: 1, steps: 4 },
    { id: 'b', judgedAt: 2, observedAt: 2, steps: 4 },
  ]);
  assert.equal(thin.agreement, 1, 'perfect agreement');
  assert.equal(thin.passed, false, 'and it still proves nothing');
  assert.match(thin.note, /needs 20/);

  const empty = divergenceProxyReport([]);
  assert.equal(empty.agreement, 0, 'no samples is not perfect agreement');
  assert.equal(empty.passed, false);

  const late = divergenceProxyReport([{ id: 'a', judgedAt: undefined, observedAt: 2, steps: 4 }], {
    minSamples: 1,
  });
  assert.equal(late.late, 1, 'finding no divergence at all is as late as it gets');
  assert.equal(late.passed, false);
});

test('the recorder and the judge share one hash definition (S28)', () => {
  const provider = readFileSync(new URL('../dist/providers/claude-code.js', import.meta.url), 'utf8');
  assert.match(
    provider,
    /memory\/dream\/trajectory\.js/,
    'a second copy of canonicalJson would make every episode diverge at step 0',
  );
  assert.match(provider, /recordedInput/, 'the start event carries argsHash and the full input');
  assert.ok(
    !/name:\s*'tool'\s*,\s*status:\s*'end'/.test(provider),
    "the end event carries the real tool name, not the literal 'tool'",
  );
});
