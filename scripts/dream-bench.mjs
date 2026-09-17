#!/usr/bin/env node
/**
 * The dream's size and latency gate (stage 1, AP11).
 *
 * A cost claim without a measurement is not allowed in this project, so this
 * script is the delivery stage 1 hangs on. It builds a synthetic bank of a
 * fixed size, drives the same turns twice - once with the recorder off, once
 * with it on - and reports the five budget numbers of the build plan:
 *
 *   p95 frame size                     <= 120 KB  (dream_frames.bytes)
 *   p95 extra turn latency             <= 25 ms   (difference of the two runs)
 *   extra prepared statements per turn <= 40      (counter around store.db.prepare)
 *   p95 |possibleSeeds|                <= 12      (frame.possibleSeeds.length)
 *   bytes per night at frameRate 0.25  <= 1 MB    (extrapolated from p50)
 *
 * Two before/after reports come with them:
 *
 *   - write attribution on the same corpus (concept 8.7): `touchMemories`
 *     already deletes and rewrites FTS rows on every UPDATE of `memories`
 *     (the `memories_au` trigger), so the recorder must not be blamed for
 *     churn that predates it. Row writes are counted via the
 *     `total_changes()` SQL function, plus one isolated `touchMemories`
 *     measurement.
 *   - the third run replays the same turns under the three profile-score
 *     states of the two declared behaviour changes (build plan 1.3): before
 *     AP2 commit B (the literal score 1), after commit B (the scale without
 *     precedence) and after commit C (precedence, the shipped state). It
 *     reports how often the head of the rendered block changes and by how
 *     many lines the block shifts, so neither change stays hidden.
 *
 * With `--db <path>` it also runs the Phase 0 influx measurement (concept
 * 4.5): how many labelable traces would arise per night, per source. That
 * pass opens the given database READ-ONLY and never migrates it. Everything
 * else never touches a database but its own temp files (mkdtempSync, like
 * packages/core/test/setup.mjs).
 *
 * Usage:
 *   node scripts/dream-bench.mjs [--db <path>] [--memories 2000]
 *     [--entities 400] [--edges 800] [--turns 200] [--turns-per-night 200]
 *     [--seed 20260917] [--keep]
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The budgets of the gate (build plan AP11; concept 8.7). All `geraten`. */
const BUDGETS = {
  frameBytes: 120_000,
  latencyMs: 25,
  preparesPerTurn: 40,
  seeds: 12,
  nightBytes: 1_000_000,
};

/** The clock the synthetic banks are built under, so all runs share one corpus. */
const BUILD_NOW = Date.parse('2026-09-17T12:00:00.000Z');

const USAGE = [
  'Usage: node scripts/dream-bench.mjs [options]',
  '',
  'Options:',
  '  --db <path>            also run the Phase 0 influx pass on this database (read-only)',
  '  --memories <n>         synthetic bank size          (default 2000)',
  '  --entities <n>         entities in the synthetic bank (default 400)',
  '  --edges <n>            graph edges in the bank       (default 800)',
  '  --turns <n>            turns per run                 (default 200)',
  '  --turns-per-night <n>  traffic assumption for the nightly-bytes extrapolation',
  '                         (default 200; with --db, the observed median user messages per night)',
  '  --seed <n>             seed of the deterministic bank (default 20260917)',
  '  --keep                 keep the temp directory for inspection',
  '  -h, --help             show this help',
].join('\n');

function parseArgs(argv) {
  const out = { db: null, memories: 2000, entities: 400, edges: 800, turns: 200, turnsPerNight: 200, seed: 20_260_917, keep: false, help: false };
  const int = (flag) => {
    const value = Number.parseInt(argv[++out._i], 10);
    if (!Number.isFinite(value) || value < 0) throw new Error(flag + ' needs a non-negative number');
    return value;
  };
  out._i = 0;
  for (; out._i < argv.length; out._i += 1) {
    const arg = argv[out._i];
    if (arg === '--db') out.db = argv[++out._i] ?? '';
    else if (arg === '--memories') out.memories = int(arg);
    else if (arg === '--entities') out.entities = int(arg);
    else if (arg === '--edges') out.edges = int(arg);
    else if (arg === '--turns') out.turns = int(arg);
    else if (arg === '--turns-per-night') out.turnsPerNight = int(arg);
    else if (arg === '--seed') out.seed = int(arg);
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error('Unknown option: ' + arg + '\n' + USAGE);
  }
  if (out.db === '') throw new Error('--db needs a path');
  if (out.turns < 1) throw new Error('--turns must be at least 1');
  return out;
}

