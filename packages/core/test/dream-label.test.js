import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REVIEW_TARGET,
  cohensKappa,
  correctionLabels,
  costOnlyShare,
  gainFrom,
  labelCoverage,
  locateTurn,
  mergeLabels,
  pairedRatings,
  pairwiseAgreement,
  reviewLabel,
  sessionsInUserLabelWindow,
  userLabel,
} from '../dist/memory/dream/label.js';

/**
 * From the source to the label (dream stage 2, AP4; concept 4).
 *
 * No frozen clock here, and that is the point of the module: it takes `now`
 * as a parameter, the reachable set as a parameter and the threshold as a
 * parameter, so every case below is a fixed input with a fixed answer instead
 * of a store state that has to be arranged first.
 *
 * The four traps of concept 4 are tested by construction, not by inspection:
 * an ambiguous quote, an anachronistic target, a merge that would walk two
 * hops, and a `review` row trying to reach DCG. Plus the case the concept
 * calls the most valuable one it has - a correction naming a row that was
 * NOT in the prompt.
 */

const OWNER = 'assistant';
const SESSION = 'session-1';
const TURN = 'turn-7';
/** `gate.duplicateThreshold`; this module never reads config itself. */
const DUPLICATE_THRESHOLD = 0.82;

const SESSION_STARTED_AT = Date.parse('2026-09-17T09:00:00.000Z');
const TURN_STARTED_AT = Date.parse('2026-09-17T10:00:00.000Z');
const NOW = Date.parse('2026-09-18T03:30:00.000Z');

/** Stood in the prompt of `TURN`. */
const PROMPTED = {
  id: 'mem-prompted',
  content: 'The user deploys the API with Docker Compose on Windows.',
  createdAt: Date.parse('2026-09-01T00:00:00.000Z'),
};

/**
 * Existed at the time of the turn and did NOT stand in the prompt - the row
 * whose label is the one thing the incumbent's own output cannot produce.
 */
const MISSING = {
  id: 'mem-missing',
  content: 'The user prefers dark roast filter coffee in the morning.',
  createdAt: Date.parse('2026-09-02T00:00:00.000Z'),
};

function correctionInput(text, overrides = {}) {
  return {
    text,
    owner: OWNER,
    sessionId: SESSION,
    turn: { id: TURN, startedAt: TURN_STARTED_AT },
    sessionStartedAt: SESSION_STARTED_AT,
    reachable: [PROMPTED, MISSING],
    prompted: [PROMPTED.id],
    duplicateThreshold: DUPLICATE_THRESHOLD,
    evidence: 'correction-1',
    now: NOW,
    ...overrides,
  };
}

function message(id, role, content, turnId) {
  return { id, role, content, createdAt: TURN_STARTED_AT, turnId, sessionId: SESSION };
}

/* --------------------------------- the quote locator --------------------------------- */

test('locateTurn: a quote in exactly one user message names that turn', () => {
  const messages = [
    message('m1', 'user', 'I deploy the API with Docker Compose on Windows.', 'turn-1'),
    message('m2', 'assistant', 'Noted.', 'turn-1'),
    message('m3', 'user', 'And the coffee is dark roast filter, always.', TURN),
  ];
  assert.deepEqual(locateTurn(messages, 'the coffee is dark roast filter'), {
    turnId: TURN,
    scope: 'turn',
  });
});

test('locateTurn: a quote occurring twice is ambiguous - null and session-wide (S3)', () => {
  const messages = [
    message('m1', 'user', 'I deploy with Docker Compose on Windows.', 'turn-1'),
    message('m2', 'user', 'As I said, I deploy with Docker Compose on Windows.', 'turn-2'),
  ];
  assert.deepEqual(locateTurn(messages, 'I deploy with Docker Compose'), {
    turnId: null,
    scope: 'session',
  });
});

test('locateTurn: never guesses - no occurrence, only the assistant, or no turn id', () => {
  const user = message('m1', 'user', 'I deploy with Docker Compose on Windows.', 'turn-1');
  const assistant = message('m2', 'assistant', 'You use Kubernetes in production.', 'turn-1');
  const untagged = message('m3', 'user', 'The coffee is dark roast filter.', undefined);

  assert.deepEqual(locateTurn([user, assistant], 'you use Kubernetes'), {
    turnId: null,
    scope: 'session',
  });
  assert.deepEqual(locateTurn([user], 'I have never touched Docker'), {
    turnId: null,
    scope: 'session',
  });
  assert.deepEqual(locateTurn([untagged], 'dark roast filter'), {
    turnId: null,
    scope: 'session',
  });
});

