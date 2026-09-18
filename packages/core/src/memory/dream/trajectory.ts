import { createHash } from 'node:crypto';
import type { AgentEvent, DreamEpisode, DreamEpisodeStep, DreamVerdict } from '../../types.js';

/**
 * First-divergence judging (dream stage 2, AP7; concept 7.2 and 11, Phase 6).
 *
 * A recorded trajectory is a prefix-closed simulator. At step k the candidate
 * policy sees the recorded prefix and names step k, and nothing else: it is
 * never told how long the episode was, so it cannot learn where to stop.
 * Matches `(name, argsHash)` and the recorded observation is served; misses,
 * and the decision at k is still exactly judgeable - the simulated bank is
 * identical up to there - while everything after k is undefined, and nothing
 * about it is claimed.
 *
 * Observations are keyed on `(step, argsHash)` (S29). That keying is the
 * whole safety argument: a diverging action can structurally not look one up,
 * which is what makes classical off-policy invention impossible. It is not a
 * check that could be forgotten - there is no other way in.
 *
 * Three contracts hold in this module:
 *
 * - It owns no storage. `episodeFromEvents` reads the existing `turn_events`
 *   journal (`turns/journal.ts`); `dream_episodes` is an index over that
 *   journal, never a second store of verbatim text (concept, AP1). Nothing
 *   here writes.
 * - It never throws. A decider that throws is a divergence, not an exception,
 *   the same way `dream/probe.ts` reports into its result instead of
 *   unwinding the night.
 * - The hash is defined once. `canonicalJson`/`hashCanonicalJson` are what the
 *   recorder in `providers/claude-code.ts` uses to stamp `argsHash` onto the
 *   start event. If judge and recorder ever computed it differently, every
 *   episode would read as diverging at step 0 and the failure would look like
 *   a finding - which is why the provider imports them from here instead of
 *   keeping a second copy.
 *
 * Everything here is off by default: `memory.dream.trialEpisodes` is 0.
 */

/**
 * How much canonical argument JSON the recorder carries on a start event:
 * the same 4000 characters `summariseInput`'s fallback already used, so the
 * per-event cost of S28 stays inside what the journal already tolerated. The
 * hash is taken over the WHOLE canonical JSON, never over the truncation -
 * `input` is for a human reading a diff, `argsHash` is the key.
 */
export const TOOL_INPUT_LIMIT = 4000;

/**
 * Deepest structure `canonicalJson` descends into before writing `null`.
 * Tool arguments come out of `JSON.parse` and are acyclic, so this exists
 * only so that a pathological input can never make the recorder throw or
 * recurse without end. No real tool schema comes close.
 */
const MAX_DEPTH = 32;

/**
 * JSON with a stable key order, so the same arguments always hash the same.
 *
 * Keys are sorted by UTF-16 code unit (`Array.sort`'s default), `undefined`
 * members are dropped from objects and written as `null` inside arrays, and a
 * non-finite number becomes `null` - exactly what `JSON.stringify` does, minus
 * its dependence on insertion order. Anything it cannot represent (a function,
 * a symbol) becomes `null` rather than an exception.
 */
export function canonicalJson(value: unknown): string {
  return write(value, 0);
}

function write(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) return 'null';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return '[' + value.map((entry) => write(entry, depth + 1)).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return (
      '{' +
      keys.map((key) => JSON.stringify(key) + ':' + write(record[key], depth + 1)).join(',') +
      '}'
    );
  }
  return 'null';
}

/** The argument hash of an already canonicalised string. */
export function hashCanonicalJson(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex');
}

/** `sha256(canonicalJson(input))` - the key every observation is stored under. */
export function argsHashOf(input: unknown): string {
  return hashCanonicalJson(canonicalJson(input));
}

/**
 * What the journal does not know about an episode: who it belongs to, which
 * slot's policy it is relevant to, and which side of the frozen split its
 * session fell on (AP8's `splitOf`). Everything else - the steps, their
 * arguments, their observations - is read back out of `turn_events`.
 */
export interface EpisodeSource {
  owner: string;
  kind: DreamEpisode['kind'];
  /** Which slot's policy this episode is relevant to. */
  slot: string;
  sessionId?: string;
  startedAt: number;
  finishedAt?: number;
  holdout?: boolean;
  audit?: boolean;
  /**
   * Override what the events imply. An assignment knows its own result better
   * than its stream does; a chat turn does not, and leaves this unset.
   */
  outcome?: DreamEpisode['outcome'];
}

/**
 * One journal row as `TurnJournal.events` hands it back, or a bare event. The
 * journal wraps each event in its sequence number; a caller that already
 * unwrapped them passes the events themselves. Both are accepted so that
 * neither side has to map a list just to call this.
 */
