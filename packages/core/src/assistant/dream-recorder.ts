import type { Logger } from '../logger.js';
import { byScoreThenId, coreProfile, dropContradicted, recall } from '../memory/recall.js';
import { fetchFrame } from '../memory/dream/frame.js';
import { DEFAULT_SPLIT_RATES, splitOf } from '../memory/dream/evaluate.js';
import { episodeFromEvents } from '../memory/dream/trajectory.js';
import type { Store } from '../memory/store.js';
import type { RecallBox, RecallPolicy, RookeryConfig, ScoredMemory, Session } from '../types.js';
import { ASSISTANT_MEMORY_OWNER } from '../types.js';

/**
 * Salt for the dream's session-level sample draw. A fixed literal, not a
 * per-process random: the sample must survive a restart, because it is drawn
 * per session - consecutive turns of one session share topic, bank cutout and
 * entity neighbourhood, and a restart must not split them across the sample.
 */
const DREAM_SAMPLE_SALT = 'rookery.dream.sample.v1';

/** FNV-1a 32-bit offset basis and prime. */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const UINT32_RANGE = 0x1_0000_0000;

/** The recorder may widen the recall limit to this window and never past it (E21). */
const LIMIT_MAX_FLOOR = 4;
const LIMIT_MAX_CEILING = 16;

/** The stored-size cap of one frame, as a range the config key is clamped to (E21). */
const MIN_FRAME_BYTES = 1000;
const MAX_FRAME_BYTES = 2_000_000;

/** `dream.trialEpisodes` is a quota, and a bounded one. */
const MAX_TRIAL_EPISODES = 1000;

/** The part of the context budget the recall block may use, in the prompt and in its frame alike. */
export const MEMORY_BLOCK_BUDGET_SHARE = 0.4;

/** The profile slice a prompt gets is half the recall limit, never fewer than this. */
const MIN_PROFILE_LIMIT = 3;

/**
 * The sample draw of one session as a number in [0, 1): FNV-1a over the
 * session id and the salt. Cheap, stable and portable - it only has to be
 * deterministic, never cryptographic.
 */
function dreamSampleDraw(sessionId: string): number {
  let hash = FNV_OFFSET_BASIS;
  const input = sessionId + DREAM_SAMPLE_SALT;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) / UINT32_RANGE;
}