/* ------------------------------ small helpers ----------------------------- */

/** Deterministic PRNG, so every run drives the same bank and the same turns. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Freeze the clock around a block, so two banks come out bit-identical. */
function withFrozenClock(fixed, run) {
  const realNow = Date.now;
  Date.now = () => fixed;
  try {
    return run();
  } finally {
    Date.now = realNow;
  }
}

/** Nearest-rank percentile over an ascending copy of `values`. */
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

const kb = (bytes) => (bytes / 1024).toFixed(1) + ' KB';
const ms = (value) => value.toFixed(1) + ' ms';

function verdict(ok) {
  return ok ? 'PASS' : 'FAIL - lower dream.frameRate before Phase 2 begins';
}

/* ------------------------------ synthetic bank ---------------------------- */

const TOPICS = [
  'harbor', 'ledger', 'compiler', 'garden', 'lighthouse', 'ferry', 'archive', 'signal',
  'orchard', 'harvest', 'pipeline', 'theorem', 'cache', 'delta', 'beacon', 'meadow',
  'registry', 'tunnel', 'reactor', 'salvage', 'survey', 'throttle', 'verdict', 'waypoint',
  'ballast', 'catalog', 'drift', 'estuary', 'foundry', 'granary', 'hillside', 'isotope',
];

const KINDS = ['fact', 'fact', 'preference', 'project', 'event', 'fact', 'summary', 'preference', 'insight', 'fact'];

const CONTENT_TEMPLATES = [
  (a, b, n) => `The ${a} report no. ${n} covers ${b} work for quarter ${1 + (n % 4)}.`,
  (a, b, n) => `Notes on ${a}: item ${n} still depends on the ${b} checklist.`,
  (a, b, n) => `The ${a} crew agreed to keep ${b} entry ${n} out of the summary.`,
  (a, b, n) => `Record ${n}: ${a} volume rose after the ${b} adjustment landed.`,
  (a, b, n) => `Follow-up ${n} from the ${a} review: verify the ${b} figures first.`,
];

const QUESTION_TEMPLATES = [
  (a, b, n) => `What does the ${a} report say about ${b}, entry ${n}?`,
  (a, b, n) => `Remind me what we decided about ${a} and ${b} in round ${n}.`,
  (a, b, n) => `Where do the ${a} notes connect to the ${b} checklist, item ${n}?`,
  (a, b, n) => `Summarise the open ${a} items that touch ${b}, batch ${n}.`,
];

/**
 * Build the corpus. Deterministic for one seed, and built under a frozen
 * clock, so the recorder-off run, the recorder-on run and the third run all
 * measure the same bank - "vorher und nachher auf demselben Korpus".
 */