export type JournalledEvent = AgentEvent | { seq: number; event: Record<string, unknown> };

/**
 * Index one turn's or one assignment's journal as an episode.
 *
 * The steps are the provider's own tool calls, in the order they were
 * yielded: a `start` opens a step, and the `end` carrying the same `id`
 * closes it with its observation. Since S28 the `end` carries the real tool
 * name too, but the correlation stays on `id` - an end without one attaches
 * to the newest step still waiting for a result, which is what the stream
 * order means anyway.
 *
 * `at` is the episode's start on every step, not the step's own wall clock:
 * `turn_events` has no timestamp column (`db.ts`, schema 19), so there is no
 * per-step time to read. It is repeated rather than interpolated - the judge
 * orders on `step`, and nothing here may be read as a duration.
 */
export function episodeFromEvents(
  id: string,
  events: readonly JournalledEvent[],
  source: EpisodeSource,
): { episode: DreamEpisode; steps: DreamEpisodeStep[] } {
  const steps: DreamEpisodeStep[] = [];
  /** Open steps by tool-use id, so an `end` finds the `start` it belongs to. */
  const open = new Map<string, number>();
  let outcome: DreamEpisode['outcome'] = 'unknown';

  for (const entry of events) {
    const event = unwrap(entry);
    if (!event) continue;

    if (event.type === 'error') {
      outcome = 'failure';
      continue;
    }
    if (event.type === 'done') {
      // An errored result ends the turn without a `done`, so a failure seen
      // earlier stands: the last word is the error, not the absence of one.
      if (outcome === 'unknown') outcome = 'success';
      continue;
    }
    if (event.type !== 'tool') continue;

    if (event.status === 'start') {
      const index = steps.length;
      steps.push({
        step: index,
        name: event.name,
        ...(event.argsHash !== undefined ? { argsHash: event.argsHash } : {}),
        ...(event.input !== undefined ? { input: event.input } : {}),
        at: source.startedAt,
      });
      if (event.id) open.set(event.id, index);
      continue;
    }

    const index = event.id !== undefined ? open.get(event.id) : lastOpen(steps);
    if (index === undefined) continue;
    if (event.id !== undefined) open.delete(event.id);
    const step = steps[index] as DreamEpisodeStep;
    if (event.result !== undefined) step.result = event.result;
    if (event.isError !== undefined) step.isError = event.isError;
  }

  const episode: DreamEpisode = {
    id,
    owner: source.owner,
    kind: source.kind,
    ...(source.sessionId !== undefined ? { sessionId: source.sessionId } : {}),
    slot: source.slot,
    steps: steps.length,
    outcome: source.outcome ?? outcome,
    holdout: source.holdout === true,
    audit: source.audit === true,
    startedAt: source.startedAt,
    ...(source.finishedAt !== undefined ? { finishedAt: source.finishedAt } : {}),
    createdAt: Date.now(),
  };
  return { episode, steps };
}

function unwrap(entry: JournalledEvent): AgentEvent | undefined {
  const record = entry as unknown as Record<string, unknown>;
  if (typeof record.type === 'string') return entry as AgentEvent;
  const inner = record.event;
  if (inner && typeof inner === 'object' && typeof (inner as Record<string, unknown>).type === 'string') {
    return inner as unknown as AgentEvent;
  }
  return undefined;
}

/** The newest step nothing has closed yet, for an `end` that carries no id. */
function lastOpen(steps: DreamEpisodeStep[]): number | undefined {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index] as DreamEpisodeStep;
    if (step.result === undefined && step.isError === undefined) return index;
  }
  return undefined;
}

/** One recorded observation, served only to an action that matches its key. */
export interface StepObservation {
  result?: string;
  isError?: boolean;
}

/**
 * What the candidate policy names for one step. `argsHash` wins when both are
 * given; otherwise the arguments are hashed with the same `canonicalJson` the
 * recorder used, which is the only way the two can ever agree.
 */
export interface ProposedAction {
  name: string;
  input?: unknown;
  argsHash?: string;
}

/**
 * What the simulator puts in front of the candidate at step k.
 *
 * `prefix` is the recorded episode up to but not including `step`, verbatim,
 * with the observation each of those steps produced. There is deliberately no
 * step count in here: a policy that knew `n` could manufacture `no-change` by
 * naming exactly as many steps as were recorded, and `no-change` is the
 * verdict this mechanism most needs to be able to trust.
 */
export interface DecisionContext {
  /** Zero-based index of the step to name. */
  step: number;
  /** Steps 0..step-1 as they were recorded, each with its observation. */
  prefix: readonly DreamEpisodeStep[];
  /**
   * The recorded observation for `(step, argsHash)`, or `undefined`. A
   * diverging action has a different hash and therefore no entry - this is
   * the keying from S29, not a check somebody could skip.
   */
  observe(step: number, argsHash: string): StepObservation | undefined;
}