/* ------------------------------------- correction ------------------------------------- */

test('correction: a row that was NOT in the prompt gets relevance 1 (concept 4.2a, case two)', () => {
  const labels = correctionLabels(correctionInput(MISSING.content));
  assert.equal(labels.length, 1);
  assert.deepEqual(labels[0], {
    turnId: TURN,
    target: MISSING.id,
    source: 'correction',
    relevance: 1,
    scope: 'turn',
    owner: OWNER,
    sessionId: SESSION,
    evidence: 'correction-1',
    createdAt: NOW,
  });
});

test('correction: a row that WAS in the prompt gets relevance 0', () => {
  const labels = correctionLabels(correctionInput(PROMPTED.content));
  assert.equal(labels.length, 1);
  assert.equal(labels[0].target, PROMPTED.id);
  assert.equal(labels[0].relevance, 0);
  assert.equal(labels[0].scope, 'turn');
});

test('correction: a row created after the turn never gets a label (anachronism lock, S4)', () => {
  const written = {
    id: 'mem-written-tonight',
    content: MISSING.content,
    // `#replay` writes memories in the same night it writes corrections.
    createdAt: TURN_STARTED_AT + 1,
  };
  const labels = correctionLabels(
    correctionInput(MISSING.content, { reachable: [written] }),
  );
  assert.deepEqual(labels, []);

  // The same row, created one millisecond earlier, is evidence again - so the
  // empty answer above is the lock and not a broken fixture.
  const before = { ...written, createdAt: TURN_STARTED_AT - 1 };
  assert.equal(correctionLabels(correctionInput(MISSING.content, { reachable: [before] })).length, 1);
});

test('correction: an ambiguous quote lands session-wide and yields no gain (S3)', () => {
  const labels = correctionLabels(correctionInput(MISSING.content, { turn: null }));
  assert.equal(labels.length, 1);
  assert.equal(labels[0].scope, 'session');
  // The session-wide label carries the SESSION id in `turn_id` - the column is
  // NOT NULL and part of the primary key (AP1).
  assert.equal(labels[0].turnId, SESSION);

  const { gain, conflicts } = gainFrom(labels);
  assert.equal(gain(MISSING.id), 0);
  assert.equal(conflicts, 0);
});

test('correction: the session start is the conservative anchor for an ambiguous quote', () => {
  const afterSessionStart = {
    id: 'mem-mid-session',
    content: MISSING.content,
    createdAt: SESSION_STARTED_AT + 1,
  };
  const labels = correctionLabels(
    correctionInput(MISSING.content, { turn: null, reachable: [afterSessionStart] }),
  );
  assert.deepEqual(labels, []);
});

test('correction: a row below the duplicate threshold is not a hit', () => {
  const labels = correctionLabels(
    correctionInput('The user files expenses in a spreadsheet every Friday.'),
  );
  assert.deepEqual(labels, []);
});

/* ---------------------------------------- merge ---------------------------------------- */

test('merge: the worse-placed of two condensed rows gets relevance 0, and nothing else does', () => {
  const labels = mergeLabels({
    owner: OWNER,
    sessionId: SESSION,
    turnId: TURN,
    prompted: ['a', 'b', 'c'],
    targets: [
      { id: 'a', supersededBy: 'x' },
      { id: 'b', supersededBy: 'x' },
      { id: 'c' },
    ],
    now: NOW,
  });
  assert.equal(labels.length, 1);
  assert.deepEqual(labels[0], {
    turnId: TURN,
    target: 'b',
    source: 'merge',
    relevance: 0,
    scope: 'turn',
    owner: OWNER,
    sessionId: SESSION,
    evidence: 'x',
    createdAt: NOW,
  });
});

test('merge: at most one supersedes hop - a chain is not a cluster (S7)', () => {
  const labels = mergeLabels({
    owner: OWNER,
    turnId: TURN,
    prompted: ['a', 'b'],
    // a -> x, b -> y, and y was later condensed into x as well. Following that
    // second hop would carry the label weeks away from the prompt it saw.
    targets: [
      { id: 'a', supersededBy: 'x' },
      { id: 'b', supersededBy: 'y' },
      { id: 'y', supersededBy: 'x' },
    ],
    now: NOW,
  });
  assert.deepEqual(labels, []);
});