function buildBank(store, owner, sizes, rng) {
  const records = [];
  for (let i = 0; i < sizes.memories; i += 1) {
    const a = TOPICS[i % TOPICS.length];
    const b = TOPICS[(i * 7 + 3) % TOPICS.length];
    const kind = KINDS[i % KINDS.length];
    const importance = kind === 'insight' ? 0.75 + rng() * 0.2 : 0.2 + rng() * 0.6;
    records.push(
      store.upsertMemory({
        kind,
        content: CONTENT_TEMPLATES[i % CONTENT_TEMPLATES.length](a, b, i),
        tags: i % 3 === 0 ? [a] : [],
        importance,
        pinned: rng() < 0.06,
        owner,
      }),
    );
  }

  const entities = [];
  for (let e = 0; e < sizes.entities; e += 1) {
    entities.push(store.upsertEntity({ owner, name: TOPICS[e % TOPICS.length] + ' ' + Math.floor(e / TOPICS.length) }));
  }
  for (let e = 0; e < entities.length; e += 1) {
    for (let k = 0; k < 5; k += 1) {
      const index = (e + k * entities.length + Math.floor(e / 8)) % records.length;
      store.linkEntity(records[index].id, entities[e].id);
    }
  }

  let written = 0;
  for (let i = 0; written < sizes.edges; i += 1) {
    const src = records[i % records.length];
    const dst = records[(i * 13 + 7) % records.length];
    const relation = written % 12 === 11 ? 'contradicts' : written % 2 === 0 ? 'refines' : 'caused_by';
    if (src.id === dst.id) continue;
    if (store.addEdge({ owner, srcId: src.id, dstId: dst.id, relation, weight: 0.3 + (written % 7) * 0.1 })) written += 1;
  }
  return records;
}

function turnTexts(count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const a = TOPICS[(i * 3) % TOPICS.length];
    const b = TOPICS[(i * 5 + 1) % TOPICS.length];
    out.push(QUESTION_TEMPLATES[i % QUESTION_TEMPLATES.length](a, b, i));
  }
  return out;
}

/* ----------------------------- instrumentation ---------------------------- */

/**
 * Count what a turn costs the store: prepared statements (a proxy for the
 * read budget; SQLite prepares per call here, nothing is cached) and row
 * writes via the `total_changes()` SQL function, which the FTS trigger churn
 * shows up in. The probes themselves go through the bound original, so they
 * never count.
 */
function instrument(store) {
  const db = store.db;
  const original = db.prepare.bind(db);
  let prepares = 0;
  db.prepare = (...sql) => {
    prepares += 1;
    return original(...sql);
  };
  return {
    snapshot: () => prepares,
    totalChanges: () => Number(original('SELECT total_changes() AS n').get().n ?? 0),
  };
}

/** A provider that answers plain text; extraction never runs (autoExtract off). */
function createFakeProvider() {
  return {
    id: 'claude',
    displayName: 'Fake Claude',
    models: () => ['fake'],
    async status() {
      return { id: 'claude', available: true, binary: 'fake', authenticated: true };
    },
    async *run(opts) {
      if ((opts.prompt ?? '').includes('EXCHANGE\n')) {
        yield { type: 'done', text: '[]' };
        return;
      }
      yield { type: 'text', delta: 'Noted.' };
      yield { type: 'done', text: 'Noted.' };
    },
  };
}

/**
 * Drive one full conversational turn (prompt build, recall, provider run,
 * persistence) and collect the session id it ran in.
 */
async function runTurn(assistant, text, sessionId) {
  let used = sessionId;
  for await (const event of assistant.chat(sessionId ? { text, sessionId } : { text })) {
    if (event.type === 'error' && event.fatal) throw new Error(event.message);
    if (event.type === 'session' && !used) used = event.sessionId;
  }
  return used;
}

/**
 * One measured run: its own store (own temp file), the bank built from the
 * shared seed, its own assistant, warmup turns excluded from the metrics.
 */
async function driveRun(ctx, options) {
  const { label, dir, dream, sizes, seed, texts, warmup } = options;
  const home = join(dir, label);
  mkdirSync(join(home, 'run'), { recursive: true });
  const store = new ctx.Store(join(dir, label + '.db'));
  const owner = ctx.ASSISTANT_MEMORY_OWNER;
  const records = withFrozenClock(BUILD_NOW, () => buildBank(store, owner, sizes, mulberry32(seed)));
  const assistant = new ctx.Assistant({
    store,
    registry: new ctx.ProviderRegistry([createFakeProvider()]),
    config: {
      home,
      logLevel: 'silent',
      memory: { enabled: true, autoExtract: false, ...(dream ? { dream } : {}) },
      org: { autoReview: false },
    },
  });
  const meter = instrument(store);
  const perTurn = [];

  const one = async (text, sessionId, measure) => {
    const preparesBefore = meter.snapshot();
    const writesBefore = meter.totalChanges();
    const started = performance.now();
    const used = await runTurn(assistant, text, sessionId);
    if (measure) {
      perTurn.push({
        ms: performance.now() - started,
        prepares: meter.snapshot() - preparesBefore,
        writes: meter.totalChanges() - writesBefore,
      });
    }
    return used;
  };

  let warmSession;
  for (let i = 0; i < warmup; i += 1) {
    warmSession = await one('Warmup question number ' + (i + 1) + ' about ' + TOPICS[i % TOPICS.length] + '.', warmSession, false);
  }
  const perSession = Math.max(1, Math.ceil(texts.length / 20));
  let sessionId;
  for (let i = 0; i < texts.length; i += 1) {
    if (i % perSession === 0) sessionId = undefined;
    sessionId = await one(texts[i], sessionId, true);
  }
  return { label, store, assistant, perTurn, records };
}

