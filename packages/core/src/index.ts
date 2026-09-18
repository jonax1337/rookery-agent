/**
 * @rookery/core - the assistant brain.
 *
 * The server, the CLI and the web client all sit on top of this package and
 * share its vocabulary. Nothing here knows about HTTP or terminals.
 */

export * from './types.js';
export { PROFILE_FILES, ensureProfile, readProfile, writeProfileFile, readProfileExcerpt, searchProfile, renderProfile } from './profile.js';
export * from './migration.js';
export { DEFAULT_CONFIG, applyConfig, databasePath, ensureHome, loadConfig, saveConfig } from './config.js';
export { createLogger, silentLogger, type LogLevel, type Logger } from './logger.js';

export { openDatabase, reindex, SCHEMA_VERSION, type Db } from './memory/db.js';
export { Store, entitySlug, mapEdge, mapEntity, mapMemory, mapSleepRun } from './memory/store.js';
export {
  coreProfile,
  dropContradicted,
  MEMORY_KINDS,
  recall,
  renderMemoryBlock,
  tokenize,
  toMatchQuery,
  type RecallOptions,
} from './memory/recall.js';
// The dream split of recall (stage 1, AP6): the frame records the permissive
// corner of the declared box, the scorer replays any point inside it, and the
// resolver is the one truth about the recall parameters. No barrel under
// memory/dream/ - three packages meet here, so each module exports itself.
export {
  boxFromOptions,
  fetchFrame,
  isPointBox,
  SEEDS_CAP,
  type FetchFrameOptions,
} from './memory/dream/frame.js';
export {
  dropContradictedFromFrame,
  groupFromFrame,
  mergeProfile,
  pipelineAgent,
  pipelineAssistant,
  renderFromFrame,
  scoreFrame,
  type FrameScoringPolicy,
  type PipelineResult,
} from './memory/dream/score.js';
export { resolvePolicy } from './memory/dream/policy.js';
// The block measure (stage 1, AP8): scores what the model read, not what
// recall returned, against a caller-supplied gain.
export {
  deltaIsLabelBacked,
  isScalarMultiple,
  measure,
  normaliseWeights,
  type DeltaPosition,
  type GainFunction,
  type MeasureResult,
} from './memory/dream/measure.js';
// The night's grid probe (stage 1, AP10): fixed placements against the
// incumbent over the stored frames, the freshness sensor against the live
// bank, the corpus fingerprint once per night. Appended after the measure
// block, never reordered - three packages meet in this file.
export {
  bootstrapCi,
  buildGrid,
  corpusDrifted,
  freshnessCheck,
  runGridProbe,
  type FreshnessEntry,
  type FreshnessOptions,
  type FreshnessReport,
  type GridPlacementReport,
  type ProbeOptions,
  type ProbeReport,
} from './memory/dream/probe.js';
// Stage 2+ of the dream. Appended after the probe block, never reordered -
// seven packages meet in this file, so each module keeps its own export list.
// Labels (AP4): the four sources turned into a gain, and the arithmetic that
// says how much of the measure is actually backed by one.
export {
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
  type CorrectionLabelInput,
  type GainResult,
  type LabelMessage,
  type LabelTarget,
  type LabelTurn,
  type MergeLabelInput,
  type MergeTarget,
  type RatingPair,
  type ReviewLabelInput,
  type TurnLocation,
  type UserLabelInput,
} from './memory/dream/label.js';
// Admission (AP5): the predicates that run before a candidate gets a number,
// because against a legal degenerate candidate a comparison does not help.
export {
  admit,
  boxViolations,
  coverageFloorHolds,
  isWeightScalarMultiple,
  revivalRateHolds,
  type AdmissionResult,
  type AdmissionStats,
} from './memory/dream/admission.js';
// The candidate writer (AP6): numeric aggregates in, a parameter set out, and
// never a word of anybody's text in between.
export {
  buildAggregates,
  parseCandidate,
  proposeCandidates,
  renderCandidatePrompt,
  withIncumbent,
  type CandidateAggregates,
  type CandidateParse,
  type CandidateProposal,
  type CandidateRequest,
  type ComponentMeans,
} from './memory/dream/candidate.js';
// First-divergence scoring (AP7): a recorded trajectory as a prefix-closed
// simulator. Off by default; the proxy gate decides whether it ever lives.
export {
  PROXY_AGREEMENT_FLOOR,
  PROXY_MIN_SAMPLES,
  TOOL_INPUT_LIMIT,
  argsHashOf,
  canonicalJson,
  divergenceProxyReport,
  episodeFromEvents,
  hashCanonicalJson,
  judgeEpisode,
  type DecisionContext,
  type DivergenceProxyReport,
  type DivergenceSample,
  type EpisodeJudgement,
  type EpisodeSource,
  type JournalledEvent,
  type JudgementStop,
  type ProposedAction,
  type StepDecider,
  type StepObservation,
} from './memory/dream/trajectory.js';
// The write gate and the night shift: what may enter the bank at all, and
// what happens to it once nobody is asking anything.
export {
  admitCandidates,
  confirmedBy,
  linkEntities,
  normalizeTokens,
  similarity,
  type GateInput,
  type GateResult,
} from './memory/gate.js';
export {
  SleepRunner,
  allocateNightBudget,
  describeSleep,
  parseObject,
  share,
  type NightBudgets,
  type NightCeilings,
  type NightDemand,
  type SleepInput,
  type SleepRunnerOptions,
} from './memory/sleep.js';
export {
  extractMemories,
  parseCandidates,
  smallModelFor,
  type ExtractionInput,
  type MemoryCandidate,
} from './memory/extractor.js';

