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
}

export interface CortexMemory {
  id: string;
  dir: Vec3;
  position: Vec3;
  /** Mentions nothing: lives inside rather than on the cortex. */
  deep: boolean;
  dormant: boolean;
}

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

/* -------------------------------- layout -------------------------------- */

const ENTITY_ROUNDS = 80;
const MEMORY_ROUNDS = 60;
/** How close two neurons may sit, as an angle in radians (about 3.5°). */
const NEURON_SEPARATION = 0.062;
/** A neuron keeps at least this far from a region's core so the core stays visible. */
const CORE_CLEARANCE = 0.1;

/** Surface offsets, as multiples of `brainRadius`. */
export const SURFACE = {
  entity: 1.045,
  memory: 1.02,
  /** Sunk into the tissue: just at the surface, so it is still seen, as an ember. */
  dormant: 1.004,
  deep: 0.6,
} as const;

export function layoutCortex(graph: MemoryGraph | null): CortexLayout {
  if (!graph) return { entities: [], memories: [] };

  /* Topics: spread over the surface, big ones pushing harder. */

  const mentions = new Map<string, number>();
  for (const link of graph.links) mentions.set(link.entityId, (mentions.get(link.entityId) ?? 0) + 1);

  const entityDirs = new Map<string, Vec3>();
  const entityWeight = new Map<string, number>();
  for (const entity of graph.entities) {
    entityDirs.set(entity.id, directionFrom(hash01(entity.id, 1), hash01(entity.id, 2)));
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
    const anchor = anchors.get(memory.id) ?? null;
    const jitter = directionFrom(hash01(memory.id, 3), hash01(memory.id, 4));
    const owned = memoryEntities.get(memory.id)?.length ?? 0;
    // A neuron of one topic forms a cloud around that core; one of several
    // topics sits between them and needs less room to be told apart.
    const spread = owned > 1 ? 0.12 : 0.24;
    const dir = anchor ? normalize(add(anchor, scale(jitter, spread))) : jitter;
    return { id: memory.id, dir, anchor, deep: !anchor, dormant: Boolean(memory.dormantAt) };
  });

  const coreDirs = entityIds.map((id) => entityDirs.get(id)!);
  const surface = working.filter((item) => !item.deep);

  for (let round = 0; round < MEMORY_ROUNDS; round++) {
    const step = 1 - round / MEMORY_ROUNDS;
    for (let i = 0; i < surface.length; i++) {
      const me = surface[i]!;
      let force = { x: 0, y: 0, z: 0 };
      for (let j = 0; j < surface.length; j++) {
        if (i === j) continue;
        const other = surface[j]!;
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
    return { id, dir, position: scale(dir, brainRadius(dir) * SURFACE.entity), weight: entityWeight.get(id)! };
  });

  const memories: CortexMemory[] = working.map((item) => {
    const offset = item.deep ? SURFACE.deep : item.dormant ? SURFACE.dormant : SURFACE.memory;
    return {
      id: item.id,
      dir: item.dir,
      position: scale(item.dir, brainRadius(item.dir) * offset),
      deep: item.deep,
      dormant: item.dormant,
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
export function fibrePath(a: Vec3, b: Vec3, lift: number, segments: number, seed: string): Float32Array {
  const out = new Float32Array((segments + 1) * 3);
  const da = normalize(a);
  const db = normalize(b);
  const ra = Math.hypot(a.x, a.y, a.z);
  const rb = Math.hypot(b.x, b.y, b.z);
  const span = Math.acos(Math.max(-1, Math.min(1, dot(da, db))));

  // Sideways: perpendicular to the plane of the great circle.
  const axis = span > 1e-3 ? normalize(cross(da, db)) : perpendicular(da);
  const waveAmplitude = (0.02 + 0.06 * hash01(seed, 11)) * Math.min(1, span);
  const waveFrequency = 1.5 + hash01(seed, 12) * 2;
  const wavePhase = hash01(seed, 13) * Math.PI * 2;

  // How far each end sits off the fibre's own height, so the fibre can
  // start and finish exactly on the bodies and forget that within a third
  // of its length.
  const offsetA = ra - brainRadius(da) * (1 + lift);
  const offsetB = rb - brainRadius(db) * (1 + lift);

  for (let index = 0; index <= segments; index++) {
    const t = index / segments;
    const bell = Math.sin(t * Math.PI);
    const wave = Math.sin(t * Math.PI * waveFrequency + wavePhase) * waveAmplitude * bell;
    const dir = normalize(add(slerp(da, db, t), scale(axis, wave)));
    const height = brainRadius(dir) * (1 + lift + 0.02 * bell);
    const ease = (u: number): number => Math.pow(Math.max(0, 1 - u * 3), 2);
    const radius = height + offsetA * ease(t) + offsetB * ease(1 - t);
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

/**
 * The tissue itself: points scattered over the cortex, hash-seeded so the
 * ghost of the brain is the same on every visit. Returned flat for a buffer.
 */
export function surfaceDust(count: number): { positions: Float32Array; shades: Float32Array } {
  const positions = new Float32Array(count * 3);
  const shades = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const key = 'dust:' + index;
    const dir = directionFrom(hash01(key, 5), hash01(key, 6));
    const shape = brainShape(dir);
    // Slightly under the neurons and a little uneven, like a real surface.
    const radius = shape.radius * (0.985 + hash01(key, 7) * 0.02);
    positions[index * 3] = dir.x * radius;
    positions[index * 3 + 1] = dir.y * radius;
    positions[index * 3 + 2] = dir.z * radius;
    // Ridges catch the light, grooves and the fissure fall into shadow:
    // that is what makes the tissue read as a cortex rather than a fog.
    const ridge = 0.45 + 0.55 * Math.max(-1, Math.min(1, shape.fold));
    shades[index] = ridge * (1 - 0.85 * shape.fissure) * (0.8 + hash01(key, 8) * 0.4);
  }
  return { positions, shades };
}
