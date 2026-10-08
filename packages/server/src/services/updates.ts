import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { databasePath, tuiSessions, type Assistant, type Logger, type RookeryConfig } from '@rookery/core';
import type { TurnHub } from './turns.js';

/**
 * Updating from the npm registry.
 *
 * The server only decides: it asks the registry what the channel's newest
 * version is, tells the page, and - when asked, or on its own in `auto` mode
 * while nothing is running - hands the swap to `scripts/updater.mjs` and exits.
 * The swap itself cannot happen in here; see the updater's header for why.
 */

export const PACKAGE_NAME = 'rookery-agent';
const REGISTRY = (process.env.ROOKERY_NPM_REGISTRY || 'https://registry.npmjs.org').replace(/\/+$/, '');
const RELEASES_URL = 'https://github.com/jonax1337/rookery-agent/releases/tag';
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const REGISTRY_TIMEOUT_MS = 15_000;
/** How often `auto` looks again whether the work that held an update back is done. */
const IDLE_RETRY_MS = 5 * 60 * 1000;
/** Long enough for the HTTP answer to leave before the server shuts down; the updater waits for our PID. */
const SHUTDOWN_DELAY_MS = 750;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;
const VERSION_CORE_PARTS = 3;

/** The updater's files under `<home>/run`; `scripts/updater.mjs` reads and writes the same names. */
const RUN_DIR = 'run';
const UPDATER_COPY = 'updater.mjs';
const PLAN_FILE = 'update-plan.json';
const STATUS_FILE = 'update-status.json';

/**
 * Order two versions the semver way: numbers numerically, a pre-release
 * before its release, pre-release identifiers numerically where both are
 * numbers. Enough for what npm hands out; build metadata never gets here.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < VERSION_CORE_PARTS; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return comparePreRelease(left.preRelease, right.preRelease);
}

function parseVersion(value: string): { numbers: number[]; preRelease: string[] } {
  const dash = value.indexOf('-');
  const core = dash < 0 ? value : value.slice(0, dash);
  const preRelease = dash < 0 ? '' : value.slice(dash + 1);
  return { numbers: core.split('.').map(Number), preRelease: preRelease ? preRelease.split('.') : [] };
}

/** A release outranks every pre-release of it; two pre-releases compare identifier by identifier. */
function comparePreRelease(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    // The shorter list is the lower version when everything before it ties.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order) return order;
  }
  return 0;
}