test('merge: a single member, and a row that never stood in the prompt, prove nothing', () => {
  const labels = mergeLabels({
    owner: OWNER,
    turnId: TURN,
    prompted: ['a'],
    targets: [
      { id: 'a', supersededBy: 'x' },
      // Same cluster, but it was not in this prompt - so it never cost this
      // block the line behind it.
      { id: 'unprompted', supersededBy: 'x' },
    ],
    now: NOW,
  });
  assert.deepEqual(labels, []);
});

/* --------------------------------------- review --------------------------------------- */

test('review: sentinel target, (overall - 1) / 4, session scope', () => {
  const label = reviewLabel({
    owner: OWNER,
    assignmentId: 'assignment-9',
    sessionId: SESSION,
    overall: 4,
    evidence: 'review-3',
    now: NOW,
  });
  assert.equal(label.target, REVIEW_TARGET);
  assert.equal(label.target, '*');
  assert.equal(label.relevance, 0.75);
  assert.equal(label.scope, 'session');
  assert.equal(label.turnId, 'assignment-9');
  assert.equal(reviewLabel({ owner: OWNER, assignmentId: 'a', overall: 1, now: NOW }).relevance, 0);
  assert.equal(reviewLabel({ owner: OWNER, assignmentId: 'a', overall: 5, now: NOW }).relevance, 1);
});

test('review: gainFrom refuses it into DCG, not its callers (S8)', () => {
  const label = reviewLabel({
    owner: OWNER,
    assignmentId: TURN,
    sessionId: SESSION,
    overall: 5,
    now: NOW,
  });
  assert.equal(gainFrom([label]).gain(REVIEW_TARGET), 0);

  // Forged both ways a caller could get it wrong: turn scope, and a real
  // memory id as the target. Neither reaches the gain.
  const forged = { ...label, scope: 'turn', target: PROMPTED.id };
  const { gain, conflicts } = gainFrom([forged]);
  assert.equal(gain(PROMPTED.id), 0);
  assert.equal(gain(REVIEW_TARGET), 0);
  assert.equal(conflicts, 0);
});

/* ---------------------------------------- user ---------------------------------------- */

test('user: the chat highlight carries a turn, a plain edit does not', () => {
  const clicked = userLabel({
    owner: OWNER,
    target: PROMPTED.id,
    relevance: 1,
    turnId: TURN,
    sessionId: SESSION,
    evidence: 'POST /api/memories/:id/feedback user',
    now: NOW,
  });
  assert.equal(clicked.scope, 'turn');
  assert.equal(clicked.turnId, TURN);
  assert.equal(gainFrom([clicked]).gain(PROMPTED.id), 1);

  const edited = userLabel({
    owner: OWNER,
    target: PROMPTED.id,
    relevance: 0,
    sessionId: SESSION,
    evidence: 'DELETE /api/memories/:id user',
    now: NOW,
  });
  assert.equal(edited.scope, 'session');
  assert.equal(edited.turnId, SESSION);
  assert.equal(gainFrom([edited]).gain(PROMPTED.id), 0);
});

test('user: the attribution window is closed on both sides', () => {
  const sessions = [
    { id: 'old', at: NOW - 8 * 24 * 60 * 60 * 1000 },
    { id: 'inside', at: NOW - 24 * 60 * 60 * 1000 },
    { id: 'now', at: NOW },
    { id: 'future', at: NOW + 1 },
  ];
  assert.deepEqual(sessionsInUserLabelWindow(sessions, NOW, 7 * 24 * 60 * 60 * 1000), [
    'inside',
    'now',
  ]);
});

/* ------------------------------------- the primary source ------------------------------------- */

