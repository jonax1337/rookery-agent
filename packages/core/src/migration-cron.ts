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
import { inspectScriptBundle, type ScriptAsset } from './migration-scripts.js';

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
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

function readText(path: string, check: (path: string) => void): string {
  check(path);
  if (!lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024) throw new Error(`Cron input must be a regular file of at most 1 MiB: ${path}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)); }
  catch { throw new Error(`Cron input is not readable UTF-8: ${path}`); }
}

/** Work on disposable copies so reading a live WAL database never creates files in the source. */
function snapshotDatabase<T>(path: string, check: (path: string) => void, read: (db: DatabaseSync) => T): T {
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
      if (!stat.isFile() || total > 256 * 1024 * 1024) throw new Error('Cron database snapshot exceeds the 256 MiB limit or is not a regular file. Export jobs.json into the selected workspace.');
      copyFileSync(file, join(temporary, `snapshot.sqlite${suffix}`));
      const after = lstatSync(file);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('Cron database changed during the preview. Try again when the source scheduler is idle.');
    }
    db = new DatabaseSync(join(temporary, 'snapshot.sqlite'), { readOnly: true });
    return read(db);
  } finally { db?.close(); rmSync(temporary, { recursive: true, force: true }); }
}

function rowsForJobs(db: DatabaseSync, jobs: PlannedJob[]): Row[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'").get()) return [];
  const get = db.prepare('SELECT * FROM cron_jobs WHERE id = ?');
  return jobs.flatMap(job => { const row = get.get(job.id) as Row | undefined; return row ? [row] : []; });
}

export function cronDestinationFingerprint(store: Store, plan: MigrationCronPlan): string {
  return digest(JSON.stringify(rowsForJobs(store.db, plan.jobs)));
}

export function inspectMigrationCron(config: RookeryConfig, source: MigrationSource, root: string, check: (path: string) => void): MigrationCronPlan {
  const warnings: string[] = [];
  let rawJobs: unknown[] = [];
  let sourceData = '';
  let timezone: unknown;
  let location = join(root, 'cron', 'jobs.json');
  const exported = join(root, 'jobs.json');
  check(exported);
  check(location);
  if (source === 'openclaw' && existsSync(exported)) location = exported;
  else if (source === 'openclaw' && !existsSync(location) && basename(root).toLowerCase() === 'workspace') {
    const state = dirname(root);
    const database = join(state, 'state', 'openclaw.sqlite');
    location = join(state, 'cron', 'jobs.json');
    check(database);
    check(location);
    if (existsSync(database)) {
      const storeKey = resolve(location);
      const rows = snapshotDatabase(database, check, db => {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_jobs'").get()) return [];
        // A shared database may contain unrelated profiles and custom stores. Never infer their ownership.
        const rows = db.prepare('SELECT job_json FROM cron_jobs WHERE store_key = ? ORDER BY job_id LIMIT 1001').all(storeKey) as Row[];
        if (rows.length === 0) warnings.push('No cron jobs matched this OpenClaw workspace store. For a copied or custom profile, export its jobs.json into the selected workspace.');
        return rows;
      });
      sourceData = JSON.stringify(rows);
      rawJobs = rows.map(row => JSON.parse(String(row.job_json)) as unknown);
      location = '';
    }
  }
  if (location && existsSync(location)) {
    sourceData = readText(location, check);
    const document: unknown = JSON.parse(sourceData);
    const jobs = Array.isArray(document) ? document : object(document).jobs;
    if (!Array.isArray(jobs)) throw new Error('Cron jobs.json must contain a jobs array.');
    rawJobs = jobs;
  }
  if (rawJobs.length > 1000) throw new Error('Cron migration exceeds the 1000 job limit.');
  if (Buffer.byteLength(sourceData) > 16 * 1024 * 1024) throw new Error('Cron migration exceeds the 16 MiB data limit.');
  if (source === 'hermes' && rawJobs.length > 0) {
    const configPath = join(root, 'config.yaml');
    check(configPath);
    if (existsSync(configPath)) {
      const text = readText(configPath, check);
      const line = text.match(/^timezone:[^\r\n]*/m)?.[0];
      if (line) {
        const match = line.match(/^timezone:\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#.*)?$/);
        timezone = match ? (match[1] ?? match[2] ?? match[3])?.trim() : 'unsupported timezone setting';
      }
      sourceData += JSON.stringify({ timezone });
    }
  }
  const jobs: PlannedJob[] = [];
  const assets: (ScriptAsset & { jobId: string })[] = [];
  const seen = new Set<string>();
  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const raw of rawJobs) {
    const job = object(raw);
    const label = typeof job.name === 'string' ? job.name : String(job.id ?? 'unnamed job');
    const skip = (reason: string) => warnings.push(`Skipped schedule "${label}": ${reason}.`);
    if (typeof job.id !== 'string' || !job.id || typeof job.name !== 'string' || !job.name.trim()) { skip('a stable ID and name are required'); continue; }
    if (seen.has(job.id)) throw new Error(`Duplicate source cron job ID: ${job.id}`);
    seen.add(job.id);
    const schedule = object(job.schedule);
    if (schedule.kind !== 'cron' || typeof schedule.expr !== 'string' || schedule.expr.trim().split(/\s+/).length !== 5) { skip('only recurring five-field cron expressions are supported'); continue; }
    try { parseCron(schedule.expr); } catch { skip('the cron expression is not supported by Rookery'); continue; }
    const tz = schedule.tz ?? job.timezone ?? timezone;
    if (tz) {
      let canonical: string | undefined;
      try { canonical = new Intl.DateTimeFormat('en', { timeZone: String(tz) }).resolvedOptions().timeZone; } catch { /* rejected below */ }
      if (canonical !== hostTimezone) { skip(`timezone ${String(tz)} differs from Rookery's local timezone ${hostTimezone}`); continue; }
    }
    if (schedule.staggerMs) { skip('staggered execution is not supported'); continue; }
    if (job.trigger || job.pacing) { skip('conditional triggers and pacing require manual migration'); continue; }
    if (source === 'openclaw' && schedule.staggerMs === undefined && /^0\s+\*\s/.test(schedule.expr.trim())) { skip('OpenClaw implicitly staggers this hourly schedule; export an exact schedule with staggerMs: 0'); continue; }
    if (job.agentId && job.agentId !== 'main') { skip(`the source agent "${String(job.agentId)}" has no Rookery agent mapping`); continue; }
    if (job.monitor_script || job.monitor_url || job.context_from) { skip('monitor gates and chained context require an execution adapter'); continue; }
    if (typeof job.state === 'string' && !['scheduled', 'paused'].includes(job.state)) { skip(`source state is ${job.state}`); continue; }
    const payload = object(job.payload);
    if (source === 'openclaw' && (payload.kind !== 'agentTurn' || (job.sessionTarget && !['isolated', 'main'].includes(String(job.sessionTarget))))) { skip('the execution target or system-event payload requires manual migration'); continue; }
    const prompt = source === 'hermes' ? (job.prompt ?? (job.script && job.no_agent === true ? '' : undefined)) : payload.message;
    if (typeof prompt !== 'string' || (!prompt.trim() && !(job.script && job.no_agent === true)) || Buffer.byteLength(prompt) > 1024 * 1024) { skip('a nonempty prompt of at most 1 MiB is required'); continue; }
    let remainingRuns: number | undefined = job.deleteAfterRun ? 1 : undefined;
    if (source === 'hermes' && object(job.repeat).times != null) {
      const repeat = object(job.repeat);
      const completed = repeat.completed ?? 0;
      if (!Number.isSafeInteger(repeat.times) || Number(repeat.times) < 1 || !Number.isSafeInteger(completed) || Number(completed) < 0) { skip('repeat counts must be nonnegative whole numbers with a positive limit'); continue; }
      remainingRuns = Math.max(0, Number(repeat.times) - Number(completed));
    }
    const id = `migration-${source}-${digest(JSON.stringify([root, job.id]))}`;
    let script: CronScript | undefined;
    let scriptAssets: ScriptAsset[] = [];
    if (job.script) {
      if (source !== 'hermes' || typeof job.script !== 'string') { skip('this script format is not supported'); continue; }
      if (job.workdir) { skip('a custom script working directory needs explicit relocation'); continue; }
      try {
        const bundle = inspectScriptBundle(config, root, job.id, job.script, job.no_agent === true, check);
        script = bundle.script;
        scriptAssets = bundle.assets;
        warnings.push(...bundle.warnings.map(warning => `Schedule "${label}": ${warning}`));
      } catch (error) { skip(`script bundle could not be prepared: ${(error as Error).message}`); continue; }
    }
    assets.push(...scriptAssets.map(asset => ({ ...asset, jobId: id })));
    if (assets.length > 1000 || assets.reduce((sum, asset) => sum + asset.content.length + (asset.previous?.length ?? 0), 0) > 32 * 1024 * 1024) throw new Error('Script migration exceeds the 1000-file or 32 MiB combined source and backup limit.');
    jobs.push({ id, sourceId: job.id, name: job.name, schedule: schedule.expr, prompt, kind: script ? 'script' : 'assistant', script, remainingRuns, assets: scriptAssets.map(({ sourcePath, targetPath, bytes }) => ({ sourcePath, targetPath, bytes })) });
    if (job.deliver || job.delivery || job.skills || job.skill || payload.model || payload.tools || job.sessionTarget === 'main') {
      warnings.push(`Schedule "${label}": delivery, skills, model/tool settings and existing sessions are not transferred; review the paused schedule before enabling it.`);
    }
  }
  if (jobs.length > 0) warnings.push(`Schedules are imported paused with chat-only permission and no next run. Review prompts, tools, delivery and timezone (${hostTimezone}) before enabling them; the original scheduler remains unchanged.`);
  const destination = databasePath(config);
  check(destination);
  const rows = jobs.length > 0 && existsSync(destination) ? snapshotDatabase(destination, check, db => rowsForJobs(db, jobs)) : [];
  const destinationFingerprint = digest(JSON.stringify(rows));
  const existingIds = new Set(rows.map(row => String(row.id)));
  if (existingIds.size > 0) warnings.push(`${existingIds.size} previously imported schedule(s) will keep their current Rookery settings.`);
  const assetHashes = assets.map(asset => [asset.jobId, asset.sourcePath, asset.targetPath, createHash('sha256').update(asset.content).digest('hex'), asset.previous === undefined ? null : createHash('sha256').update(asset.previous).digest('hex')]);
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