/** Frame sizes and seed-list lengths of the recorder-on run, from the rows it wrote. */
function frameStats(store) {
  const rows = store.db.prepare('SELECT bytes, payload FROM dream_frames').all();
  const traces = store.db.prepare('SELECT COUNT(*) AS n FROM dream_traces').get().n;
  const bytes = rows.map((row) => Number(row.bytes));
  const seeds = rows.map((row) => {
    try {
      return (JSON.parse(row.payload).possibleSeeds ?? []).length;
    } catch {
      return 0;
    }
  });
  return { frames: rows.length, traces, bytes, seeds };
}

/* --------------------- third run: the behaviour changes ------------------- */

/** The profile score under one of the three states of build plan 1.3. */
function profileScore(state, record, now, ctx) {
  if (state.lead === null) return 1; // before commit B: the literal
  return (
    state.lead +
    (record.pinned ? 1 : 0) +
    (record.kind === 'insight' ? 0.5 : 0) +
    ctx.WEIGHTS.importance * record.importance +
    ctx.WEIGHTS.recency * ctx.recencyOf(record.updatedAt, now)
  );
}

/**
 * The turn's merged block under one state: the live merge of runtime.ts,
 * piece for piece - profile into the map, the ranking overwriting, the
 * contradiction drop, the total order, the grouped renderer. Only the
 * profile scores differ between states; the ranking and profile rows are
 * computed once per turn, so the comparison isolates exactly the change.
 */
function blockForState(ctx, store, matched, profile, state, now, budgetChars) {
  const byId = new Map();
  for (const row of profile) {
    byId.set(row.id, { ...row, score: profileScore(state, row, now, ctx) });
  }
  for (const memory of matched) byId.set(memory.id, memory);
  const kept = ctx.dropContradicted(store, [...byId.values()]);
  const sorted = [...kept].sort(ctx.byScoreThenId);
  return {
    block: ctx.renderMemoryBlock(sorted, budgetChars, 'this user', store),
    profileIds: new Set(profile.map((row) => row.id)),
  };
}

const MEMORY_LINE = /^(?:  )?- \((\w+)\) (.+)$/;

/** The body lines of a rendered block, without its fixed header and footer. */
function blockBody(block) {
  if (!block) return [];
  const lines = block.split('\n');
  return lines.slice(1, lines.length - 1);
}

/** The id of the first memory line of a block: the head the model reads. */
function headId(body, contentToId) {
  for (const line of body) {
    const match = MEMORY_LINE.exec(line);
    if (match) {
      const id = contentToId.get(match[2]);
      if (id) return id;
    }
  }
  return undefined;
}

/** How many lines moved between two blocks: positional differences plus length. */
function lineShift(a, b) {
  let shifted = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) shifted += 1;
  return shifted;
}

/**
 * Replay every turn under the three profile-score states and report, per
 * transition, how many block heads changed (a profile row in front of a
 * direct hit instead of behind it) and by how many lines the block shifted.
 *
 * The turn pieces run against the live store with `touch: false`, exactly as
 * the runtime merge does them, so a frame that sits at the seeds cap cannot
 * block the comparison: this run measures the merge, not the replay. The
 * pre-commit-B state is simulated with today's deterministic profile order;
 * the historical order at ties was undefined - that was the bug AP2 fixed,
 * and it is the honest limit of measuring it after the fact.
 */