/** Numeric identifiers compare as numbers and rank below alphanumeric ones. */
function compareIdentifiers(x: string, y: string): number {
  const xNumeric = NUMERIC_IDENTIFIER.test(x);
  const yNumeric = NUMERIC_IDENTIFIER.test(y);
  if (xNumeric && yNumeric) return Math.sign(Number(x) - Number(y));
  if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

export type InstallKind =
  | { kind: 'npm'; root: string; prefix: string }
  | { kind: 'source' | 'unknown'; root: string; reason: string };

/**
 * Where this server was installed from, judged by where its files are: a
 * global npm install lives in `<prefix>/node_modules/rookery-agent` on
 * Windows and `<prefix>/lib/node_modules/rookery-agent` elsewhere. A checkout
 * has its sources next to the build and is updated with git, never by npm.
 */
export function detectInstall(root: string, platform: NodeJS.Platform = process.platform): InstallKind {
  if (existsSync(join(root, 'packages', 'server', 'src'))) {
    return { kind: 'source', root, reason: 'Rookery runs from a source checkout. Update it with git pull, npm install and npm run build.' };
  }
  const modules = dirname(root);
  if (basename(root) !== PACKAGE_NAME || basename(modules) !== 'node_modules') {
    return { kind: 'unknown', root, reason: 'Rookery is not installed as a global npm package here, so it cannot replace itself.' };
  }
  const parent = dirname(modules);
  const prefix = platform !== 'win32' && basename(parent) === 'lib' ? dirname(parent) : parent;
  return { kind: 'npm', root, prefix };
}

export interface UpdateResult {
  ok: boolean;
  from: string;
  to: string;
  at: string;
  error?: string;
  rolledBack?: boolean;
}

export interface UpdateStatus {
  current: string;
  latest: string | null;
  available: boolean;
  checkedAt: string | null;
  error: string | null;
  checking: boolean;
  installing: boolean;
  mode: RookeryConfig['updates']['mode'];
  channel: RookeryConfig['updates']['channel'];
  /** Whether this installation can replace itself, and if not, why. */
  installable: boolean;
  reason: string | null;
  /** What is running right now and would be cut off by an install. */
  busy: string[];
  /** How the last update went, as the updater recorded it. */
  lastResult: UpdateResult | null;
  releaseNotesUrl: string | null;
}

export interface UpdateServiceOptions {
  assistant: Assistant;
  turns: TurnHub;
  log: Logger;
  version: string;
  /** Ends this process cleanly; absent where nothing would restart it (tests, embedding). */
  requestShutdown?: () => void;
  /** Package root; defaults to the one this file was loaded from. */
  root?: string;
  fetch?: typeof fetch;
}

export class UpdateError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type NpmInstall = Extract<InstallKind, { kind: 'npm' }>;

/** `[::]` and `0.0.0.0` listen everywhere but cannot be dialled; the updater health-checks over loopback. */
function healthUrl(host: string, port: number): string {
  const dialable = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  return `http://${dialable.includes(':') ? `[${dialable}]` : dialable}:${port}/api/health`;
}

export class UpdateService {
  readonly #options: UpdateServiceOptions;
  readonly #config: RookeryConfig;
  readonly #install: InstallKind;
  readonly #fetch: typeof fetch;
  #latest: string | null = null;
  #checkedAt: string | null = null;
  #error: string | null = null;
  #checking: Promise<void> | null = null;
  #installing = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(options: UpdateServiceOptions) {
    this.#options = options;
    this.#config = options.assistant.config;
    this.#fetch = options.fetch ?? fetch;
    // dist/services/updates.js -> the package root, in a checkout and in the npm package alike.
    const root = options.root ?? fileURLToPath(new URL('../../../../', import.meta.url)).replace(/[\\/]+$/, '');
    this.#install = detectInstall(root);
  }

  /** Begin the periodic check. `stop` undoes it. */
  start(): void {
    if (this.#timer) return;
    this.#stopped = false;
    const tick = (): void => {
      if (this.#config.updates.mode !== 'off') void this.check();
    };
    this.#timer = setTimeout(() => {
      tick();
      this.#timer = setInterval(tick, CHECK_EVERY_MS);
      this.#timer.unref();
    }, FIRST_CHECK_MS);
    this.#timer.unref();
  }

  /** Cancels the timers; a check still in flight ends without arming a retry or starting an install. */
  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#idleTimer);
    this.#timer = undefined;
    this.#idleTimer = undefined;
  }

  status(): UpdateStatus {
    const current = this.#options.version;
    const available = this.#latest !== null && compareVersions(this.#latest, current) > 0;
    const reason = this.#notInstallableReason();
    return {
      current,
      latest: this.#latest,
      available,
      checkedAt: this.#checkedAt,
      error: this.#error,
      checking: this.#checking !== null,
      installing: this.#installing,
      mode: this.#config.updates.mode,
      channel: this.#config.updates.channel,
      installable: reason === null,
      reason,
      busy: this.busy(),
      lastResult: this.#readLastResult(),
      releaseNotesUrl: available ? `${RELEASES_URL}/v${this.#latest}` : null,
    };
  }

  /** What an install would cut off, in words. Empty means idle. */
  busy(): string[] {
    const reasons: string[] = [];
    const count = (n: number, one: string, many: string): void => {
      if (n > 0) reasons.push(`${n} ${n === 1 ? one : many}`);
    };
    count(this.#options.turns.size, 'conversation is answering', 'conversations are answering');
    count(this.#options.assistant.org.activeCount, 'agent run is active', 'agent runs are active');
    count(this.#options.assistant.cron.runningCount, 'schedule is running', 'schedules are running');
    count(tuiSessions.size, 'terminal is open', 'terminals are open');
    return reasons;
  }

  /** Ask the registry once. Concurrent callers share the request in flight. */
  check(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = null;
    });
    return this.#checking;
  }

  async #check(): Promise<void> {
    try {
      this.#latest = await this.#fetchLatestVersion();
      this.#error = null;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#options.log.warn('Update check failed', { error: this.#error });
    } finally {
      this.#checkedAt = new Date().toISOString();
    }
    this.#maybeAutoInstall();
  }

  async #fetchLatestVersion(): Promise<string> {
    const response = await this.#fetch(`${REGISTRY}/${PACKAGE_NAME}/${this.#config.updates.channel}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`The npm registry answered ${response.status}.`);
    const body = (await response.json()) as { version?: unknown };
    if (typeof body.version !== 'string' || !VERSION.test(body.version)) throw new Error('The npm registry sent no usable version.');
    return body.version;
  }

  /**
   * `auto` installs only when nothing would be cut off, and never retries a
   * version whose install already failed and was rolled back - that would be
   * a restart loop with a database restore in every round of it.
   */
  #maybeAutoInstall(): void {
    if (this.#stopped) return;
    const status = this.status();
    if (status.mode !== 'auto' || !status.available || !status.installable || this.#installing) return;
    if (status.lastResult && !status.lastResult.ok && status.lastResult.to === status.latest) return;
    if (status.busy.length) {
      this.#retryWhenIdle();
      return;
    }
    try {
      this.install({ force: false });
    } catch (error) {
      this.#options.log.warn('Automatic update did not start', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  #retryWhenIdle(): void {
    this.#idleTimer ??= setTimeout(() => {
      this.#idleTimer = undefined;
      this.#maybeAutoInstall();
    }, IDLE_RETRY_MS);
    this.#idleTimer.unref();
  }

  /**
   * Hand the swap to the updater and end this process. Throws an UpdateError
   * meant for a person when it cannot: nothing newer, not installable, or
   * work still running without `force`.
   */
  install({ force }: { force: boolean }): { from: string; to: string } {
    const status = this.status();
    if (this.#installing) throw new UpdateError(409, 'An update is already being installed.');
    if (this.#install.kind !== 'npm' || !status.installable) {
      throw new UpdateError(400, status.reason ?? 'This installation cannot update itself.');
    }
    if (!status.available || !status.latest) throw new UpdateError(409, 'There is no newer version to install.');
    if (status.busy.length && !force) {
      throw new UpdateError(409, `Updating restarts Rookery, and ${status.busy.join(', ')}. Wait for them, or update anyway.`);
    }

    const underSystemd = process.platform === 'linux' && Boolean(process.env.INVOCATION_ID);
    const { updater, planPath } = this.#stageUpdate(this.#install, status.current, status.latest, underSystemd);
    const child = this.#launchUpdater(updater, planPath, underSystemd);

    this.#installing = true;
    this.#options.log.info('Update handed to the updater; shutting down', { from: status.current, to: status.latest, force });
    this.#shutDownUnlessUpdaterFails(child, underSystemd);
    return { from: status.current, to: status.latest };
  }

  /**
   * Under systemd the whole unit is torn down with the server, a detached
   * child included; a transient unit of its own survives that. The arguments
   * go straight to `spawn` without a shell, so nothing in them is interpreted.
   */
  #launchUpdater(updater: string, planPath: string, underSystemd: boolean): ChildProcess {
    const home = this.#config.home;
    const [command, args] = underSystemd
      ? ['systemd-run', ['--user', '--collect', '--quiet', process.execPath, updater, planPath]]
      : [process.execPath, [updater, planPath]];
    const child = spawn(command, args, {
      cwd: home,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ROOKERY_HOME: home },
    });
    child.unref();
    return child;
  }

  /** Copy the updater out of the package that is about to be replaced, and write the plan it reads. */
  #stageUpdate(install: NpmInstall, from: string, to: string, underSystemd: boolean): { updater: string; planPath: string } {
    const home = this.#config.home;
    const run = join(home, RUN_DIR);
    mkdirSync(run, { recursive: true });
    // A copy, because the original is about to be overwritten by npm.
    const updater = join(run, UPDATER_COPY);
    copyFileSync(join(install.root, 'scripts', 'updater.mjs'), updater);

    const plan = {
      packageName: PACKAGE_NAME,
      from,
      to,
      home,
      prefix: install.prefix,
      root: install.root,
      database: databasePath(this.#config),
      restart: underSystemd ? 'systemd' : 'launcher',
      healthUrl: healthUrl(this.#config.host, this.#config.port),
      token: this.#config.token || undefined,
      waitPid: process.pid,
      registry: process.env.ROOKERY_NPM_REGISTRY || undefined,
    };
    const planPath = join(run, PLAN_FILE);
    // The plan carries the API token, so it is readable by this user only.
    writeFileSync(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
    rmSync(join(run, STATUS_FILE), { force: true });
    return { updater, planPath };
  }

  /**
   * The updater itself never ends before we do - it waits for this PID - and
   * systemd-run ends at once, with 0 once the unit is up. Anything else
   * means nobody would bring the server back, so it must stay up.
   */
  #shutDownUnlessUpdaterFails(child: ChildProcess, underSystemd: boolean): void {
    const shutdown = setTimeout(() => this.#options.requestShutdown?.(), SHUTDOWN_DELAY_MS);
    shutdown.unref();
    const abort = (reason: string): void => {
      clearTimeout(shutdown);
      this.#installing = false;
      this.#options.log.error('Updater did not start; staying up', { reason });
    };
    child.once('error', (error) => abort(error.message));
    child.once('exit', (code) => {
      if (!underSystemd || code !== 0) abort(`updater exited early with ${code}`);
    });
  }

  /** Why this installation cannot replace itself, or null when it can. */
  #notInstallableReason(): string | null {
    if (this.#install.kind !== 'npm') return this.#install.reason;
    if (!this.#options.requestShutdown) return 'This server was not started by Rookery itself and cannot restart on its own.';
    return null;
  }

  /**
   * Read on every status, not once at start: the updater writes its verdict
   * only after the server it started has answered, so the server that is
   * running is always younger than the file it would otherwise have missed.
   * A missing or half-written file simply means there is no verdict yet.
   */
  #readLastResult(): UpdateResult | null {
    try {
      return JSON.parse(readFileSync(join(this.#config.home, RUN_DIR, STATUS_FILE), 'utf8')) as UpdateResult;
    } catch {
      return null;
    }
  }
}