export { ClaudeCodeProvider } from './providers/claude-code.js';
export { ProviderRegistry } from './providers/registry.js';
export {
  providerQuota,
  rememberQuota,
  isUsageLimitError,
  rememberUsageFailure,
  rememberUsageRecovered,
  providerBlocked,
  providerLow,
  type UsageBlock,
} from './providers/quota.js';
export { withProviderProfile, withoutProviderProfile, publicProviderProfile } from './providers/profiles.js';
export { RouterManager, sharedRouterManager } from './providers/router.js';
export { CodexBridge, sharedCodexBridge } from './providers/codex-bridge.js';
export { CodexSession, sharedCodexSession } from './providers/codex-auth.js';
export {
  TurnTranslator,
  toResponsesRequest,
  readServerSentEvents,
} from './providers/codex-translate.js';
export {
  PROVIDER_CATALOG,
  CODEX_PROFILE,
  codexModels,
  codexContextWindow,
  prettifyModelId,
  providerCatalogEntry,
  profileWithCatalog,
  remapModel,
  type ProviderCatalogEntry,
} from './providers/provider-catalog.js';
export {
  readJsonLines,
  resolveBinary,
  runCapture,
  spawnCli,
  type ResolvedBinary,
} from './providers/process.js';

export { buildSystemPrompt, deriveTitle, toSpeakableText, type ContextInput } from './agents/persona.js';

// The organisation: durable agents the assistant delegates to. There is
// still one conversational identity and no API anywhere that swaps it.
export { OrgStore, slugify } from './org/store.js';
export {
  OrgController,
  describeAssignment,
  describePlan,
  toView,
  type OrgControllerOptions,
  type RunAssignmentInput,
  type ToolContext,
} from './org/controller.js';
export { BridgeServer, bridgeScriptPath, type ToolCallResult, type ToolHandler } from './org/bridge.js';
export {
  assistantOrgBlock,
  buildAgentPrompt,
  renderBoard,
  renderInbox,
  renderMail,
  renderOrgOverview,
  type AgentPromptInput,
  type OrgSnapshot,
} from './org/prompts.js';
export {
  buildTaskWaves,
  normaliseTaskPlan,
  parseTaskPlan,
  planTask,
  PLAN_MARKER,
  type PlannedSubtask,
  type TaskPlan,
} from './org/planner.js';
export { MCP_SERVER_NAME, ORG_TOOLS, toolsFor, type ToolAudience, type ToolDefinition } from './org/tools.js';
export {
  fingerprintMcpFile,
  projectMcpPath,
  projectMcpStatus,
  readProjectMcpFile,
  renderProjectMcpServers,
  type ProjectMcpFile,
  type ProjectMcpStatus,
} from './org/project-mcp.js';

