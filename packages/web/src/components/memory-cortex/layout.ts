import type { MemoryGraph } from '@/lib/types';

/**
 * Where everything sits on the cortex.
 *
 * The old net was a ball of springs: every body pulled on every other one
 * until the picture settled, and it settled differently every time. This is
 * the opposite idea. There is a fixed shape - a brain, two hemispheres, a
 * fissure down the middle, a flatter underside, folds on top - and the
 * memory is laid *onto* it.
 *
 * A topic is a region of the cortex. A memory is a neuron on the surface
 * near the regions it mentions; a memory that mentions nothing floats in
 * the white matter underneath, and a sleeping one sinks a little below the
 * surface. Nothing here is random in the loose sense: every position is
 * seeded from the row's id, so a filter or a refetch moves nothing that did
 * not change.
 *
 * The shape written out below in `brainShape` is the stand-in surface: it
 * is what the layout runs on before the real model has been read, and what
 * it runs on if that model never arrives. The scene hands in the model's
 * surface as soon as it has one.
 *
 * This module is pure maths - no DOM, no WebGL - so a test can ask it where
 * things went.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CortexEntity {
  id: string;
  /** Unit direction from the centre of the brain. */
  dir: Vec3;
  /** On the surface, slightly proud of it. */
  position: Vec3;
  weight: number;
  /** The part of the cortex it was pulled to. */
  region: CortexRegion;
}

export interface CortexMemory {
  id: string;
  dir: Vec3;
  position: Vec3;
  /**
   * Always false now: a memory that mentions nothing used to float inside
   * the brain, drawn through the tissue, and read as a body that had gone
   * through it. It sits on the surface in the region of its kind instead.
   * The flag stays so the surface offset table keeps its shape.
   */
  deep: boolean;
  dormant: boolean;
  region: CortexRegion;
}

/**
 * Distance from the centre to the surface along a unit direction. The
 * formula below is the default; the scene swaps in a real model's surface
 * once it has loaded, and everything here lays out on that instead.
 */
export type Surface = (dir: Vec3) => number;

export interface CortexLayout {
  entities: CortexEntity[];
  memories: CortexMemory[];
}

/* -------------------------------- shape --------------------------------- */

/** Axes: x left/right, y up/down, z front/back (positive z is the forehead). */
const RX = 1.0;
const RY = 0.8;
const RZ = 1.22;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Distance from the centre to the cortex along a unit direction.
 *
 * An ellipsoid first; then the underside is pressed flat, the longitudinal
 * fissure is cut into the top, the forehead narrows a touch, a cerebellum
 * bulges out under the back, and two frequencies of folds ripple the whole
 * thing so it reads as tissue rather than as an egg.
 */
export function brainRadius(dir: Vec3): number {
  return brainShape(dir).radius;
}

export interface BrainShape {
  radius: number;
  /** How far into the longitudinal fissure this direction points, 0..1. */
  fissure: number;
  /** Ridge (positive) or groove (negative), roughly -1.5..1.5. */
  fold: number;
}

