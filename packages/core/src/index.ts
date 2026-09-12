/**
 * @rookery/core - the assistant brain.
 *
 * The server, the CLI and the web client all sit on top of this package and
 * share its vocabulary. Nothing here knows about HTTP or terminals.
 */

export * from './types.js';
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
// The write gate and the night shift: what may enter the bank at all, and
// what happens to it once nobody is asking anything.
export {
  admitCandidates,
  linkEntities,
  normalizeTokens,
  similarity,
  type GateInput,
  type GateResult,
} from './memory/gate.js';
export {
  SleepRunner,
  describeSleep,
  parseObject,
  share,
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
export { CodexProvider } from './providers/codex.js';
export { ProviderRegistry } from './providers/registry.js';
export { providerQuota, rememberQuota } from './providers/quota.js';
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
  buildAgentChatPrompt,
  buildAgentPrompt,
  renderBoard,
  renderInbox,
  renderOrgOverview,
  type AgentChatPromptInput,
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

// Schedules: standing orders that fire on a cron expression while the server runs.
export { CronStore } from './cron/store.js';
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
  customToolId,
  dormantToolsHint,
  ensureToolServers,
  renderToolServers,
  toolServerConfig,
  toolServerStates,
  toolServersFor,
  withToolServer,
  withoutToolServer,
  type ToolServerState,
} from './tools/hub.js';
export { SkillStore, renderSkill, renderSkillsIndex, skillSlug, type Skill, type SkillInput } from './skills/store.js';
export {
  SKILL_SOURCES,
  importSkillFromGitHub,
  parseSkillSource,
  type ImportResult,
  type SkillSource,
  type SkillSourceEntry,
} from './skills/import.js';
export { EventQueue, clip, shorten } from './util/queue.js';
export * from './gateway/policy.js';

export {
  Assistant,
  type AssignInput,
  type AssistantOptions,
  type ChatInput,
  type MemoryLearnedEvent,
  type RunTaskInput,
} from './runtime.js';