// Schedules: standing orders that fire on a cron expression while the server runs.
export { CronStore } from './cron/store.js';
export { readCronScript } from './cron/script.js';
export {
  CronScheduler,
  describeCronJob,
  type CronJobInput,
  type CronJobPatch,
  type CronRunner,
  type CronRunOutcome,
  type CronSchedulerOptions,
} from './cron/scheduler.js';
export {
  CronSyntaxError,
  describeCron,
  isValidCron,
  matchesCron,
  nextCronRun,
  parseCron,
  upcomingCronRuns,
  type CronSchedule,
} from './cron/parse.js';

// Computer control: the screen, mouse and keyboard of the machine, for the assistant only.
export {
  COMPUTER_SERVER_NAME,
  COMPUTER_TOOLS,
  computerEngine,
  computerPromptBlock,
  computerScriptPath,
  computerServerSpec,
  zavoraServerPath,
  type ComputerEngine,
  type ComputerToolDefinition,
} from './computer/tools.js';
export { parseKeyCombo, parseKeySequence } from './computer/keys.js';

// The MCP hub and the skills folder: what else a turn may bring along.
export {
  TOOL_CATALOG,
  catalogEntry,
  npxSpec,
  type CatalogEnv,
  type CatalogOption,
  type ToolCatalogEntry,
} from './tools/catalog.js';
export { BROWSER_DEBUG_PORT, browserAlive, browserExecutable, ensureBrowser } from './tools/browser.js';
export {
  PERMISSION_DENY_BASELINE,
  customToolId,
  dormantToolsHint,
  ensureToolServers,
  externalAgentStates,
  externalHookStates,
  externalPluginStates,
  externalTurnExtras,
  renderToolServers,
  toolServerConfig,
  toolServerStates,
  toolServersFor,
  withExternalApproval,
  withToolServer,
  withoutToolServer,
  type ExternalAgentState,
  type ExternalHookState,
  type ExternalPluginState,
  type ToolServerState,
} from './tools/hub.js';
export {
  QuestionRegistry,
  questionEvent,
  type AskOptions,
  type PendingQuestion,
  type QuestionCloseReason,
  type QuestionRequest,
} from './org/questions.js';
export {
  TurnJournal,
  type JournalEntry,
  type JournalTurn,
} from './turns/journal.js';
export {
  BUILTIN_SKILLS,
  builtinSkill,
  builtinSkills,
  isBuiltinSkill,
  type BuiltinSkill,
} from './skills/builtin.js';
export {
  SkillStore,
  readSkillFolder,
  renderSkill,
  renderSkillsIndex,
  skillSlug,
  type Skill,
  type SkillInput,
  type SkillOrigin,
} from './skills/store.js';
export {
  matchSkills,
  renderSkillMatches,
  type SkillMatch,
} from './skills/suggest.js';
export {
  externalSkillsFor,
  externalSources,
  findExternalSkills,
  openExternalSkill,
  renderExternalSkillsHint,
  renderSkillHits,
  type SkillHit,
} from './skills/shelf.js';
export {
  enabledExternalSkills,
  externalScan,
  refreshExternal,
  sourceEnabled,
  type ExternalMcpServer,
  type ExternalScan,
  type ExternalSkillRef,
  type ExternalSource,
} from './external/discovery.js';
export { claudeHome } from './external/homes.js';
export {
  SKILL_SOURCES,
  importSkillFromGitHub,
  parseSkillSource,
  type ImportResult,
  type SkillSource,
  type SkillSourceEntry,
} from './skills/import.js';
export { EventQueue, clip, shorten, titleFromBrief } from './util/queue.js';
export { TurnBlocks } from './util/blocks.js';
export { formatAge, formatDay, formatNow, formatWhen, localOffset, localZone } from './util/time.js';
export * from './gateway/policy.js';

export {
  Assistant,
  type AssignInput,
  type AssistantOptions,
  type ChatInput,
  type MemoryLearnedEvent,
  type RunTaskInput,
} from './runtime.js';
