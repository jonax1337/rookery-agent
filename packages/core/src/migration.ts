import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RookeryConfig } from './types.js';
import { databasePath } from './config.js';
import { Store } from './memory/store.js';
import { cronDestinationFingerprint, inspectMigrationCron, insertMigrationCron, type MigrationCronPlan, type MigrationJob } from './migration-cron.js';
import { MAX_FILE_BYTES, MAX_TOTAL_BYTES, contains, isStrictlyInside } from './migration-shared.js';

export type MigrationSource = 'hermes' | 'openclaw';
export interface MigrationFile {
  sourcePath: string;
  targetPath: string;
  bytes: number;
  conflict: boolean;
}
export interface MigrationPreview {
  source: MigrationSource;
  sourcePath: string;
  fingerprint: string;
  files: MigrationFile[];
  jobs: MigrationJob[];
  warnings: string[];
  canImport: boolean;
}
export interface MigrationResult { files: string[]; jobs: string[]; backupPath?: string; warnings: string[] }
export interface MigrationSelection { files: string[]; jobs: string[] }

const MAX_FILES = 1000;
const MAX_MEMORY_DEPTH = 32;
const MAX_MEMORY_ENTRIES = 5000;
const ACTIVE_FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'MEMORY.md'];
/** Hermes keeps these two under `memories/`; the root copy is only a fallback. */
const HERMES_MEMORY_FILES = ['USER.md', 'MEMORY.md'];
const INACTIVE_FILES = ['HEARTBEAT.md', 'BOOT.md', 'BOOTSTRAP.md'];
const ARCHIVE_PREFIX = 'migration-archive/';
const PRIVATE_FILE_MODE = 0o600;
type PlannedFile = MigrationFile & { content: Buffer; previous?: Buffer };
type ChangedFile = PlannedFile & { targetRoot: string };