test('gain: the precedence is user > correction > merge, and contradictions are counted (S2)', () => {
  const base = {
    turnId: TURN,
    target: PROMPTED.id,
    scope: 'turn',
    owner: OWNER,
    sessionId: SESSION,
    createdAt: NOW,
  };
  const merge = { ...base, source: 'merge', relevance: 0 };
  const correction = { ...base, source: 'correction', relevance: 1 };
  const user = { ...base, source: 'user', relevance: 0 };

  const withoutUser = gainFrom([merge, correction]);
  assert.equal(withoutUser.gain(PROMPTED.id), 1);
  assert.equal(withoutUser.conflicts, 1);

  // Order must not decide anything the ranking decides.
  assert.equal(gainFrom([correction, merge]).gain(PROMPTED.id), 1);

  const withUser = gainFrom([merge, correction, user]);
  assert.equal(withUser.gain(PROMPTED.id), 0);
  // Still one contradicting target, not one per label.
  assert.equal(withUser.conflicts, 1);
});

test('gain: on equal rank the first label stands, and the contradiction is still counted', () => {
  const base = {
    turnId: TURN,
    target: MISSING.id,
    source: 'correction',
    scope: 'turn',
    owner: OWNER,
    createdAt: NOW,
  };
  const { gain, conflicts } = gainFrom([
    { ...base, relevance: 1 },
    { ...base, relevance: 0 },
  ]);
  assert.equal(gain(MISSING.id), 1);
  assert.equal(conflicts, 1);
});

test('gain: an unlabelled memory is 0, never undefined', () => {
  const { gain } = gainFrom([]);
  assert.equal(gain('anything'), 0);
});

/* ---------------------------------- the reporting arithmetic ---------------------------------- */

test('labelCoverage: share of compared positions a label could exist for', () => {
  const universe = new Set([PROMPTED.id, MISSING.id]);
  assert.equal(labelCoverage([PROMPTED.id, 'x', MISSING.id, 'y'], universe), 0.5);
  assert.equal(labelCoverage([PROMPTED.id], universe), 1);
  // A rate over no positions is not a rate, and must not clear the floor.
  assert.equal(labelCoverage([], universe), 0);
});

test('costOnlyShare: a trace on which no labelled position moved is cost-only', () => {
  assert.equal(
    costOnlyShare([
      [{ id: 'a', labelPossible: false }],
      [],
      [{ id: 'b', labelPossible: true }],
    ]),
    2 / 3,
  );
  assert.equal(costOnlyShare([]), 0);
});

test('agreement: kappa corrects for chance, and says null where it is undefined', () => {
  const label = (target, source, relevance) => ({
    turnId: TURN,
    target,
    source,
    relevance,
    scope: 'turn',
    owner: OWNER,
    createdAt: NOW,
  });
  const a = [
    label('m1', 'correction', 1),
    label('m2', 'correction', 1),
    label('m3', 'correction', 0),
    label('m4', 'correction', 0),
  ];
  const b = [
    label('m1', 'user', 1),
    label('m2', 'user', 0),
    label('m3', 'user', 1),
    label('m4', 'user', 0),
  ];
  assert.equal(pairedRatings(a, b).length, 4);
  assert.equal(pairwiseAgreement(a, b), 0.5);
  // Both marginals are 2:2, so chance agreement is 0.5 and kappa is exactly 0.
  assert.equal(cohensKappa(a, b), 0);

  // `merge` writes nothing but zeroes: perfect observed agreement, chance
  // agreement 1, kappa undefined - the caller falls back to the plain rate.
  const zerosA = [label('m1', 'merge', 0), label('m2', 'merge', 0)];
  const zerosB = [label('m1', 'correction', 0), label('m2', 'correction', 0)];
  assert.equal(pairwiseAgreement(zerosA, zerosB), 1);
  assert.equal(cohensKappa(zerosA, zerosB), null);

  // Thin `user` labels are a finding, not a zero (concept 5.5b).
  assert.equal(pairwiseAgreement(a, []), null);
  assert.equal(cohensKappa(a, []), null);
});

test('agreement: a session-wide label pairs with a session-wide label, never with a turn', () => {
  const sessionLabel = (source, relevance) => ({
    turnId: SESSION,
    target: MISSING.id,
    source,
    relevance,
    scope: 'session',
    owner: OWNER,
    createdAt: NOW,
  });
  const turnLabel = {
    turnId: TURN,
    target: MISSING.id,
    source: 'user',
    relevance: 1,
    scope: 'turn',
    owner: OWNER,
    createdAt: NOW,
  };
  assert.equal(pairedRatings([sessionLabel('correction', 1)], [turnLabel]).length, 0);
  assert.equal(pairedRatings([sessionLabel('correction', 1)], [sessionLabel('user', 1)]).length, 1);
});