function behaviourChangeRun(ctx, dir, sizes, seed, texts) {
  const owner = ctx.ASSISTANT_MEMORY_OWNER;
  const store = new ctx.Store(join(dir, 'behaviour.db'));
  const records = withFrozenClock(BUILD_NOW, () => buildBank(store, owner, sizes, mulberry32(seed)));
  const contentToId = new Map(records.map((record) => [record.content, record.id]));
  const policy = ctx.resolvePolicy(store, ctx.DEFAULT_CONFIG, owner, 'recall');
  const promptProfileLimit = Math.max(3, Math.floor(policy.limit / 2));
  const wideProfileLimit = Math.max(
    promptProfileLimit,
    Math.max(3, Math.floor(Math.max(ctx.DEFAULT_CONFIG.memory.dream.limitMax, policy.limit) / 2)),
  );
  const budgetChars = Math.floor(ctx.DEFAULT_CONFIG.memory.contextBudget * 0.4);

  const states = [
    { key: 'pre-B', lead: null, label: 'before commit B: the literal profile score 1' },
    { key: 'post-B', lead: 1, label: 'after commit B: the scale, without precedence' },
    { key: 'post-C', lead: ctx.PROFILE_LEAD, label: 'after commit C: precedence (the shipped state)' },
  ];
  const report = {
    turns: 0,
    pairs: [0, 1].map(() => ({ blockChanged: 0, headChanged: 0, headFlippedToProfile: 0, headFlippedToDirect: 0, linesShifted: 0 })),
  };

  for (const text of texts) {
    const matched = ctx.recall(store, {
      text,
      owner,
      limit: policy.limit,
      threshold: policy.threshold,
      hopEntity: policy.hopEntity,
      hopEdge: policy.hopEdge,
      touch: false,
    });
    // One wide profile read, sliced for the prompt - the traced turn's own
    // shape (R12); the rows are fixed across states, only the score varies.
    const profile = ctx.coreProfile(store, { owner, limit: wideProfileLimit }).slice(0, promptProfileLimit);
    const now = Date.now();
    report.turns += 1;
    const rendered = states.map((state) => blockForState(ctx, store, matched, profile, state, now, budgetChars));
    const bodies = rendered.map((entry) => blockBody(entry.block));
    [0, 1].forEach((index) => {
      const headA = headId(bodies[index], contentToId);
      const headB = headId(bodies[index + 1], contentToId);
      const tally = report.pairs[index];
      if (rendered[index].block !== rendered[index + 1].block) tally.blockChanged += 1;
      if (headA !== headB) tally.headChanged += 1;
      if (headA !== undefined && headB !== undefined && headA !== headB) {
        if (rendered[index + 1].profileIds.has(headB) && !rendered[index].profileIds.has(headA)) tally.headFlippedToProfile += 1;
        if (!rendered[index + 1].profileIds.has(headB) && rendered[index].profileIds.has(headA)) tally.headFlippedToDirect += 1;
      }
      tally.linesShifted += lineShift(bodies[index], bodies[index + 1]);
    });
  }
  store.close();
  return { states, report };
}

/* -------------------------- Phase 0: label influx ------------------------- */

/** Per-night counts of one source, read from a read-only connection. */
function nightsOf(db, sql) {
  const byNight = new Map();
  for (const row of db.prepare(sql).all()) byNight.set(Number(row.night), Number(row.n));
  return byNight;
}

function summariseNights(byNight) {
  const values = [...byNight.values()];
  if (!values.length) return { nights: 0, total: 0, median: 0, max: 0 };
  return {
    nights: values.length,
    total: values.reduce((a, b) => a + b, 0),
    median: percentile(values, 0.5),
    max: Math.max(...values),
  };
}

/**
 * The Phase 0 pass (concept 4.5): how many labelable traces would arise per
 * night, per source, as a pure query over the stock. Opened READ-ONLY, never
 * migrated. The `user` source is reported as not derivable rather than
 * guessed: the store takes no actor, so nothing in the stock separates a
 * user edit from a model edit - Phase 2 adds the actor, and until then any
 * number here would be invented.
 */
