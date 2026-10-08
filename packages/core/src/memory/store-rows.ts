import { gunzipSync } from 'node:zlib';
import {
  ASSISTANT_MEMORY_OWNER,
  type AbstainReason,
  type CronTrigger,
  type DreamDegraded,
  type DreamEpisode,
  type DreamEval,
  type DreamFrame,
  type DreamLabel,
  type DreamLabelSource,
  type DreamPipeline,
  type DreamSite,
  type DreamSlot,
  type DreamSlotFreezeReason,
  type DreamSlotState,
  type DreamTrace,
  type DreamTraceKind,
  type EntityKind,
  type MemoryEdge,
  type MemoryEntity,
  type MemoryKind,
  type MemoryOrigin,
  type MemoryRecord,
  type MemoryRelation,
  type Message,
  type PolicyOrigin,
  type PolicyVersion,
  type ProviderId,
  type RecallBox,
  type RecallFrame,
  type RecallPolicy,
  type Role,
  type Session,
  type SessionKind,
  type SleepRun,
  type SleepStatus,
  type TurnUsage,
} from '../types.js';

/**
 * Row mappers: one SQLite row in, one domain record out. Kept apart from the
 * `Store` so the SQL and the shape of what it returns can change separately.
 */

export type Row = Record<string, unknown>;

/** Session kinds a stray column value may keep; everything else degrades to a chat. */
const SESSION_KINDS_BESIDE_CHAT: readonly string[] = ['voice', 'mail', 'schedule'];

/** A nullable column read as an optional field: NULL becomes absent. */
function optional<T>(value: unknown): T | undefined {
  return (value as T | null | undefined) ?? undefined;
}

/** A counter column: NULL (a row from before the column existed) reads as 0. */
function counter(value: unknown): number {
  return Number(value ?? 0);
}

/** A 0/1 column. NULL reads as unset. */
function isFlagSet(value: unknown): boolean {
  return counter(value) === 1;
}

/** A number that is absent for NULL and for 0 - timestamps and durations, where 0 is "never". */
function nonZeroNumber(value: unknown): number | undefined {
  return value ? Number(value) : undefined;
}

/** A number that is absent only for NULL: 0 is a real measurement here. */
function nullableNumber(value: unknown): number | undefined {
  return value === null ? undefined : Number(value);
}

/**
 * A JSON column an older build may have written differently, or not at all.
 * One malformed row must never cost the whole transcript: the field simply
 * reads as absent, the way `parseTags` already degrades.
 */