/** Names step `step` of the episode, or `null` for "I would stop here". */
export type StepDecider = (context: DecisionContext) => ProposedAction | null;

/** Why the replay stopped where it did. */
export type JudgementStop =
  /** Every recorded step was reproduced: k = n. */
  | 'reproduced'
  /** The candidate named a different `(name, argsHash)` at k. */
  | 'action-mismatch'
  /** The candidate named nothing at k while the episode had a step there. */
  | 'no-action'
  /** The recorded step at k predates S28 and carries no `argsHash`. */
  | 'unrecorded-args'
  /** The decider threw. The dream reports; it does not unwind the night. */
  | 'decider-error';

/**
 * The first-divergence judgement of one episode.
 *
 * Read `counts` before `verdict`. Only `no-change` and a `regression-risk`
 * found on a fully recorded episode may enter an aggregate: a
 * `may-avoid-failure` counts for nothing by decision (S29), and a replay that
 * stopped on `unrecorded-args` is missing evidence rather than evidence, so it
 * counts for nothing either.
 */
export interface EpisodeJudgement {
  verdict: DreamVerdict;
  /** k - the first diverging step. Unset when the candidate reproduced all n. */
  divergedAt?: number;
  /** How many steps the candidate reproduced exactly. Equals k. */
  agreed: number;
  /** n - the recorded length. */
  steps: number;
  counts: boolean;
  reason: JudgementStop;
}

/**
 * Replay a recorded trajectory against a candidate decider, step by step, and
 * stop at the first divergence.
 *
 * Four admissible verdicts and no fifth (S29): `k = n` is `no-change`, the
 * cheapest and most valuable case; `k < n` on an episode that failed is
 * `may-avoid-failure` and counts for nothing, because the other branch was
 * never run and nothing verified it; `k < n` on an episode that succeeded is
 * `regression-risk` at k; and after k nothing is claimed at all - not the
 * outcome, not the remaining steps, not the cost.
 *
 * `outcome` is the episode's, from `episodeFromEvents`. It defaults to
 * `'unknown'`, and an unknown outcome falls into the bucket that counts for
 * nothing: an episode that neither succeeded nor failed cannot carry a
 * regression claim, and calling it failed would be a claim of its own.
 */
export function judgeEpisode(
  steps: readonly DreamEpisodeStep[],
  decide: StepDecider,
  outcome: DreamEpisode['outcome'] = 'unknown',
): EpisodeJudgement {
  const observations = observationIndex(steps);
  const observe = (step: number, argsHash: string): StepObservation | undefined =>
    observations.get(observationKey(step, argsHash));

  for (let index = 0; index < steps.length; index += 1) {
    const recorded = steps[index] as DreamEpisodeStep;
    if (recorded.argsHash === undefined) {
      return stopped(index, steps.length, outcome, 'unrecorded-args');
    }

    let proposed: ProposedAction | null;
    try {
      proposed = decide({ step: index, prefix: steps.slice(0, index), observe });
    } catch {
      return stopped(index, steps.length, outcome, 'decider-error');
    }
    if (!proposed) return stopped(index, steps.length, outcome, 'no-action');

    const argsHash = proposed.argsHash ?? argsHashOf(proposed.input);
    if (proposed.name !== recorded.name || argsHash !== recorded.argsHash) {
      return stopped(index, steps.length, outcome, 'action-mismatch');
    }
  }

  return {
    verdict: 'no-change',
    agreed: steps.length,
    steps: steps.length,
    counts: true,
    reason: 'reproduced',
  };
}

function stopped(
  at: number,
  steps: number,
  outcome: DreamEpisode['outcome'],
  reason: JudgementStop,
): EpisodeJudgement {
  // A stop on unrecorded arguments says nothing about the candidate: the
  // recorder, not the policy, is what ran out.
  const regression = outcome === 'success' && reason !== 'unrecorded-args';
  return {
    verdict: regression ? 'regression-risk' : 'may-avoid-failure',
    divergedAt: at,
    agreed: at,
    steps,
    counts: regression,
    reason,
  };
}

function observationIndex(steps: readonly DreamEpisodeStep[]): Map<string, StepObservation> {
  const index = new Map<string, StepObservation>();
  for (const step of steps) {
    if (step.argsHash === undefined) continue;
    index.set(observationKey(step.step, step.argsHash), {
      ...(step.result !== undefined ? { result: step.result } : {}),
      ...(step.isError !== undefined ? { isError: step.isError } : {}),
    });
  }
  return index;
}