function phaseZero(dbPath) {
  const result = { path: dbPath, sources: {}, error: null };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    result.error = 'cannot open read-only: ' + (error instanceof Error ? error.message : String(error));
    return result;
  }
  const sources = [
    {
      key: 'corrections',
      label: 'corrections per night (source: correction)',
      sql: 'SELECT created_at / 86400000 AS night, COUNT(*) AS n FROM corrections GROUP BY night',
      note: 'the only source that can label a memory that was NOT delivered',
    },
    {
      key: 'reviews',
      label: 'upsertReview rows per night (source: review)',
      sql: 'SELECT created_at / 86400000 AS night, COUNT(*) AS n FROM agent_reviews GROUP BY night',
      note: 'assignment-level signal, never a gain; sentinel target in Phase 2',
    },
    {
      key: 'superseded',
      label: 'superseded_by jumps per night (source: merge)',
      sql: 'SELECT updated_at / 86400000 AS night, COUNT(*) AS n FROM memories WHERE superseded_by IS NOT NULL GROUP BY night',
      note: 'upper bound: attributed to updated_at, the closest timestamp the stock has',
    },
    {
      key: 'userTurns',
      label: 'user messages per night (the turns labels attach to)',
      sql: "SELECT created_at / 86400000 AS night, COUNT(*) AS n FROM messages WHERE role = 'user' GROUP BY night",
      note: 'the attach points, not labels themselves',
    },
  ];
  for (const source of sources) {
    try {
      result.sources[source.key] = { label: source.label, note: source.note, ...summariseNights(nightsOf(db, source.sql)) };
    } catch (error) {
      result.sources[source.key] = { label: source.label, note: source.note, error: error instanceof Error ? error.message : String(error) };
    }
  }
  result.sources.userEdits = {
    label: 'user edits on /api/memories per night (source: user)',
    note: 'not derivable from the stock: the store records no actor, so user and model edits are indistinguishable. Phase 2 adds the actor parameter; until then this source has no number, which is itself the Phase 0 finding.',
  };
  db.close();
  return result;
}