export function parseJsonColumn<T>(value: unknown): T | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function parseTags(value: unknown): string[] {
  const parsed = parseJsonColumn<unknown>(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export function mapSession(row: Row): Session {
  return {
    id: row.id as string,
    title: row.title as string,
    // Anything the column does not know is a chat - that is what the default
    // was before `kind` existed, and what a stray value should degrade to.
    kind: (SESSION_KINDS_BESIDE_CHAT.includes(row.kind as string) ? row.kind : 'chat') as SessionKind,
    provider: row.provider as ProviderId,
    model: optional<string>(row.model),
    cwd: row.cwd as string,
    projectId: optional<string>(row.project_id),
    agentId: optional<string>(row.agent_id),
    providerSessionId: optional<string>(row.provider_session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    archived: isFlagSet(row.archived),
    messageCount: counter(row.message_count),
  };
}

export function mapMessage(row: Row): Message {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    role: row.role as Role,
    content: row.content as string,
    provider: optional<ProviderId>(row.provider),
    model: optional<string>(row.model),
    agent: optional<string>(row.agent),
    toolCalls: parseJsonColumn<Message['toolCalls']>(row.tool_calls),
    blocks: parseJsonColumn<Message['blocks']>(row.blocks),
    usage: parseJsonColumn<TurnUsage>(row.usage),
    turnId: optional<string>(row.turn_id),
    createdAt: Number(row.created_at),
  };
}

export function mapMemory(row: Row): MemoryRecord {
  return {
    id: row.id as string,
    kind: row.kind as MemoryKind,
    content: row.content as string,
    tags: parseTags(row.tags),
    importance: Number(row.importance),
    owner: (row.owner as string) ?? ASSISTANT_MEMORY_OWNER,
    evidence: optional<string>(row.evidence),
    sourceSessionId: optional<string>(row.source_session_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: nonZeroNumber(row.last_accessed_at),
    accessCount: counter(row.access_count),
    forgotten: isFlagSet(row.forgotten),
    origin: ((row.origin as string) ?? 'extract') as MemoryOrigin,
    pinned: isFlagSet(row.pinned),
    dormantAt: nonZeroNumber(row.dormant_at),
    supersededBy: optional<string>(row.superseded_by),
    sleepRunId: optional<string>(row.sleep_run_id),
    usefulness: counter(row.usefulness),
    archivedAt: nonZeroNumber(row.archived_at),
  };
}

export function mapEntity(row: Row): MemoryEntity {
  return {
    id: row.id as string,
    owner: row.owner as string,
    name: row.name as string,
    slug: row.slug as string,
    kind: ((row.kind as string) ?? 'topic') as EntityKind,
    mentions: counter(row.mentions),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
  };
}

export function mapEdge(row: Row): MemoryEdge {
  return {
    id: row.id as string,
    owner: row.owner as string,
    srcId: row.src_id as string,
    dstId: row.dst_id as string,
    relation: row.relation as MemoryRelation,
    weight: Number(row.weight ?? 0.5),
    origin: ((row.origin as string) ?? 'sleep') as MemoryEdge['origin'],
    runId: optional<string>(row.run_id),
    createdAt: Number(row.created_at),
  };
}

export function mapSleepRun(row: Row): SleepRun {
  return {
    id: row.id as string,
    owner: row.owner as string,
    trigger: row.trigger as CronTrigger,
    status: row.status as SleepStatus,
    startedAt: Number(row.started_at),
    finishedAt: nonZeroNumber(row.finished_at),
    durationMs: nonZeroNumber(row.duration_ms),
    readCount: counter(row.read_count),
    replayedCount: counter(row.replayed_count),
    learnedCount: counter(row.learned_count),
    mergedCount: counter(row.merged_count),
    dormantCount: counter(row.dormant_count),
    edgeCount: counter(row.edge_count),
    insightCount: counter(row.insight_count),
    skillCount: counter(row.skill_count),
    skillRevisedCount: counter(row.skill_revised_count),
    conflictCount: counter(row.conflict_count),
    resolvedCount: counter(row.resolved_count),
    dreamTracesSeen: counter(row.dream_traces_seen),
    dreamFramesScored: counter(row.dream_frames_scored),
    dreamCandidates: counter(row.dream_candidates),
    dreamPromoted: counter(row.dream_promoted),
    dreamLabelsWritten: counter(row.dream_labels_written),
    modelCalls: counter(row.model_calls),
    report: optional<string>(row.report),
    error: optional<string>(row.error),
    undoneAt: nonZeroNumber(row.undone_at),
  };
}

export function mapDreamTrace(row: Row): DreamTrace {
  return {
    id: row.id as string,
    turnId: row.turn_id as string,
    owner: row.owner as string,
    kind: row.kind as DreamTraceKind,
    site: row.site as DreamSite,
    pipeline: row.pipeline as DreamPipeline,
    sessionId: optional<string>(row.session_id),
    sessionKind: optional<SessionKind>(row.session_kind),
    assignmentId: optional<string>(row.assignment_id),
    sleepRunId: optional<string>(row.sleep_run_id),
    turnIndex: counter(row.turn_index),
    policySet: parseJsonColumn<Record<string, RecallPolicy>>(row.policy_set) ?? {},
    framed: isFlagSet(row.framed),
    holdout: isFlagSet(row.holdout),
    audit: isFlagSet(row.audit),
    degraded: (row.degraded as DreamDegraded | null) ?? null,
    startedAt: Number(row.started_at),
    finishedAt: nonZeroNumber(row.finished_at),
    createdAt: Number(row.created_at),
  };
}

/**
 * A frame's JSON text. Frames are stored gzipped; a payload written before
 * compression arrived is a TEXT value and is read as it is.
 */
function frameText(stored: unknown): string {
  if (typeof stored === 'string') return stored;
  return gunzipSync(stored as Uint8Array).toString('utf8');
}

/** Whether a stored frame holds any of the memories - unreadable counts as yes. */
export function frameQuotes(stored: unknown, memoryIds: readonly string[]): boolean {
  let text: string;
  try {
    text = frameText(stored);
  } catch {
    return true;
  }
  return memoryIds.some((id) => text.includes(id));
}

/**
 * Reads the `f_`-prefixed columns of the `framesFor` join. `box` and
 * `payload` are parsed directly rather than through `parseJsonColumn`:
 * both are NOT NULL columns only this store's own writer fills, so a row
 * that does not parse is corruption the night should hear about, not a
 * field that silently reads as absent.
 */
export function mapDreamFrame(row: Row): DreamFrame {
  return {
    traceId: row.f_trace_id as string,
    slot: row.f_slot as string,
    frameV: Number(row.f_frame_v),
    owner: row.f_owner as string,
    sessionId: optional<string>(row.f_session_id),
    box: JSON.parse(row.f_box as string) as RecallBox,
    corpusStampId: row.f_corpus_stamp_id as string,
    payload: JSON.parse(frameText(row.f_payload)) as RecallFrame,
    bytes: Number(row.f_bytes),
    createdAt: Number(row.f_created_at),
  };
}

export function mapDreamLabel(row: Row): DreamLabel {
  return {
    turnId: row.turn_id as string,
    target: row.target as string,
    source: row.source as DreamLabelSource,
    relevance: Number(row.relevance),
    scope: row.scope as DreamLabel['scope'],
    evidence: optional<string>(row.evidence),
    deadAt: nonZeroNumber(row.dead_at),
    createdAt: Number(row.created_at),
    // The column arrived with schema 24, so rows an older build wrote carry
    // NULL here; they belong to the assistant, which is the only owner that
    // could have written a label before agents had one.
    owner: (row.owner as string) ?? ASSISTANT_MEMORY_OWNER,
    sessionId: optional<string>(row.session_id),
  };
}

/**
 * `params` and `box` are parsed directly rather than through
 * `parseJsonColumn`, for the reason `mapDreamFrame` gives: both are NOT NULL
 * columns only this store's own writer fills, so a row that does not parse
 * is corruption the night should hear about, not a field that silently
 * reads as absent.
 */
export function mapPolicyVersion(row: Row): PolicyVersion {
  return {
    id: row.id as string,
    owner: row.owner as string,
    slot: row.slot as DreamSlot,
    version: Number(row.version),
    params: JSON.parse(row.params as string) as Record<string, unknown>,
    box: JSON.parse(row.box as string) as Record<string, unknown>,
    origin: row.origin as PolicyOrigin,
    parentId: optional<string>(row.parent_id),
    prevActiveId: optional<string>(row.prev_active_id),
    sleepRunId: optional<string>(row.sleep_run_id),
    rationale: optional<string>(row.rationale),
    replayScore: nullableNumber(row.replay_score),
    replayN: nullableNumber(row.replay_n),
    baselineScore: nullableNumber(row.baseline_score),
    auditDelta: nullableNumber(row.audit_delta),
    auditCiLow: nullableNumber(row.audit_ci_low),
    onlineScore: nullableNumber(row.online_score),
    promotedAt: nonZeroNumber(row.promoted_at),
    retiredAt: nonZeroNumber(row.retired_at),
    createdAt: Number(row.created_at),
  };
}

export function mapDreamSlotState(row: Row): DreamSlotState {
  return {
    owner: row.owner as string,
    slot: row.slot as DreamSlot,
    frozenAt: nonZeroNumber(row.frozen_at),
    frozenReason: optional<DreamSlotFreezeReason>(row.frozen_reason),
    cooldownUntil: nonZeroNumber(row.cooldown_until),
    lastPromoted: nonZeroNumber(row.last_promoted),
  };
}

export function mapDreamEval(row: Row): DreamEval {
  return {
    id: row.id as string,
    sleepRunId: row.sleep_run_id as string,
    policyId: row.policy_id as string,
    slot: row.slot as DreamSlot,
    traces: Number(row.traces),
    closed: Number(row.closed),
    abstained: Number(row.abstained),
    abstainReasons: JSON.parse(row.abstain_reasons as string) as Partial<Record<AbstainReason, number>>,
    reachableRate: Number(row.reachable_rate),
    labelCoverage: Number(row.label_coverage),
    costOnlyShare: Number(row.cost_only_share),
    score: Number(row.score),
    baseline: Number(row.baseline),
    delta: Number(row.delta),
    ciLow: Number(row.ci_low),
    ciHigh: Number(row.ci_high),
    auditDelta: nullableNumber(row.audit_delta),
    auditCiLow: nullableNumber(row.audit_ci_low),
    deltaLive: nullableNumber(row.delta_live),
    // Three worlds, not two: NULL means the freshness check was undetermined,
    // the way `DreamTrace.degraded` distinguishes "did not degrade" from
    // "not recorded".
    signAgree: row.sign_agree === null || row.sign_agree === undefined ? null : Number(row.sign_agree) === 1,
    evalMs: Number(row.eval_ms),
    traceSetHash: row.trace_set_hash as string,
    evidenceDigest: optional<string>(row.evidence_digest),
    promoted: isFlagSet(row.promoted),
    detail: parseJsonColumn<Record<string, unknown>>(row.detail),
    createdAt: Number(row.created_at),
  };
}

export function mapDreamEpisode(row: Row): DreamEpisode {
  return {
    id: row.id as string,
    owner: row.owner as string,
    kind: row.kind as DreamEpisode['kind'],
    sessionId: optional<string>(row.session_id),
    slot: row.slot as string,
    steps: Number(row.steps),
    outcome: row.outcome as DreamEpisode['outcome'],
    holdout: isFlagSet(row.holdout),
    audit: isFlagSet(row.audit),
    startedAt: Number(row.started_at),
    finishedAt: nonZeroNumber(row.finished_at),
    createdAt: Number(row.created_at),
  };
}