/** Clamp to a range, for dream keys read outside the patch schema (E21). */
function clampNumber(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The declared box around one turn's realised recall policy: the parameter
 * space a replay of this turn's frame may move in. The interval widths are
 * the house widths the night's grid places its candidates at - weights
 * +/-0.1, threshold [0.05, 0.3], hop weights +/-0.15 and +/-0.2 - always
 * stretched to contain the realised point and never past the valid range,
 * so a knob the user turned cannot sit outside the box that is supposed to
 * close over it. `limitMax` arrives already containing the realised limit.
 */
function declaredDreamBox(policy: RecallPolicy, limitMax: number): RecallBox {
  const weight = (value: number): [number, number] => [Math.max(0, value - 0.1), Math.min(1, value + 0.1)];
  return {
    limitMax,
    w: {
      relevance: weight(policy.w.relevance),
      importance: weight(policy.w.importance),
      recency: weight(policy.w.recency),
      usage: weight(policy.w.usage),
    },
    threshold: [Math.min(0.05, policy.threshold), Math.max(0.3, policy.threshold)],
    hopEntity: [Math.max(0, policy.hopEntity - 0.15), Math.min(1, policy.hopEntity + 0.15)],
    hopEdge: [Math.max(0, policy.hopEdge - 0.2), Math.min(1, policy.hopEdge + 0.2)],
    kinds: policy.kinds,
    minImportance: policy.minImportance,
  };
}

/** How many profile rows a prompt carries for a recall limit. */
function promptProfileLimit(limit: number): number {
  return Math.max(MIN_PROFILE_LIMIT, Math.floor(limit / 2));
}

/** The ranking parameters of one turn: what `recall` runs with and what the frame freezes. */
interface RecallOptions {
  text: string;
  owner: string;
  limit: number;
  threshold: number;
  hopEntity: number;
  hopEdge: number;
}

/** One turn as the recorder sees it. */
interface RecordedTurn {
  session: Session;
  owner: string;
  policy: RecallPolicy;
  /** The JOURNAL's id, handed down from `chat()`; see `turnMemories`. */
  turnId: string;
  options: RecallOptions;
}

/**
 * The dream recorder (concept 7.2): decides which turns are framed for the
 * night and records what the night needs to replay them. It sits at the
 * conversational call site, never inside `recall` (R19).
 */
export class DreamRecorder {
  readonly #store: Store;
  readonly #config: RookeryConfig;
  readonly #log: Logger;

  constructor(context: { store: Store; config: RookeryConfig; log: Logger }) {
    this.#store = context.store;
    this.#config = context.config;
    this.#log = context.log;
  }

  /**
   * Whether this turn is framed for the dream. All conditions must hold
   * (R18): the dream and the recorder are switched on, the owner is the
   * assistant - stage 1 records nothing but the assistant's own bank, an
   * agent frame would be cost without a night that ever scores it - and the
   * session is a real conversation. A `schedule` run walks this same code
   * but can never earn a correction label, because `sessionsActiveSince`
   * filters its kind out; framing it would be pure cost. The sample itself
   * is drawn per session, never per trace, and `frameRate` is clamped here
   * because `rookery config set` bypasses the patch schema (E21).
   */
  recordsTurn(session: Session, owner: string): boolean {
    const dream = this.#config.memory.dream;
    if (!dream.enabled || !dream.record) return false;
    if (owner !== ASSISTANT_MEMORY_OWNER) return false;
    if (session.kind !== 'chat' && session.kind !== 'voice' && session.kind !== 'mail') return false;
    return dreamSampleDraw(session.id) < clampNumber(dream.frameRate, 0, 1);
  }

  /**
   * The turn's merged memory list: the ranking plus the profile, pairs that
   * cannot both be true reduced to the newer sentence, and the whole merge
   * totally ordered - score descending, id ascending (R11), so a tie can no
   * longer pick whichever row the Map happened to insert first. That order
   * is what the rendered block reads, and what the recorder freezes.
   *
   * A framed turn additionally records everything the night needs to replay
   * this decision: the trace, the touches the ranking causes, and the frame
   * at the permissive corner of the declared box. The live ranking inside
   * the bracket is byte for byte the ranking of an unframed turn - the
   * recorder may not change the turn it records - and everything it writes
   * sits in the store's SAVEPOINT bracket (R9), so a framed turn is one
   * transaction or nothing.
   *
   * `turnId` is the JOURNAL's id, handed down from `chat()` - not one minted
   * here. That is the whole of concept 9.4's "one turn id instead of three":
   * the trace, the message and the journal now say the same word, so a
   * correction quote found in `messages.turn_id` lands on exactly the trace
   * that produced the prompt it corrects. Minted separately, `locateTurn`
   * could never match one and every correction label fell back to session
   * scope - where, by S3, it can never contribute a gain.
   */
  turnMemories(
    session: Session,
    owner: string,
    prompt: string,
    policy: RecallPolicy,
    turnId: string,
  ): ScoredMemory[] {
    const options: RecallOptions = {
      text: prompt,
      owner,
      limit: policy.limit,
      threshold: policy.threshold,
      hopEntity: policy.hopEntity,
      hopEdge: policy.hopEdge,
    };
    if (!this.recordsTurn(session, owner)) {
      const profile = coreProfile(this.#store, { owner, limit: promptProfileLimit(policy.limit) });
      return this.#merged(recall(this.#store, options), profile);
    }
    return this.#recordedTurnMemories({ session, owner, policy, turnId, options });
  }

  /**
   * Index a finished turn as a trial episode (concept 7.2, Phase 6).
   *
   * `dream.trialEpisodes` gets its reader here rather than in the night,
   * for the plain reason that the night cannot reach the turn journal: the
   * episode is an INDEX over `turn_events`, and only the process that just
   * wrote those rows knows the turn is over. Zero by default, so this is a
   * single config read and a return on every turn Rookery has ever run.
   *
   * The key is a quota, not a switch: `trialEpisodes` many episodes per
   * bank, then nothing. Phase 6 is a sample to validate a mechanism on, not
   * a recorder to leave running - and a trial that never stops would keep
   * pointing at verbatim journal rows long after anybody looked at it.
   *
   * Nothing in here may cost the turn. The turn is finished and answered by
   * the time this runs; a store that refuses the write costs the episode
   * and a debug line (10.5).
   */
  recordTrialEpisode(turnId: string, sessionId: string | undefined, startedAt: number): void {
    const trial = Math.round(clampNumber(this.#config.memory.dream.trialEpisodes, 0, MAX_TRIAL_EPISODES));
    if (trial <= 0) return;
    const owner = ASSISTANT_MEMORY_OWNER;
    try {
      // Read with the quota as the limit: the question is "are there already
      // enough", never "how many are there".
      if (this.#store.dreamEpisodes(owner, { limit: trial }).length >= trial) return;
      // The same session-wise split the recorder stamps on a trace (E3): a
      // turn outside any conversation is its own cluster.
      const split = splitOf(sessionId ?? turnId, DEFAULT_SPLIT_RATES);
      const { episode } = episodeFromEvents(turnId, this.#store.turns.events(turnId), {
        owner,
        kind: 'turn',
        slot: 'recall',
        ...(sessionId ? { sessionId } : {}),
        startedAt,
        finishedAt: Date.now(),
        holdout: split === 'holdout',
        audit: split === 'audit',
      });
      this.#store.recordDreamEpisode(episode);
    } catch (error) {
      this.#log.debug('Trial episode not recorded', { turnId, error: (error as Error).message });
    }
  }

  /**
   * Profile and ranking as one list. Of a contradicting pair only the newer
   * sentence goes into the prompt; the older one stays in the bank and stays
   * visible in the inspector.
   */
  #merged(matched: ScoredMemory[], profile: ScoredMemory[]): ScoredMemory[] {
    const byId = new Map<string, ScoredMemory>();
    for (const memory of profile) byId.set(memory.id, memory);
    for (const memory of matched) byId.set(memory.id, memory);
    return dropContradicted(this.#store, [...byId.values()]).sort(byScoreThenId);
  }

  /** A framed turn: the live ranking, plus its trace, touches and frame - one transaction or nothing. */
  #recordedTurnMemories(turn: RecordedTurn): ScoredMemory[] {
    const { session, owner, policy, turnId, options } = turn;
    const dream = this.#config.memory.dream;
    const limitMax = Math.max(
      Math.round(clampNumber(dream.limitMax, LIMIT_MAX_FLOOR, LIMIT_MAX_CEILING)),
      policy.limit,
    );
    const maxFrameBytes = Math.round(clampNumber(dream.maxFrameBytes, MIN_FRAME_BYTES, MAX_FRAME_BYTES));
    const profileLimit = promptProfileLimit(policy.limit);
    // Which half of the evidence this turn belongs to, stamped at record
    // time (E3). The unit is the SESSION, never the trace: two traces of one
    // session can never disagree, and the rates come from the one exported
    // constant the night reads back months later - if the recorder and the
    // evaluation ever picked their rates separately, a session would change
    // sides between the stamp and the measurement and the holdout would
    // quietly stop being one.
    const split = splitOf(session.id, DEFAULT_SPLIT_RATES);
    let memories: ScoredMemory[] = [];
    this.#store.recordDreamTurn(() => {
      const trace = this.#store.beginTrace({
        // One id per turn: every traced call of this turn carries it, and
        // labels attach to it rather than to any single call (R19).
        turnId,
        owner,
        kind: 'turn',
        site: 'turn',
        pipeline: 'assistant',
        sessionId: session.id,
        sessionKind: session.kind,
        // The position of this turn in its session: the messages stored
        // before it, which is the count the session carries at recall time.
        turnIndex: session.messageCount,
        policySet: { recall: policy },
        framed: true,
        holdout: split === 'holdout',
        audit: split === 'audit',
      });
      // The record, fetched before the ranking: the frame freezes
      // `access_count`, and the values worth freezing are the ones the live
      // scores are about to read - not the ones this turn's own touch will
      // write a moment later.
      const frame = fetchFrame(this.#store, {
        ...options,
        box: declaredDreamBox(policy, limitMax),
        site: 'turn',
        pipeline: 'assistant',
        budgetChars: Math.floor(this.#config.memory.contextBudget * MEMORY_BLOCK_BUDGET_SHARE),
        subject: 'this user',
        // A meta read and nothing more; empty until the first night has
        // stamped a fingerprint, which certifies nothing yet (R10).
        corpusStampId: this.#store.currentCorpusStamp(owner)?.id ?? '',
      });
      const matched = recall(this.#store, { ...options, touchContext: { traceId: trace.id, owner } });
      // One profile read at the permissive corner of the box, sliced down
      // for the prompt: the SQL behind `coreProfile` is prefix-invariant
      // now that it tie-breaks on id, so the wider read costs one query and
      // changes no row the prompt sees (R12).
      const profile = coreProfile(this.#store, {
        owner,
        limit: Math.max(profileLimit, promptProfileLimit(limitMax)),
      }).slice(0, profileLimit);
      memories = this.#merged(matched, profile);
      // A frame over the stored-size cap is refused rather than thrown at:
      // the trace still closes, without a frame, and the night simply never
      // scores this turn. Loud on purpose - every refusal is evidence the
      // night will never see, and a quiet one left the dream empty for weeks.
      if (!this.#store.saveFrame(trace.id, 'recall', frame, { maxFrameBytes })) {
        this.#log.warn('Dream frame refused: over dream.maxFrameBytes', { sessionId: session.id, turnId, maxFrameBytes });
      }
      this.#store.finishTrace(trace.id, { degraded: frame.degraded });
    });
    return memories;
  }
}