/** The surface with its features named, for whoever shades it. */
export function brainShape(dir: Vec3): BrainShape {
  const { x, y, z } = dir;
  let r = 1 / Math.sqrt((x * x) / (RX * RX) + (y * y) / (RY * RY) + (z * z) / (RZ * RZ));

  // A flatter base: the brain sits on something.
  r *= 1 - 0.16 * smoothstep(0, 1, -y);

  // The fissure between the hemispheres, deepest on top and fading out at
  // the sides. `px` is the actual x of the point, not the direction, so the
  // cut has the same width all along the crown.
  const px = x * r;
  const fissure = Math.exp(-(px * px) / (0.1 * 0.1)) * smoothstep(-0.15, 0.55, y);
  r *= 1 - 0.13 * fissure;

  // Forehead slightly narrower, occiput slightly tapered.
  r *= 1 - 0.05 * smoothstep(0.3, 1, z);
  r *= 1 - 0.03 * smoothstep(0.5, 1, -z);

  // Cerebellum: a bulge low and to the back.
  r *= 1 + 0.09 * smoothstep(0.2, 0.75, -y) * smoothstep(0.15, 0.8, -z);

  // Folds. Two frequencies, both mostly transverse, so the top shows the
  // ridges and grooves a cortex actually has.
  const qx = x * r;
  const qy = y * r;
  const qz = z * r;
  const fold =
    Math.sin(qx * 5.3 + 0.7) * Math.cos(qy * 6.1 + 0.3) * Math.sin(qz * 4.6 + 1.3) +
    0.5 * Math.sin(qx * 9.4 + 2.2) * Math.sin(qz * 8.1 + 0.9) * Math.cos(qy * 7.3) +
    0.35 * Math.sin(qx * 15.1 + 1.1) * Math.cos(qz * 13.4 + 2.6) * Math.sin(qy * 12.2 + 0.4);
  r *= 1 + 0.03 * fold * (0.4 + 0.6 * smoothstep(-0.4, 0.4, y));

  return { radius: r, fissure, fold };
}

/* --------------------------------- maths -------------------------------- */

