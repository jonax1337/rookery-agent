import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseCron } from './cron/parse.js';
import { databasePath } from './config.js';
import type { Store } from './memory/store.js';
import type { CronScript, RookeryConfig } from './types.js';
import type { MigrationSource } from './migration.js';
import { inspectScriptBundle, type ScriptAsset, type ScriptBundle } from './migration-scripts.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES } from './migration-shared.js';

export interface MigrationJob {
  sourceId: string; name: string; schedule: string; prompt: string;
  kind?: 'assistant' | 'script'; script?: CronScript; remainingRuns?: number;
  assets?: { sourcePath: string; targetPath: string; bytes: number }[];
}
type PlannedJob = MigrationJob & { id: string };
export interface MigrationCronPlan {
  jobs: PlannedJob[];
  warnings: string[];
  fingerprint: string;
  destinationFingerprint: string;
  existingIds: Set<string>;
  assets: (ScriptAsset & { jobId: string })[];
}
type Row = Record<string, unknown>;
type PathCheck = (path: string) => void;

interface SourceJobs { rawJobs: unknown[]; data: string; warnings: string[] }
interface PlanContext {
  config: RookeryConfig;
  source: MigrationSource;
  root: string;
  check: PathCheck;
  sourceTimezone: string | undefined;
  hostTimezone: string;
  seenIds: Set<string>;
}
/** Outcome of planning one source job; `job` is absent when the job was skipped. */
interface JobPlan { job?: PlannedJob; assets: ScriptAsset[]; warnings: string[] }

const MAX_JOBS = 1000;
const MAX_ASSET_FILES = 1000;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const CRON_FIELD_COUNT = 5;
const TIMEZONE_LINE = /^timezone:[^\r\n]*/m;
const TIMEZONE_VALUE = /^timezone:\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/;
const HOURLY_EXPRESSION = /^0\s+\*\s/;

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const asRecord = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