/** A space cannot occur in a hex digest, so the two halves never blur. */
function observationKey(step: number, argsHash: string): string {
  return String(step) + ' ' + argsHash;
}

/**
 * One episode judged twice: by the simulator, and by letting an agent run
 * freely over the same task and watching where it actually first departed
 * from the record.
 */
export interface DivergenceSample {
  /** The episode id, so a disagreement can be looked at rather than argued about. */
  id: string;
  /** k from `judgeEpisode`. Unset means it found no divergence at all. */
  judgedAt?: number;
  /** Where the free run first departed. Unset means it reproduced the episode. */
  observedAt?: number;
  steps: number;
}

/**
 * The agreement the proxy has to reach before Phase 6 may be believed.
 * Guessed: the concept names the gate but not its threshold, and four in five
 * is the lowest number at which "the proxy finds the same step" is still a
 * statement about divergence rather than about chance.
 */
export const PROXY_AGREEMENT_FLOOR = 0.8;

/**
 * Below this many samples the gate means nothing, and therefore does not pass.
 * Guessed, and deliberately on the strict side: a gate that can be cleared
 * with three free runs is a formality, not a validation.
 */
export const PROXY_MIN_SAMPLES = 20;

/** The validation gate's finding. `note` is one line, fit for the report. */
export interface DivergenceProxyReport {
  samples: number;
  agreed: number;
  /** `agreed / samples`, 0 with no samples. */
  agreement: number;
  /** Proxy and free run both saw no divergence - the strongest agreement there is. */
  bothReproduced: number;
  /** The proxy called a divergence earlier than the free run had one. */
  early: number;
  /** Later than the free run, or missed it entirely. */
  late: number;
  /** Every disagreement, listed. Never summarised away. */
  disagreements: DivergenceSample[];
  agreementFloor: number;
  minSamples: number;
  passed: boolean;
  note: string;
}

/**
 * The validation gate of Phase 6 (concept 11, Phase 6).
 *
 * The step-k question is a different prompt shape from a real turn, so a
 * detected divergence is a proxy FOR divergence, not divergence. The
 * validation is this: let a sample run freely, and check whether the first
 * step it really departs on is the k the simulator named. This function
 * reports the disagreement. It does not route around it, does not reweight it
 * and does not offer a lower threshold.
 *
 * If it fails, Phase 6 is dead. Not "needs tuning" - dead: first-divergence
 * judging would then be measuring the prompt shape rather than divergence,
 * and every number built on it would be a number about the prompt shape. The
 * only honest way back is the full double run of the concept's first version,
 * section 9.
 */
export function divergenceProxyReport(
  samples: readonly DivergenceSample[],
  options: { agreementFloor?: number; minSamples?: number } = {},
): DivergenceProxyReport {
  const agreementFloor = options.agreementFloor ?? PROXY_AGREEMENT_FLOOR;
  const minSamples = options.minSamples ?? PROXY_MIN_SAMPLES;

  const disagreements: DivergenceSample[] = [];
  let agreed = 0;
  let bothReproduced = 0;
  let early = 0;
  let late = 0;

  for (const sample of samples) {
    if (sample.judgedAt === sample.observedAt) {
      agreed += 1;
      if (sample.judgedAt === undefined) bothReproduced += 1;
      continue;
    }
    disagreements.push(sample);
    // An unset k is "no divergence found at all", which is as late as it gets.
    const judged = sample.judgedAt ?? sample.steps;
    const observed = sample.observedAt ?? sample.steps;
    if (judged < observed) early += 1;
    else late += 1;
  }

  const agreement = samples.length ? agreed / samples.length : 0;
  const thin = samples.length < minSamples;
  const passed = !thin && agreement >= agreementFloor;
  const percent = (value: number): string => String(Math.round(value * 100)) + '%';

  const note = thin
    ? 'Only ' +
      samples.length +
      ' sample(s); the gate needs ' +
      minSamples +
      ' before it says anything. Not passed.'
    : passed
      ? 'The proxy found the same first diverging step as the free run in ' +
        agreed +
        ' of ' +
        samples.length +
        ' samples (' +
        percent(agreement) +
        ', floor ' +
        percent(agreementFloor) +
        ').'
      : 'The proxy disagreed with the free run in ' +
        disagreements.length +
        ' of ' +
        samples.length +
        ' samples (' +
        percent(agreement) +
        ' agreement, floor ' +
        percent(agreementFloor) +
        '). Phase 6 is dead as designed: first-divergence judging is then ' +
        'measuring the prompt shape, not divergence, and the only honest way ' +
        'back is the full double run (concept version 1, section 9).';

  return {
    samples: samples.length,
    agreed,
    agreement,
    bothReproduced,
    early,
    late,
    disagreements,
    agreementFloor,
    minSamples,
    passed,
    note,
  };
}