/* ---------------------------------- main ---------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const distIndex = join(root, 'packages', 'core', 'dist', 'index.js');
  if (!existsSync(distIndex)) {
    console.error('The core package is not built yet. Run: npm run build:core');
    process.exitCode = 1;
    return;
  }
  const core = await import('../packages/core/dist/index.js');
  const recallModule = await import('../packages/core/dist/memory/recall.js');
  const ctx = {
    Assistant: core.Assistant,
    ProviderRegistry: core.ProviderRegistry,
    Store: core.Store,
    ASSISTANT_MEMORY_OWNER: core.ASSISTANT_MEMORY_OWNER,
    DEFAULT_CONFIG: core.DEFAULT_CONFIG,
    recall: core.recall,
    coreProfile: core.coreProfile,
    dropContradicted: core.dropContradicted,
    renderMemoryBlock: core.renderMemoryBlock,
    resolvePolicy: core.resolvePolicy,
    WEIGHTS: recallModule.WEIGHTS,
    PROFILE_LEAD: recallModule.PROFILE_LEAD,
    byScoreThenId: recallModule.byScoreThenId,
    recencyOf: recallModule.recencyOf,
  };

  const dir = mkdtempSync(join(tmpdir(), 'rookery-dream-bench-'));
  const lines = [];
  const say = (text) => lines.push(text);
  const dreamOn = { enabled: true, record: true, frameRate: 1 };
  let runError = null;

  try {
    const sizes = { memories: args.memories, entities: args.entities, edges: args.edges };
    const texts = turnTexts(args.turns);
    say('Rookery dream bench (stage 1, AP11)');
    say('  bank: ' + args.memories + ' memories, ' + args.entities + ' entities, ' + args.edges + ' edges, seed ' + args.seed);
    say('  turns: ' + args.turns + ' (plus 5 warmup per run, excluded), synthetic files under ' + dir);
    say('');

    const off = await driveRun(ctx, { label: 'off', dir, dream: null, sizes, seed: args.seed, texts, warmup: 5 });
    const on = await driveRun(ctx, { label: 'on', dir, dream: dreamOn, sizes, seed: args.seed, texts, warmup: 5 });

    const stats = frameStats(on.store);
    const latencyDiffs = on.perTurn.map((turn, index) => turn.ms - off.perTurn[index].ms);
    const prepareDiffs = on.perTurn.map((turn, index) => turn.prepares - off.perTurn[index].prepares);
    const writeDiffs = on.perTurn.map((turn, index) => turn.writes - off.perTurn[index].writes);

    const p95FrameBytes = percentile(stats.bytes, 0.95);
    const p50FrameBytes = percentile(stats.bytes, 0.5);
    const p95Latency = percentile(latencyDiffs, 0.95);
    const p50Latency = percentile(latencyDiffs, 0.5);
    const maxPrepares = Math.max(...prepareDiffs, 0);
    const p95Seeds = percentile(stats.seeds, 0.95);

    let turnsPerNight = args.turnsPerNight;
    let turnsSource = 'assumed (--turns-per-night)';
    let influx = null;
    if (args.db) {
      influx = phaseZero(args.db);
      const observed = influx.sources.userTurns && !influx.sources.userTurns.error ? influx.sources.userTurns.median : null;
      if (observed && observed > 0) {
        turnsPerNight = Math.max(1, Math.round(observed));
        turnsSource = 'observed median user messages per night from --db';
      }
    }
    const frameRate = ctx.DEFAULT_CONFIG.memory.dream.frameRate;
    const nightBytes = p50FrameBytes * turnsPerNight * frameRate;

    say('Budget gate (budget, measured, verdict)');
    say('  p95 frame size                <= ' + kb(BUDGETS.frameBytes) + '   -> ' + kb(p95FrameBytes) + '   ' + verdict(p95FrameBytes <= BUDGETS.frameBytes));
    say('  p95 extra turn latency        <= ' + ms(BUDGETS.latencyMs) + '  -> ' + ms(p95Latency) + '  (p50 ' + ms(p50Latency) + ')  ' + verdict(p95Latency <= BUDGETS.latencyMs));
    say('  extra prepared stmts per turn <= ' + BUDGETS.preparesPerTurn + '      -> max ' + maxPrepares + ', p95 ' + percentile(prepareDiffs, 0.95) + '  ' + verdict(maxPrepares <= BUDGETS.preparesPerTurn));
    say('  p95 |possibleSeeds|           <= ' + BUDGETS.seeds + '      -> ' + p95Seeds + '  ' + verdict(p95Seeds <= BUDGETS.seeds));
    say('  bytes per night @ frameRate ' + frameRate + '  <= ' + kb(BUDGETS.nightBytes) + '   -> ' + kb(nightBytes) + '   ' + verdict(nightBytes <= BUDGETS.nightBytes));
    say('    extrapolation: p50 frame ' + kb(p50FrameBytes) + ' x ' + turnsPerNight + ' turns/night (' + turnsSource + ') x ' + frameRate);
    if (nightBytes > BUDGETS.nightBytes && p50FrameBytes > 0) {
      say('    a frameRate of at most ' + (BUDGETS.nightBytes / (p50FrameBytes * turnsPerNight)).toFixed(3) + ' holds the nightly-bytes budget');
    }
    if (stats.traces > stats.frames) {
      say('  note: ' + (stats.traces - stats.frames) + ' of ' + stats.traces + ' traced turns were refused a frame (over dream.maxFrameBytes)');
    }
    say('');

    say('Write attribution on the same corpus (total_changes(), row writes per turn)');
    say('  without recorder: p50 ' + percentile(off.perTurn.map((t) => t.writes), 0.5) + '  - the touchMemories/FTS churn that predates the dream');
    say('  with recorder:    p50 ' + percentile(on.perTurn.map((t) => t.writes), 0.5));
    say('  recorder share:   p50 +' + percentile(writeDiffs, 0.5) + ' row writes per turn (trace, frame, touches)');
    {
      // The isolated before-measurement: what one touch of eight rows costs
      // in FTS row rewrites alone, with no recorder anywhere near it.
      const store = new ctx.Store(join(dir, 'touch.db'));
      const records = withFrozenClock(BUILD_NOW, () => buildBank(store, ctx.ASSISTANT_MEMORY_OWNER, sizes, mulberry32(args.seed)));
      const meter = instrument(store);
      const before = meter.totalChanges();
      store.touchMemories(records.slice(0, 8).map((record) => record.id));
      say('  isolated touchMemories(8 rows): ' + (meter.totalChanges() - before) + ' row writes (the up-to-eight FTS row pairs per turn, concept 8.7)');
      store.close();
    }
    say('');

    const behaviour = behaviourChangeRun(ctx, dir, sizes, args.seed, texts);
    say('Third run - the two declared behaviour changes (build plan 1.3), before/after');
    say('  turns replayed: ' + behaviour.report.turns);
    behaviour.states.forEach((state, index) => say('  state ' + (index + 1) + ': ' + state.label));
    behaviour.report.pairs.forEach((tally, index) => {
      const from = behaviour.states[index].key;
      const to = behaviour.states[index + 1].key;
      say('  ' + from + ' -> ' + to + ':');
      say('    turns with a changed block: ' + tally.blockChanged);
      say('    turns with a changed head: ' + tally.headChanged + ' (head became a profile row: ' + tally.headFlippedToProfile + ', became a direct hit: ' + tally.headFlippedToDirect + ')');
      say('    lines shifted in total: ' + tally.linesShifted + ' (mean ' + (behaviour.report.turns ? (tally.linesShifted / behaviour.report.turns).toFixed(2) : '0') + ' per turn)');
    });
    say('  note: the pre-commit-B state is simulated with the deterministic profile');
    say('  order of today; the historical order at ties was undefined - that was');
    say('  the bug AP2 fixed, and it is the honest limit of measuring it after the fact.');
    say('');

    if (influx) {
      say('Phase 0 - label influx (read-only over ' + influx.path + ')');
      if (influx.error) {
        say('  ' + influx.error);
      } else {
        for (const source of Object.values(influx.sources)) {
          if (source.error) {
            say('  ' + source.label + ': unreadable (' + source.error + ')');
          } else if (source.median === undefined) {
            say('  ' + source.label + ': no number');
          } else {
            say('  ' + source.label + ': median ' + source.median + ', max ' + source.max + ', total ' + source.total + ' over ' + source.nights + ' nights (UTC-day buckets)');
          }
          say('    ' + source.note);
        }
      }
      say('');
    } else {
      say('Phase 0 - label influx: skipped (pass --db <path> to measure it read-only)');
      say('');
    }

    const stamp = new Date().toISOString().slice(0, 10);
    say('Paste-ready for the head of packages/core/src/memory/dream/frame.ts and the PR description:');
    say('  dream bench ' + stamp + ': p95 frame ' + kb(p95FrameBytes) + ', p95 extra latency ' + ms(p95Latency) + ',');
    say('  extra prepares/turn max ' + maxPrepares + ', p95 seeds ' + p95Seeds + ', nightly bytes @' + frameRate + ' ' + kb(nightBytes) + '.');
    if (args.db) {
      say('  Phase 0 influx per night: ' + Object.keys(influx.sources).join(', ') + ' - see above.');
    }

    // Assistant.close() closes the store it was given; the frames were read
    // before this point.
    on.assistant.close();
    off.assistant.close();
  } catch (error) {
    runError = error;
  } finally {
    console.log(lines.join('\n'));
    if (args.keep) {
      console.log('');
      console.log('Temp directory kept: ' + dir);
    } else {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows keeps files of handles that close asynchronously; the temp
        // directory is the OS's to reclaim, a leftover is not a failure.
        console.log('Note: could not remove the temp directory: ' + dir);
      }
    }
  }
  if (runError) throw runError;
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack : error));
  process.exitCode = 1;
});