function readText(path: string, check: PathCheck): string {
  check(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`Cron input must be a regular file of at most 1 MiB: ${path}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
  catch { throw new Error(`Cron input is not readable UTF-8: ${path}`); }
}

/** Work on disposable copies so reading a live WAL database never creates files in the source. */
function snapshotDatabase<T>(path: string, check: PathCheck, read: (db: DatabaseSync) => T): T {
  const temporary = mkdtempSync(join(tmpdir(), 'rookery-cron-preview-'));
  let db: DatabaseSync | undefined;
  try {
    let total = 0;
    for (const suffix of ['', '-wal']) {
      const file = `${path}${suffix}`;
      check(file);
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      total += stat.size;
      if (!stat.isFile() || total > MAX_SNAPSHOT_BYTES) throw new Error('Cron database snapshot exceeds the 256 MiB limit or is not a regular file. Export jobs.json into the selected workspace.');
      copyFileSync(file, join(temporary, `snapshot.sqlite${suffix}`));
      const after = lstatSync(file);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Cron database changed during the preview. Try again when the source scheduler is idle.');
    }
    db = new DatabaseSync(join(temporary, 'snapshot.sqlite'), { readOnly: true });
    return read(db);
  } finally { db?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

function hasCronTable(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'").get() !== undefined;
}

function rowsForJobs(db: DatabaseSync, jobs: PlannedJob[]): Row[] {
  if (!hasCronTable(db)) return [];
  const get = db.prepare('SELECT * FROM cron_jobs WHERE id = ?');
  return jobs.flatMap(job => { const row = get.get(job.id) as Row | undefined; return row ? [row] : []; });
}

export function cronDestinationFingerprint(store: Store, plan: MigrationCronPlan): string {
  return digest(JSON.stringify(rowsForJobs(store.db, plan.jobs)));
}

function readJobsFile(location: string, check: PathCheck): SourceJobs {
  const data = readText(location, check);
  const document: unknown = JSON.parse(data);
  const jobs = Array.isArray(document) ? document : asRecord(document).jobs;
  if (!Array.isArray(jobs)) throw new Error('Cron jobs.json must contain a jobs array.');
  return { rawJobs: jobs, data, warnings: [] };
}

function readOpenClawDatabaseJobs(database: string, storeKey: string, check: PathCheck): SourceJobs {
  const found = snapshotDatabase(database, check, db => {
    if (!hasCronTable(db)) return undefined;
    // A shared database may contain unrelated profiles and custom stores. Never infer their ownership.
    return db.prepare(`SELECT job_json FROM cron_jobs WHERE store_key = ? ORDER BY job_id LIMIT ${MAX_JOBS + 1}`).all(storeKey) as Row[];
  });
  const rows = found ?? [];
  const warnings = found?.length === 0
    ? ['No cron jobs matched this OpenClaw workspace store. For a copied or custom profile, export its jobs.json into the selected workspace.']
    : [];
  return { rawJobs: rows.map(row => JSON.parse(String(row.job_json)) as unknown), data: JSON.stringify(rows), warnings };
}

/** A jobs file wins over an OpenClaw state database, which is only consulted for a bare `workspace` folder. */
function loadSourceJobs(source: MigrationSource, root: string, check: PathCheck): SourceJobs {
  let location = join(root, 'cron', 'jobs.json');
  const exported = join(root, 'jobs.json');
  check(exported);
  check(location);
  let loaded: SourceJobs = { rawJobs: [], data: '', warnings: [] };
  if (source === 'openclaw' && existsSync(exported)) location = exported;
  else if (source === 'openclaw' && !existsSync(location) && basename(root).toLowerCase() === 'workspace') {
    const state = dirname(root);
    const database = join(state, 'state', 'openclaw.sqlite');
    location = join(state, 'cron', 'jobs.json');
    check(database);
    check(location);
    if (existsSync(database)) {
      loaded = readOpenClawDatabaseJobs(database, resolve(location), check);
      location = '';
    }
  }
  if (location && existsSync(location)) loaded = readJobsFile(location, check);
  if (loaded.rawJobs.length > MAX_JOBS) throw new Error(`Cron migration exceeds the ${MAX_JOBS} job limit.`);
  if (Buffer.byteLength(loaded.data) > MAX_TOTAL_BYTES) throw new Error('Cron migration exceeds the 16 MiB data limit.');
  return loaded;
}

/** Hermes keeps one scheduler timezone in config.yaml; `data` feeds the plan fingerprint. */
function readHermesTimezone(root: string, check: PathCheck): { timezone: string | undefined; data: string } {
  const configPath = join(root, 'config.yaml');
  check(configPath);
  if (!existsSync(configPath)) return { timezone: undefined, data: '' };
  const line = readText(configPath, check).match(TIMEZONE_LINE)?.[0];
  const timezone = line ? parseTimezoneSetting(line) : undefined;
  return { timezone, data: JSON.stringify({ timezone }) };
}

function parseTimezoneSetting(line: string): string | undefined {
  const match = line.match(TIMEZONE_VALUE);
  return match ? (match[1] ?? match[2] ?? match[3])?.trim() : 'unsupported timezone setting';
}

function cronExpression(schedule: Row): string | undefined {
  const { kind, expr } = schedule;
  if (kind !== 'cron' || typeof expr !== 'string') return undefined;
  return expr.trim().split(/\s+/).length === CRON_FIELD_COUNT ? expr : undefined;
}

function timezoneReason(requested: unknown, hostTimezone: string): string | undefined {
  if (!requested) return undefined;
  let canonical: string | undefined;
  try { canonical = new Intl.DateTimeFormat('en', { timeZone: String(requested) }).resolvedOptions().timeZone; } catch { /* rejected below */ }
  return canonical === hostTimezone ? undefined : `timezone ${String(requested)} differs from Rookery's local timezone ${hostTimezone}`;
}

/** Why Rookery cannot reproduce this job's schedule, trigger or execution target; undefined when it can. */
function unsupportedReason(context: PlanContext, job: Row, expression: string): string | undefined {
  const { source } = context;
  const schedule = asRecord(job.schedule);
  const payload = asRecord(job.payload);
  try { parseCron(expression); } catch { return 'the cron expression is not supported by Rookery'; }
  const zoneProblem = timezoneReason(schedule.tz ?? job.timezone ?? context.sourceTimezone, context.hostTimezone);
  if (zoneProblem) return zoneProblem;
  if (schedule.staggerMs) return 'staggered execution is not supported';
  if (job.trigger || job.pacing) return 'conditional triggers and pacing require manual migration';
  if (source === 'openclaw' && schedule.staggerMs === undefined && HOURLY_EXPRESSION.test(expression.trim())) return 'OpenClaw implicitly staggers this hourly schedule; export an exact schedule with staggerMs: 0';
  if (job.agentId && job.agentId !== 'main') return `the source agent "${String(job.agentId)}" has no Rookery agent mapping`;
  if (job.monitor_script || job.monitor_url || job.context_from) return 'monitor gates and chained context require an execution adapter';
  if (typeof job.state === 'string' && !['scheduled', 'paused'].includes(job.state)) return `source state is ${job.state}`;
  if (source === 'openclaw' && (payload.kind !== 'agentTurn' || (job.sessionTarget && !['isolated', 'main'].includes(String(job.sessionTarget))))) return 'the execution target or system-event payload requires manual migration';
  return undefined;
}

function hasValidRepeatCounts(repeat: Row): boolean {
  const completed = repeat.completed ?? 0;
  return Number.isSafeInteger(repeat.times) && Number(repeat.times) >= 1 && Number.isSafeInteger(completed) && Number(completed) >= 0;
}

/** A skip reason (string) or the copied script bundle. */
function planScript(context: PlanContext, job: Row): ScriptBundle | string {
  if (context.source !== 'hermes' || typeof job.script !== 'string') return 'this script format is not supported';
  if (job.workdir) return 'a custom script working directory needs explicit relocation';
  const scriptJob = { root: context.root, id: String(job.id), file: job.script, noAgent: job.no_agent === true };
  try { return inspectScriptBundle(context.config, scriptJob, context.check); }
  catch (error) { return `script bundle could not be prepared: ${(error as Error).message}`; }
}

function planJob(context: PlanContext, raw: unknown): JobPlan {
  const { source, root } = context;
  const job = asRecord(raw);
  const payload = asRecord(job.payload);
  const label = typeof job.name === 'string' ? job.name : String(job.id ?? 'unnamed job');
  const warnings: string[] = [];
  const skip = (reason: string): JobPlan => {
    warnings.push(`Skipped schedule "${label}": ${reason}.`);
    return { assets: [], warnings };
  };
  if (typeof job.id !== 'string' || !job.id || typeof job.name !== 'string' || !job.name.trim()) return skip('a stable ID and name are required');
  if (context.seenIds.has(job.id)) throw new Error(`Duplicate source cron job ID: ${job.id}`);
  context.seenIds.add(job.id);
  const expression = cronExpression(asRecord(job.schedule));
  if (expression === undefined) return skip('only recurring five-field cron expressions are supported');
  const reason = unsupportedReason(context, job, expression);
  if (reason) return skip(reason);
  const scriptOnly = Boolean(job.script) && job.no_agent === true;
  const prompt = source === 'hermes' ? (job.prompt ?? (scriptOnly ? '' : undefined)) : payload.message;
  if (typeof prompt !== 'string' || (!prompt.trim() && !scriptOnly) || Buffer.byteLength(prompt) > MAX_FILE_BYTES) return skip('a nonempty prompt of at most 1 MiB is required');
  let remainingRuns: number | undefined = job.deleteAfterRun ? 1 : undefined;
  const repeat = asRecord(job.repeat);
  if (source === 'hermes' && repeat.times != null) {
    if (!hasValidRepeatCounts(repeat)) return skip('repeat counts must be nonnegative whole numbers with a positive limit');
    remainingRuns = Math.max(0, Number(repeat.times) - Number(repeat.completed ?? 0));
  }
  const bundle = job.script ? planScript(context, job) : undefined;
  if (typeof bundle === 'string') return skip(bundle);
  if (bundle) warnings.push(...bundle.warnings.map(warning => `Schedule "${label}": ${warning}`));
  const assets = bundle?.assets ?? [];
  const planned: PlannedJob = {
    id: `migration-${source}-${digest(JSON.stringify([root, job.id]))}`,
    sourceId: job.id, name: job.name, schedule: expression, prompt,
    kind: bundle ? 'script' : 'assistant', script: bundle?.script, remainingRuns,
    assets: assets.map(({ sourcePath, targetPath, bytes }) => ({ sourcePath, targetPath, bytes })),
  };
  if (job.deliver || job.delivery || job.skills || job.skill || payload.model || payload.tools || job.sessionTarget === 'main') {
    warnings.push(`Schedule "${label}": delivery, skills, model/tool settings and existing sessions are not transferred; review the paused schedule before enabling it.`);
  }
  return { job: planned, assets, warnings };
}

function assetFootprint(assets: ScriptAsset[]): number {
  return assets.reduce((sum, asset) => sum + asset.content.length + (asset.previous?.length ?? 0), 0);
}

function assetFingerprint(asset: ScriptAsset & { jobId: string }): unknown[] {
  return [asset.jobId, asset.sourcePath, asset.targetPath, digest(asset.content), asset.previous === undefined ? null : digest(asset.previous)];
}

export function inspectMigrationCron(config: RookeryConfig, source: MigrationSource, root: string, check: PathCheck): MigrationCronPlan {
  const sourceJobs = loadSourceJobs(source, root, check);
  const warnings = [...sourceJobs.warnings];
  const hermes = source === 'hermes' && sourceJobs.rawJobs.length > 0 ? readHermesTimezone(root, check) : { timezone: undefined, data: '' };
  const sourceData = sourceJobs.data + hermes.data;
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const context: PlanContext = { config, source, root, check, sourceTimezone: hermes.timezone, hostTimezone, seenIds: new Set() };
  const jobs: PlannedJob[] = [];
  const assets: (ScriptAsset & { jobId: string })[] = [];
  for (const raw of sourceJobs.rawJobs) {
    const plan = planJob(context, raw);
    warnings.push(...plan.warnings);
    const planned = plan.job;
    if (!planned) continue;
    assets.push(...plan.assets.map(asset => ({ ...asset, jobId: planned.id })));
    if (assets.length > MAX_ASSET_FILES || assetFootprint(assets) > MAX_ASSET_BYTES) throw new Error('Script migration exceeds the 1000-file or 32 MiB combined source and backup limit.');
    jobs.push(planned);
  }
  if (jobs.length > 0) warnings.push(`Schedules are imported paused with chat-only permission and no next run. Review prompts, tools, delivery and timezone (${hostTimezone}) before enabling them; the original scheduler remains unchanged.`);
  const destination = databasePath(config);
  check(destination);
  const rows = jobs.length > 0 && existsSync(destination) ? snapshotDatabase(destination, check, db => rowsForJobs(db, jobs)) : [];
  const destinationFingerprint = digest(JSON.stringify(rows));
  const existingIds = new Set(rows.map(row => String(row.id)));
  if (existingIds.size > 0) warnings.push(`${existingIds.size} previously imported schedule(s) will keep their current Rookery settings.`);
  const assetHashes = assets.map(assetFingerprint);
  return { jobs, assets, warnings, existingIds, destinationFingerprint, fingerprint: digest(JSON.stringify({ sourceData, jobs, assetHashes, destinationFingerprint, destination })) };
}

/** The caller owns the transaction, allowing Markdown writes and schedule inserts to roll back together. */
export function insertMigrationCron(store: Store, config: RookeryConfig, plan: MigrationCronPlan): string[] {
  const pending = plan.jobs.filter(job => !plan.existingIds.has(job.id));
  if (pending.length === 0) return [];
  const organization = store.org.listOrganizations()[0] ?? store.org.createOrganization({ name: `${config.assistantName || 'Rookery'} & Co.`, mission: 'The personal assistant company.' });
  const insert = store.db.prepare(`INSERT INTO cron_jobs
    (id,org_id,name,schedule,kind,prompt,permission,enabled,once,created_by,created_at,updated_at,next_run_at,run_count,script_json,remaining_runs)
    VALUES (?,?,?,?,?,?,'chat',0,0,'user',?,?,NULL,0,?,?)`);
  const now = Date.now();
  for (const job of pending) insert.run(job.id, organization.id, job.name, job.schedule, job.kind ?? 'assistant', job.prompt, now, now, job.script ? JSON.stringify(job.script) : null, job.remainingRuns ?? null);
  return pending.map(job => job.id);
}