/** A stable number in [0, 1) for a string, varied by `salt`. FNV-1a, mixed. */
export function hash01(input: string, salt = 0): number {
  let h = (2166136261 ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  for (let index = 0; index < input.length; index++) {
    h ^= input.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function scale(v: Vec3, factor: number): Vec3 {
  return { x: v.x * factor, y: v.y * factor, z: v.z * factor };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/** A uniformly distributed unit direction from two numbers in [0, 1). */
function directionFrom(u: number, v: number): Vec3 {
  const theta = u * Math.PI * 2;
  const cosPhi = v * 2 - 1;
  const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
  return { x: sinPhi * Math.cos(theta), y: cosPhi, z: sinPhi * Math.sin(theta) };
}

/** Pushes `dir` along `force` while keeping it on the unit sphere. */
function nudge(dir: Vec3, force: Vec3): Vec3 {
  // Only the tangential part moves a point on a sphere.
  const radial = dot(force, dir);
  return normalize(add(dir, sub(force, scale(dir, radial))));
}

/* -------------------------------- regions ------------------------------- */

/**
 * Where a kind of memory lives on the cortex.
 *
 * Neuroscience as a metaphor, not as a claim: preferences sit at the
 * forehead where values and decisions are weighed, facts along the side
 * of the temporal lobe where semantic memory is kept, events on its
 * underside near the hippocampus, projects and plans up on the parietal
 * crown, summaries behind them, insights at the front of the cingulate.
 * People have a place of their own on the fusiform gyrus, places on the
 * parahippocampal one, tools on the parietal lobe. The cerebellum is kept
 * for procedure - skills, one day.
 *
 * Each region is a direction on the right hemisphere; `hemisphere` flips
 * it to the left. The cerebellum sits on the midline and is not flipped.
 */
export type CortexRegion =
  | 'prefrontal'
  | 'parietal'
  | 'posterior-parietal'
  | 'lateral-temporal'
  | 'medial-temporal'
  | 'cingulate'
  | 'fusiform'
  | 'parahippocampal'
  | 'cerebellum';

export const REGION_LABEL: Record<CortexRegion, string> = {
  prefrontal: 'Prefrontal cortex',
  parietal: 'Parietal lobe',
  'posterior-parietal': 'Posterior parietal cortex',
  'lateral-temporal': 'Lateral temporal lobe',
  'medial-temporal': 'Medial temporal lobe',
  cingulate: 'Anterior cingulate',
  fusiform: 'Fusiform gyrus',
  parahippocampal: 'Parahippocampal gyrus',
  cerebellum: 'Cerebellum',
};

const REGION_DIR: Record<CortexRegion, Vec3> = {
  prefrontal: normalize({ x: 0.45, y: 0.35, z: 0.85 }),
  parietal: normalize({ x: 0.6, y: 0.75, z: 0.1 }),
  'posterior-parietal': normalize({ x: 0.5, y: 0.65, z: -0.55 }),
  'lateral-temporal': normalize({ x: 0.95, y: -0.12, z: 0.15 }),
  'medial-temporal': normalize({ x: 0.8, y: -0.5, z: 0.05 }),
  cingulate: normalize({ x: 0.5, y: 0.2, z: 0.6 }),
  fusiform: normalize({ x: 0.7, y: -0.6, z: 0.15 }),
  parahippocampal: normalize({ x: 0.7, y: -0.5, z: -0.45 }),
  cerebellum: normalize({ x: 0, y: -0.6, z: -0.8 }),
};

const KIND_REGION: Record<string, CortexRegion> = {
  preference: 'prefrontal',
  fact: 'lateral-temporal',
  event: 'medial-temporal',
  project: 'parietal',
  summary: 'posterior-parietal',
  insight: 'cingulate',
};

const ENTITY_KIND_REGION: Partial<Record<string, CortexRegion>> = {
  person: 'fusiform',
  place: 'parahippocampal',
  tool: 'parietal',
};

/** The region a memory of this kind belongs to. */
export function regionForKind(kind: string): CortexRegion {
  return KIND_REGION[kind] ?? 'lateral-temporal';
}

/**
 * The region a topic belongs to: its own kind when that says something
 * (a person, a place, a tool), else wherever most of its memories go.
 */
export function regionForEntity(entityKind: string, memoryKinds: string[]): CortexRegion {
  const own = ENTITY_KIND_REGION[entityKind];
  if (own) return own;
  const votes = new Map<CortexRegion, number>();
  for (const kind of memoryKinds) {
    const region = regionForKind(kind);
    votes.set(region, (votes.get(region) ?? 0) + 1);
  }
  let best: CortexRegion = 'lateral-temporal';
  let most = 0;
  for (const [region, count] of votes) {
    if (count > most) {
      most = count;
      best = region;
    }
  }
  return best;
}

/** The region's direction on the given hemisphere (+1 right, -1 left). */
export function regionDir(region: CortexRegion, hemisphere: 1 | -1): Vec3 {
  const dir = REGION_DIR[region];
  return region === 'cerebellum' ? dir : { x: dir.x * hemisphere, y: dir.y, z: dir.z };
}

/* -------------------------------- layout -------------------------------- */

const ENTITY_ROUNDS = 80;
/** How hard a topic is pulled to its region, against repulsion and co-mention. */
const REGION_PULL = 0.14;
/** How much a memory leans toward its own kind's region, against its topics. */
const KIND_LEAN = 0.25;
const MEMORY_ROUNDS = 60;
/** How close two neurons may sit, as an angle in radians (about 3.5°). */
const NEURON_SEPARATION = 0.062;
/** A neuron keeps at least this far from a region's core so the core stays visible. */
const CORE_CLEARANCE = 0.1;

/** Surface offsets, as multiples of `brainRadius`. */
export const SURFACE = {
  entity: 1.04,
  memory: 1.022,
  /** Sunk into the tissue: just at the surface, so it is still seen, as an ember. */
  dormant: 1.004,
  deep: 0.6,
} as const;

export function layoutCortex(graph: MemoryGraph | null, surface: Surface = brainRadius): CortexLayout {
  if (!graph) return { entities: [], memories: [] };

  /* Topics: spread over the surface, big ones pushing harder. */

  const mentions = new Map<string, number>();
  for (const link of graph.links) mentions.set(link.entityId, (mentions.get(link.entityId) ?? 0) + 1);

  const memoryKindById = new Map(graph.memories.map((memory) => [memory.id, memory.kind as string]));
  const kindsOfEntity = new Map<string, string[]>();
  for (const link of graph.links) {
    const kind = memoryKindById.get(link.memoryId);
    if (!kind) continue;
    const list = kindsOfEntity.get(link.entityId);
    if (list) list.push(kind);
    else kindsOfEntity.set(link.entityId, [kind]);
  }

  // A topic starts in its region, on a hemisphere its id decides, a little
  // off the region's centre so two topics of one region do not start on
  // top of each other.
  const entityDirs = new Map<string, Vec3>();
  const entityHome = new Map<string, Vec3>();
  const entityRegion = new Map<string, CortexRegion>();
  const entityWeight = new Map<string, number>();
  for (const entity of graph.entities) {
    const hemisphere: 1 | -1 = hash01(entity.id, 9) < 0.5 ? 1 : -1;
    const region = regionForEntity(entity.kind, kindsOfEntity.get(entity.id) ?? []);
    const home = regionDir(region, hemisphere);
    entityRegion.set(entity.id, region);
    const jitter = directionFrom(hash01(entity.id, 1), hash01(entity.id, 2));
    entityHome.set(entity.id, home);
    entityDirs.set(entity.id, normalize(add(home, scale(jitter, 0.35))));
    entityWeight.set(entity.id, 1 + Math.log1p(mentions.get(entity.id) ?? entity.mentions ?? 0));
  }

  // Topics named in the same memory belong to the same region of the
  // cortex. Without this pull every topic lands somewhere on its own and a
  // memory of three topics strings three long fibres across the brain; with
  // it the topics of one subject gather into a lobe and the fibres stay short.
  const together = new Map<string, number>();
  const entitiesOfMemory = new Map<string, string[]>();
  for (const link of graph.links) {
    if (!entityDirs.has(link.entityId)) continue;
    const list = entitiesOfMemory.get(link.memoryId);
    if (list) list.push(link.entityId);
    else entitiesOfMemory.set(link.memoryId, [link.entityId]);
  }
  const pair = (a: string, b: string, count: number): void => {
    if (a === b) return;
    const key = a < b ? a + '|' + b : b + '|' + a;
    together.set(key, (together.get(key) ?? 0) + count);
  };
  for (const list of entitiesOfMemory.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) pair(list[i]!, list[j]!, 1);
    }
  }
  // A relation the night drew between two memories is also a reason for
  // their topics to sit near each other - a weaker one than sharing a memory.
  for (const edge of graph.edges) {
    const from = entitiesOfMemory.get(edge.srcId) ?? [];
    const to = entitiesOfMemory.get(edge.dstId) ?? [];
    for (const a of from) for (const b of to) pair(a, b, 0.4);
  }

  const entityIds = [...entityDirs.keys()];
  for (let round = 0; round < ENTITY_ROUNDS; round++) {
    const step = 0.09 * (1 - round / ENTITY_ROUNDS);
    const forces = new Map<string, Vec3>();
    for (let i = 0; i < entityIds.length; i++) {
      const a = entityIds[i]!;
      const da = entityDirs.get(a)!;
      let force = { x: 0, y: 0, z: 0 };
      for (let j = 0; j < entityIds.length; j++) {
        if (i === j) continue;
        const b = entityIds[j]!;
        const away = sub(da, entityDirs.get(b)!);
        const distance = Math.hypot(away.x, away.y, away.z) + 0.02;
        const strength = ((entityWeight.get(a)! * entityWeight.get(b)!) / (distance * distance)) * 0.02;
        force = add(force, scale(away, strength / distance));
      }
      // Stay out of the fissure on the crown: a region sitting in the cut
      // between the hemispheres belongs to neither.
      if (da.y > 0) force.x += Math.sign(da.x || 1) * 0.15 * Math.exp(-(da.x * da.x) / 0.02);
      // And home: the region its memories say it belongs to.
      force = add(force, scale(sub(entityHome.get(a)!, da), REGION_PULL));
      forces.set(a, force);
    }
    for (const [key, count] of together) {
      const [a, b] = key.split('|') as [string, string];
      const da = entityDirs.get(a)!;
      const db = entityDirs.get(b)!;
      const pull = scale(sub(db, da), 0.05 * Math.sqrt(count));
      forces.set(a, add(forces.get(a)!, pull));
      forces.set(b, sub(forces.get(b)!, pull));
    }
    for (const id of entityIds) entityDirs.set(id, nudge(entityDirs.get(id)!, scale(forces.get(id)!, step)));
  }

  /* Neurons: near what they mention, apart from each other. */

  const memoryEntities = entitiesOfMemory;

  const anchors = new Map<string, Vec3>();
  const resolveAnchor = (memoryId: string): Vec3 | null => {
    const owned = memoryEntities.get(memoryId);
    if (!owned?.length) return null;
    let sum = { x: 0, y: 0, z: 0 };
    for (const entityId of owned) sum = add(sum, entityDirs.get(entityId)!);
    return normalize(sum);
  };
  for (const memory of graph.memories) {
    const anchor = resolveAnchor(memory.id);
    if (anchor) anchors.set(memory.id, anchor);
  }
  // A memory without a topic of its own borrows its neighbours' place - one
  // hop over a relation is enough to put it beside what it refines.
  for (const edge of graph.edges) {
    const src = anchors.get(edge.srcId);
    const dst = anchors.get(edge.dstId);
    if (src && !anchors.has(edge.dstId)) anchors.set(edge.dstId, src);
    if (dst && !anchors.has(edge.srcId)) anchors.set(edge.srcId, dst);
  }
  // And a memory with topics of its own still leans a little toward what
  // it is related to, so the fibre the night drew stays short enough to
  // read as a relation rather than as a chord across the whole brain.
  const leaned = new Map<string, Vec3>();
  for (const [id, anchor] of anchors) {
    let sum = scale(anchor, 2);
    for (const edge of graph.edges) {
      const otherId = edge.srcId === id ? edge.dstId : edge.dstId === id ? edge.srcId : null;
      const other = otherId ? anchors.get(otherId) : null;
      if (other) sum = add(sum, other);
    }
    leaned.set(id, normalize(sum));
  }
  for (const [id, anchor] of leaned) anchors.set(id, anchor);

  interface Working {
    id: string;
    dir: Vec3;
    anchor: Vec3 | null;
    deep: boolean;
    dormant: boolean;
  }

  const working: Working[] = graph.memories.map((memory) => {
    const topics = anchors.get(memory.id) ?? null;
    const jitter = directionFrom(hash01(memory.id, 3), hash01(memory.id, 4));
    const owned = memoryEntities.get(memory.id)?.length ?? 0;
    const kindHome = regionDir(regionForKind(memory.kind), (topics ? topics.x : jitter.x) < 0 ? -1 : 1);
    // Where its topics are, leaning toward where its kind belongs: an event
    // filed under a topic of facts still drifts to the underside of that
    // topic's lobe rather than sitting in the middle of the facts. A memory
    // with no topic at all has only its kind, and goes where that lives.
    const anchor = topics ? normalize(add(scale(topics, 1 - KIND_LEAN), scale(kindHome, KIND_LEAN))) : kindHome;
    // A neuron of one topic forms a cloud around that core; one of several
    // topics sits between them and needs less room to be told apart; one
    // of none has a whole region to itself and spreads out in it.
    const spread = owned > 1 ? 0.12 : owned === 1 ? 0.24 : 0.4;
    const dir = normalize(add(anchor, scale(jitter, spread)));
    return { id: memory.id, dir, anchor, deep: false, dormant: Boolean(memory.dormantAt) };
  });

  const coreDirs = entityIds.map((id) => entityDirs.get(id)!);
  const onSurface = working;

  for (let round = 0; round < MEMORY_ROUNDS; round++) {
    const step = 1 - round / MEMORY_ROUNDS;
    for (let i = 0; i < onSurface.length; i++) {
      const me = onSurface[i]!;
      let force = { x: 0, y: 0, z: 0 };
      for (let j = 0; j < onSurface.length; j++) {
        if (i === j) continue;
        const other = onSurface[j]!;
        const away = sub(me.dir, other.dir);
        const distance = Math.hypot(away.x, away.y, away.z);
        if (distance >= NEURON_SEPARATION || distance === 0) continue;
        force = add(force, scale(away, ((NEURON_SEPARATION - distance) / distance) * 0.5));
      }
      for (const core of coreDirs) {
        const away = sub(me.dir, core);
        const distance = Math.hypot(away.x, away.y, away.z);
        if (distance >= CORE_CLEARANCE || distance === 0) continue;
        force = add(force, scale(away, ((CORE_CLEARANCE - distance) / distance) * 0.6));
      }
      // The tether back to the topic: without it the repulsion would walk a
      // crowded cluster right across the brain.
      if (me.anchor) force = add(force, scale(sub(me.anchor, me.dir), 0.03));
      me.dir = nudge(me.dir, scale(force, step));
    }
  }

  const entities: CortexEntity[] = entityIds.map((id) => {
    const dir = entityDirs.get(id)!;
    return {
      id,
      dir,
      position: scale(dir, surface(dir) * SURFACE.entity),
      weight: entityWeight.get(id)!,
      region: entityRegion.get(id)!,
    };
  });

  const memories: CortexMemory[] = working.map((item) => {
    const offset = item.deep ? SURFACE.deep : item.dormant ? SURFACE.dormant : SURFACE.memory;
    return {
      id: item.id,
      dir: item.dir,
      position: scale(item.dir, surface(item.dir) * offset),
      deep: item.deep,
      dormant: item.dormant,
      region: regionForKind(memoryKindById.get(item.id) ?? 'fact'),
    };
  });

  return { entities, memories };
}

/* ---------------------------------- arcs --------------------------------- */

/** A unit vector at right angles to `dir`; any will do, but always the same one. */
function perpendicular(dir: Vec3): Vec3 {
  const pick = Math.abs(dir.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  return normalize(cross(dir, pick));
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** The shorter great-circle way from one unit direction to another. */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const cosine = Math.max(-1, Math.min(1, dot(a, b)));
  const omega = Math.acos(cosine);
  if (omega < 1e-4) return normalize(add(scale(a, 1 - t), scale(b, t)));
  const sine = Math.sin(omega);
  return add(scale(a, Math.sin((1 - t) * omega) / sine), scale(b, Math.sin(t * omega) / sine));
}

/**
 * A fibre from `a` to `b` that lies on the cortex.
 *
 * It follows the surface rather than an arc drawn through the air: the
 * direction sweeps along the great circle between the two bodies, and at
 * every step the height comes from `brainShape` itself, so the fibre drops
 * into the grooves and rises over the ridges it crosses. It rides `lift`
 * above the tissue, a touch more in the middle so it clears the neurons
 * it passes. A seeded sideways wave keeps it from being a perfect circle -
 * tissue is not that tidy - and the two ends land exactly on the bodies,
 * which for a deep memory means diving into the interior at that end.
 *
 * Returned flat, `segments + 1` points, for a line buffer.
 */
export function fibrePath(
  a: Vec3,
  b: Vec3,
  lift: number,
  segments: number,
  seed: string,
  surface: Surface = brainRadius,
): Float32Array {
  const out = new Float32Array((segments + 1) * 3);
  const da = normalize(a);
  const db = normalize(b);
  const ra = Math.hypot(a.x, a.y, a.z);
  const rb = Math.hypot(b.x, b.y, b.z);
  const span = Math.acos(Math.max(-1, Math.min(1, dot(da, db))));

  // The way goes through a midpoint. For most pairs that is simply the
  // halfway direction; for two bodies on opposite sides of the brain the
  // great circle between them is not defined, and the fibre used to fly
  // off into a spike there. Those go over the crown instead.
  const sum = add(da, db);
  let mid =
    Math.hypot(sum.x, sum.y, sum.z) > 0.25
      ? normalize(sum)
      : normalize(add(perpendicular(da), { x: 0, y: 0.8, z: 0 }));
  // The underside toward the back is where the cerebellum tucks under the
  // cerebrum - no surface a fibre can lie on. A long fibre whose way would
  // pass there is lifted just enough to skirt it along the side, keeping
  // its own bearing: sending them all over the crown instead bunched every
  // long fibre through one point, a cage of great circles.
  if (span > 0.9 && mid.y < -0.2 && mid.z < 0.35) {
    mid = normalize({ x: mid.x, y: -0.2, z: mid.z });
  }

  // Sideways: perpendicular to the plane of the way.
  const axis = span > 1e-3 ? normalize(cross(da, mid)) : perpendicular(da);
  const waveAmplitude = (0.02 + 0.06 * hash01(seed, 11)) * Math.min(1, span);
  const waveFrequency = 1.5 + hash01(seed, 12) * 2;
  const wavePhase = hash01(seed, 13) * Math.PI * 2;

  // How far each end sits off the fibre's own height, so the fibre can
  // start and finish exactly on the bodies and forget that within a third
  // of its length.
  const offsetA = ra - surface(da) * (1 + lift);
  const offsetB = rb - surface(db) * (1 + lift);

  const dirs: Vec3[] = [];
  const floors: number[] = [];
  const heights: number[] = [];
  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    const bell = Math.sin(t * Math.PI);
    const wave = Math.sin(t * Math.PI * waveFrequency + wavePhase) * waveAmplitude * bell;
    const along = t < 0.5 ? slerp(da, mid, t * 2) : slerp(mid, db, t * 2 - 1);
    const dir = normalize(add(along, scale(axis, wave)));
    const floor = surface(dir) * (1 + lift + 0.02 * bell);
    dirs.push(dir);
    floors.push(floor);
    heights.push(floor);
  }
  // The surface is sampled, and a sampled surface has steps; two passes of
  // a small blur take the steps out of the height without moving the way.
  // The blur may only lift a point, never lower it below the surface it
  // was read from - a fibre smoothed downward is a fibre inside the brain.
  for (let pass = 0; pass < 2; pass++) {
    const before = heights.slice();
    for (let index = 1; index < segments; index++) {
      heights[index] = Math.max(floors[index]!, (before[index - 1]! + 2 * before[index]! + before[index + 1]!) / 4);
    }
  }
  const ease = (u: number): number => Math.pow(Math.max(0, 1 - u * 3), 2);
  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    const dir = dirs[index]!;
    const radius = heights[index]! + offsetA * ease(t) + offsetB * ease(1 - t);
    out[index * 3] = dir.x * radius;
    out[index * 3 + 1] = dir.y * radius;
    out[index * 3 + 2] = dir.z * radius;
  }
  // The ends are the bodies themselves, bit for bit.
  out[0] = a.x;
  out[1] = a.y;
  out[2] = a.z;
  out[segments * 3] = b.x;
  out[segments * 3 + 1] = b.y;
  out[segments * 3 + 2] = b.z;
  return out;
}

/** A point along a flat polyline at `t` in 0..1, written into `out`. */
export function pathPoint(path: Float32Array, t: number, out: Vec3): Vec3 {
  const last = path.length / 3 - 1;
  const at = Math.max(0, Math.min(last, t * last));
  const index = Math.min(last - 1, Math.floor(at));
  const f = at - index;
  const i = index * 3;
  out.x = path[i]! + (path[i + 3]! - path[i]!) * f;
  out.y = path[i + 1]! + (path[i + 4]! - path[i + 1]!) * f;
  out.z = path[i + 2]! + (path[i + 5]! - path[i + 2]!) * f;
  return out;
}