function sourceDirectory(source: MigrationSource, sourcePath?: string): string {
  if (source !== 'hermes' && source !== 'openclaw') throw new Error('Choose Hermes or OpenClaw as the migration source.');
  if (sourcePath?.trim()) return resolve(sourcePath);
  if (source === 'hermes') return resolve(process.env.HERMES_HOME || join(homedir(), '.hermes'));
  if (process.env.OPENCLAW_WORKSPACE_DIR) return resolve(process.env.OPENCLAW_WORKSPACE_DIR);
  if (process.env.OPENCLAW_PROFILE) throw new Error('An OpenClaw profile is active. Select its workspace directory explicitly.');
  return resolve(process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'), 'workspace');
}

/** Check each existing ancestor as well: a normal file inside a linked directory is still unsafe. */
function assertNoLinks(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Symbolic links are not supported for migration: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function checkedPath(root: string, path: string): string {
  const full = resolve(root, path);
  if (!isStrictlyInside(root, full)) throw new Error(`Unsafe migration path: ${path}`);
  assertNoLinks(full);
  return full;
}

function readMarkdown(path: string): Buffer {
  assertNoLinks(path);
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`Migration file exceeds the 1 MiB limit: ${path}`);
  const content = readFileSync(path);
  if (content.length > MAX_FILE_BYTES) throw new Error(`Migration file exceeds the 1 MiB limit: ${path}`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(content); }
  catch { throw new Error(`Migration file is not valid UTF-8: ${path}`); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw new Error(`Migration file contains binary data: ${path}`);
  return content;
}

/** Collects validated Markdown files and enforces the file-count and byte budgets as it goes. */
class FilePlanner {
  readonly files: PlannedFile[] = [];
  readonly #root: string;
  readonly #workspace: string;
  #total = 0;
  #previousTotal = 0;

  constructor(root: string, workspace: string) {
    this.#root = root;
    this.#workspace = workspace;
  }

  /** Silently ignores sources that do not exist. */
  add(sourcePath: string, targetPath = sourcePath): void {
    const path = checkedPath(this.#root, sourcePath);
    if (!existsSync(path)) return;
    const target = checkedPath(this.#workspace, targetPath);
    const content = readMarkdown(path);
    const previous = existsSync(target) ? readMarkdown(target) : undefined;
    this.#total += content.length;
    this.#previousTotal += previous?.length ?? 0;
    if (this.files.length >= MAX_FILES) throw new Error(`Migration exceeds the ${MAX_FILES} file limit.`);
    if (this.#total > MAX_TOTAL_BYTES) throw new Error('Migration exceeds the 16 MiB total limit.');
    if (this.#previousTotal > MAX_TOTAL_BYTES) throw new Error('Existing destination files exceed the 16 MiB backup limit.');
    this.files.push({ sourcePath, targetPath, bytes: content.length, conflict: previous !== undefined && !content.equals(previous), content, previous });
  }
}

function addIdentityFiles(planner: FilePlanner, source: MigrationSource, root: string): void {
  for (const file of ACTIVE_FILES) {
    if (source === 'hermes' && HERMES_MEMORY_FILES.includes(file)) {
      const nativePath = `memories/${file}`;
      planner.add(existsSync(checkedPath(root, nativePath)) ? nativePath : file, file);
    } else planner.add(file);
  }
}

function addOpenClawMemoryNotes(planner: FilePlanner, root: string): void {
  let entries = 0;
  function walk(path: string, depth: number): void {
    const full = checkedPath(root, path);
    if (!existsSync(full)) return;
    if (!lstatSync(full).isDirectory()) throw new Error(`Expected a memory directory: ${full}`);
    if (depth > MAX_MEMORY_DEPTH) throw new Error(`Memory folders exceed the maximum depth of ${MAX_MEMORY_DEPTH}.`);
    for (const entry of readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_MEMORY_ENTRIES) throw new Error(`Memory folders exceed the ${MAX_MEMORY_ENTRIES} entry limit.`);
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not supported for migration: ${child}`);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (entry.name.toLowerCase().endsWith('.md')) planner.add(child);
    }
  }
  walk('memory', 0);
}

/** Binds the preview to the exact source, destination and cron plan, so import can detect any change. */
function planFingerprint(source: MigrationSource, root: string, workspace: string, files: PlannedFile[], cron: MigrationCronPlan): string {
  const hash = createHash('sha256').update(JSON.stringify({ source, root, workspace }));
  for (const file of files) {
    hash.update(JSON.stringify([file.sourcePath, file.targetPath, file.bytes]));
    hash.update(createHash('sha256').update(file.content).digest());
    hash.update(file.previous === undefined ? 'missing' : createHash('sha256').update(file.previous).digest('hex'));
  }
  hash.update(cron.fingerprint);
  return hash.digest('hex');
}

function inspect(config: RookeryConfig, source: MigrationSource, sourcePath?: string) {
  const root = sourceDirectory(source, sourcePath);
  const workspace = resolve(config.workspace);
  assertNoLinks(root);
  assertNoLinks(workspace);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new Error(`Migration source directory does not exist: ${root}`);
  if (contains(root, workspace) || contains(workspace, root)) throw new Error('Migration source and Rookery workspace must not overlap.');
  const warnings = ['Provider credentials, configuration, tools, skills and conversation history are not imported.'];
  const planner = new FilePlanner(root, workspace);
  addIdentityFiles(planner, source, root);
  for (const file of INACTIVE_FILES) planner.add(file, `${ARCHIVE_PREFIX}${source}/${file}.txt`);
  if (planner.files.some(file => file.targetPath.startsWith(ARCHIVE_PREFIX))) {
    warnings.push('Heartbeat and startup instructions are archived as inactive text; review them before recreating any automation.');
  }
  if (source === 'openclaw') addOpenClawMemoryNotes(planner, root);
  const files = planner.files.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  const cron = inspectMigrationCron(config, source, root, assertNoLinks);
  warnings.push(...cron.warnings);
  if (files.length === 0 && cron.jobs.length === 0) warnings.push('No supported identity, memory Markdown files or recurring schedules were found in this directory.');
  const preview: MigrationPreview = {
    source, sourcePath: root, fingerprint: planFingerprint(source, root, workspace, files, cron),
    files: files.map(({ sourcePath, targetPath, bytes, conflict }) => ({ sourcePath, targetPath, bytes, conflict })),
    jobs: cron.jobs.map(({ id: _id, ...job }) => job),
    warnings, canImport: files.length > 0 || cron.jobs.length > 0,
  };
  return { preview, files, workspace, cron };
}

/** Read-only review of the supported Markdown files. Invalid inputs never produce a partial import plan. */
export function previewMigration(config: RookeryConfig, source: MigrationSource, sourcePath?: string): MigrationPreview {
  try { return inspect(config, source, sourcePath).preview; }
  catch (error) {
    return { source, sourcePath: sourcePath || '', fingerprint: '', files: [], jobs: [], warnings: [(error as Error).message], canImport: false };
  }
}

function replaceFile(workspace: string, path: string, content: Buffer): void {
  const target = checkedPath(workspace, path);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = mkdtempSync(join(dirname(target), '.rookery-migration-'));
  try {
    writeFileSync(join(temporary, 'content'), content, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    checkedPath(workspace, path);
    renameSync(join(temporary, 'content'), target);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function assertValidSelection(selection: MigrationSelection, files: PlannedFile[], jobs: MigrationCronPlan['jobs']): void {
  if (!Array.isArray(selection.files) || !Array.isArray(selection.jobs)) throw new Error('Select files and schedules using lists.');
  if (!selection.files.length && !selection.jobs.length) throw new Error('Select at least one file or schedule to import.');
  if (selection.files.some(name => !files.some(file => file.targetPath === name)) || selection.jobs.some(id => !jobs.some(job => job.sourceId === id))) throw new Error('The selection contains an unknown file or schedule. Review a fresh preview.');
  if (new Set(selection.files).size !== selection.files.length || new Set(selection.jobs).size !== selection.jobs.length) throw new Error('Duplicate migration selection.');
}

/** Every file and script asset whose content would actually change at its destination. */
function changedTargets(files: PlannedFile[], workspace: string, cron: MigrationCronPlan, pendingJobs: MigrationCronPlan['jobs'], home: string): ChangedFile[] {
  const assets = cron.assets.filter(asset => pendingJobs.some(job => job.id === asset.jobId));
  return [
    ...files.map(file => ({ ...file, targetRoot: workspace })),
    ...assets.map(asset => ({ ...asset, conflict: asset.previous !== undefined && !asset.content.equals(asset.previous), targetRoot: home })),
  ].filter(file => file.previous === undefined || !file.content.equals(file.previous));
}

/** Keep a manifest even when every target is new, so the complete import can be identified later. */
function prepareBackup(config: RookeryConfig, preview: MigrationPreview, workspace: string, changed: ChangedFile[], pendingJobs: MigrationCronPlan['jobs']) {
  const backupRoot = resolve(config.home, 'migration-backups');
  if (contains(preview.sourcePath, backupRoot) || contains(backupRoot, preview.sourcePath)) throw new Error('Migration backup directory must not overlap the source.');
  assertNoLinks(backupRoot);
  mkdirSync(backupRoot, { recursive: true });
  const backupPath = mkdtempSync(join(backupRoot, `${preview.source}-`));
  for (const file of changed) {
    if (file.previous === undefined) continue;
    const target = checkedPath(backupPath, file.targetPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.previous, { flag: 'wx', mode: PRIVATE_FILE_MODE });
  }
  const manifestPath = join(backupPath, 'manifest.json');
  const manifest = {
    source: preview.source, sourcePath: preview.sourcePath, workspace, createdAt: new Date().toISOString(), fingerprint: preview.fingerprint,
    files: changed.map(file => ({ sourcePath: file.sourcePath, targetRoot: file.targetRoot, targetPath: file.targetPath, backedUp: file.previous !== undefined })),
    jobs: pendingJobs.map(({ id, sourceId, name }) => ({ id, sourceId, name })),
  };
  const manifestText = (status: string) => JSON.stringify({ ...manifest, status }, null, 2);
  writeFileSync(manifestPath, manifestText('prepared'), { flag: 'wx', mode: PRIVATE_FILE_MODE });
  return { backupPath, manifestPath, manifestText };
}

/** Undo written files in reverse order; returns the targets that could not be restored. */
function restoreWrittenFiles(written: ChangedFile[]): string[] {
  const failures: string[] = [];
  for (const file of [...written].reverse()) {
    try {
      if (file.previous === undefined) rmSync(checkedPath(file.targetRoot, file.targetPath));
      else replaceFile(file.targetRoot, file.targetPath, file.previous);
    } catch { failures.push(file.targetPath); }
  }
  return failures;
}

/** Import only a fully validated plan, retaining originals and restoring the workspace if a write fails. */
export function importMigration(config: RookeryConfig, source: MigrationSource, sourcePath?: string, expectedFingerprint?: string, selection?: MigrationSelection): MigrationResult {
  const { preview, files: availableFiles, workspace, cron: availableCron } = inspect(config, source, sourcePath);
  if (!preview.canImport) throw new Error(preview.warnings.at(-1));
  if (expectedFingerprint !== undefined && preview.fingerprint !== expectedFingerprint) {
    throw new Error('Migration files changed since the preview. Review a fresh preview before importing.');
  }
  if (selection !== undefined) assertValidSelection(selection, availableFiles, availableCron.jobs);
  const files = selection ? availableFiles.filter(file => selection.files.includes(file.targetPath)) : availableFiles;
  const cron = { ...availableCron, jobs: selection ? availableCron.jobs.filter(job => selection.jobs.includes(job.sourceId)) : availableCron.jobs };
  const pendingJobs = cron.jobs.filter(job => !cron.existingIds.has(job.id));
  const changed = changedTargets(files, workspace, cron, pendingJobs, resolve(config.home));
  if (changed.length === 0 && pendingJobs.length === 0) return { files: [], jobs: [], warnings: [...preview.warnings, 'These files and schedules are already imported; nothing changed.'] };
  const { backupPath, manifestPath, manifestText } = prepareBackup(config, preview, workspace, changed, pendingJobs);
  const written: ChangedFile[] = [];
  let store: Store | undefined;
  let transaction = false;
  let importedJobs: string[] = [];
  try {
    if (inspect(config, source, sourcePath).preview.fingerprint !== preview.fingerprint) throw new Error('Migration files changed while preparing backups. Review a fresh preview.');
    if (pendingJobs.length > 0) {
      assertNoLinks(databasePath(config));
      store = new Store(databasePath(config));
      store.db.exec('BEGIN IMMEDIATE');
      transaction = true;
      if (cronDestinationFingerprint(store, availableCron) !== availableCron.destinationFingerprint) throw new Error('Destination schedules changed since the preview. Review a fresh preview.');
    }
    for (const file of changed) {
      replaceFile(file.targetRoot, file.targetPath, file.content);
      written.push(file);
    }
    if (store) importedJobs = insertMigrationCron(store, config, cron);
    writeFileSync(manifestPath, manifestText('complete'));
    if (store) { store.db.exec('COMMIT'); transaction = false; }
  } catch (error) {
    const failures: string[] = [];
    if (transaction) {
      try { store?.db.exec('ROLLBACK'); }
      catch { failures.push('schedule database transaction'); }
    }
    failures.push(...restoreWrittenFiles(written));
    try { writeFileSync(manifestPath, manifestText(failures.length ? 'rollback-incomplete' : 'rolled-back')); }
    catch { failures.push('backup manifest status'); }
    if (failures.length > 0) throw new Error(`Migration failed: ${(error as Error).message}. Restore these files from ${backupPath}: ${failures.join(', ')}`);
    throw new Error(`Migration failed and workspace files were restored: ${(error as Error).message}. Backup: ${backupPath}`);
  } finally { store?.close(); }
  return { files: changed.map(file => file.targetPath), jobs: importedJobs, backupPath, warnings: preview.warnings };
}
