import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

/**
 * The cortex layout is pure maths, and these tests hold it to its promises:
 * the shape is a brain and not a sphere, a memory lands beside what it
 * mentions, a memory that mentions nothing goes inside, and nothing moves
 * that did not change. `scene.ts` trusts all four.
 *
 * They run under `npm test -w @rookery/web`.
 */

async function loadLayout(file = 'layout.ts') {
  const require = createRequire(import.meta.url);
  const three = file === 'scene.ts' ? await import('three') : null;
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/components/memory-cortex/' + file, import.meta.url))],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    define: { 'import.meta.env.DEV': 'false' },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', outputFiles[0].text)(id => id === 'three' ? three : require(id), module, module.exports);
  return module.exports;
}

const NOW = 1_758_240_000_000;

function memory(id, extra = {}) {
  return {
    id,
    kind: 'fact',
    content: 'memory ' + id,
    tags: [],
    importance: 0.5,
    owner: 'assistant',
    createdAt: NOW,
    updatedAt: NOW,
    accessCount: 0,
    forgotten: false,
    origin: 'extract',
    pinned: false,
    usefulness: 0,
    ...extra,
  };
}

function entity(id, mentions = 1) {
  return { id, owner: 'assistant', name: id, slug: id, kind: 'topic', mentions, firstSeenAt: NOW, lastSeenAt: NOW };
}

function graphOf({ entities = [], memories = [], links = [], edges = [] }) {
  return { entities, memories, links, edges, truncated: false };
}

const length = (v) => Math.hypot(v.x, v.y, v.z);
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));

test('the surface is a brain: wider than tall, longer than wide, cut along the crown', async () => {
  const { brainRadius } = await loadLayout();
  const up = brainRadius({ x: 0, y: 1, z: 0 });
  const side = brainRadius({ x: 1, y: 0, z: 0 });
  const front = brainRadius({ x: 0, y: 0, z: 1 });
  const down = brainRadius({ x: 0, y: -1, z: 0 });
  assert.ok(front > side, 'front-to-back is the long axis');
  assert.ok(side > up, 'the crown sits lower than the sides are wide');
  assert.ok(down < up, 'the underside is flatter than the crown');
  // The fissure: straight up is cut deeper than a point just off the midline.
  const beside = brainRadius({ x: 0.25, y: 0.968, z: 0 });
  assert.ok(up < beside, 'the midline of the crown is a groove');
});

test('a memory lands beside the topic it mentions; one of two topics lands between them', async () => {
  const { layoutCortex } = await loadLayout();
  const graph = graphOf({
    entities: [entity('a', 5), entity('b', 5), entity('c', 5)],
    memories: [memory('m1'), memory('m2'), memory('m3')],
    links: [
      { memoryId: 'm1', entityId: 'a' },
      { memoryId: 'm2', entityId: 'b' },
      { memoryId: 'm3', entityId: 'a' },
      { memoryId: 'm3', entityId: 'b' },
    ],
  });
  const layout = layoutCortex(graph);
  const core = Object.fromEntries(layout.entities.map((item) => [item.id, item.dir]));
  const neuron = Object.fromEntries(layout.memories.map((item) => [item.id, item.dir]));

  assert.ok(angle(neuron.m1, core.a) < angle(neuron.m1, core.b), 'm1 is nearer a than b');
  assert.ok(angle(neuron.m2, core.b) < angle(neuron.m2, core.a), 'm2 is nearer b than a');
  const toA = angle(neuron.m3, core.a);
  const toB = angle(neuron.m3, core.b);
  const toC = angle(neuron.m3, core.c);
  assert.ok(toA < toC && toB < toC, 'm3 sits between a and b, away from c');
  // Everything with a topic sits on the surface, not inside it.
  for (const item of layout.memories) assert.equal(item.deep, false);
});

test('a memory that mentions nothing still sits on the surface, in the region of its kind', async () => {
  const { layoutCortex, brainRadius, SURFACE } = await loadLayout();
  const graph = graphOf({
    entities: [entity('a', 3)],
    memories: [memory('anchored'), memory('lonely', { kind: 'preference' }), memory('related')],
    links: [{ memoryId: 'anchored', entityId: 'a' }],
    edges: [
      {
        id: 'e1',
        owner: 'assistant',
        srcId: 'related',
        dstId: 'anchored',
        relation: 'refines',
        weight: 0.5,
        origin: 'sleep',
        createdAt: NOW,
      },
    ],
  });
  const layout = layoutCortex(graph);
  const byId = Object.fromEntries(layout.memories.map((item) => [item.id, item]));

  // Nothing floats inside any more: a body inside the tissue was drawn
  // through it and read as a body that had gone through it.
  for (const item of layout.memories) {
    assert.equal(item.deep, false);
    assert.ok(Math.abs(length(item.position) / brainRadius(item.dir) - SURFACE.memory) < 1e-6, item.id + ' is on the surface');
  }
  assert.equal(byId.lonely.region, 'prefrontal');
  assert.ok(byId.lonely.dir.z > 0.3, 'a lonely preference goes to the forehead: z=' + byId.lonely.dir.z);
  assert.equal(byId.related.deep, false, 'a relation places a memory beside what it refines');
});

test('a sleeping memory sinks into the surface; an awake one sits proud of it', async () => {
  const { layoutCortex, brainRadius, SURFACE } = await loadLayout();
  const graph = graphOf({
    entities: [entity('a', 2)],
    memories: [memory('awake'), memory('asleep', { dormantAt: NOW - 1000 })],
    links: [
      { memoryId: 'awake', entityId: 'a' },
      { memoryId: 'asleep', entityId: 'a' },
    ],
  });
  assert.ok(SURFACE.dormant < SURFACE.memory, 'sleeping sits lower than awake');
  assert.ok(SURFACE.dormant >= 1, 'but never inside the tissue, where the surface would hide it');
  const layout = layoutCortex(graph);
  for (const item of layout.memories) {
    const ratio = length(item.position) / brainRadius(item.dir);
    if (item.id === 'asleep') assert.ok(Math.abs(ratio - SURFACE.dormant) < 1e-6);
    else assert.ok(Math.abs(ratio - SURFACE.memory) < 1e-6);
  }
});

test('positions are stable: the same graph lays out the same way, and a filter moves no topic', async () => {
  const { layoutCortex } = await loadLayout();
  const entities = [entity('a', 4), entity('b', 2), entity('c', 1)];
  const full = graphOf({
    entities,
    memories: [memory('m1'), memory('m2')],
    links: [
      { memoryId: 'm1', entityId: 'a' },
      { memoryId: 'm2', entityId: 'b' },
    ],
  });
  const first = layoutCortex(full);
  const second = layoutCortex(full);
  assert.deepEqual(first, second);

  // Fewer memories, same topics: the topics stay where they were, so a
  // filter does not shuffle the whole brain under the pointer.
  const filtered = graphOf({ entities, memories: [memory('m1')], links: [{ memoryId: 'm1', entityId: 'a' }] });
  const third = layoutCortex(filtered);
  const before = Object.fromEntries(first.entities.map((item) => [item.id, item.dir]));
  for (const item of third.entities) {
    assert.ok(angle(item.dir, before[item.id]) < 0.35, 'topic ' + item.id + ' stayed in its region');
  }
});

test('neurons keep their distance from each other and from the cores', async () => {
  const { layoutCortex } = await loadLayout();
  const memories = Array.from({ length: 40 }, (_, index) => memory('m' + index));
  const graph = graphOf({
    entities: [entity('hub', 40)],
    memories,
    links: memories.map((item) => ({ memoryId: item.id, entityId: 'hub' })),
  });
  const layout = layoutCortex(graph);
  const hub = layout.entities[0].dir;
  let closest = Infinity;
  for (let i = 0; i < layout.memories.length; i++) {
    assert.ok(angle(layout.memories[i].dir, hub) > 0.05, 'a neuron does not sit on the core');
    for (let j = i + 1; j < layout.memories.length; j++) {
      closest = Math.min(closest, angle(layout.memories[i].dir, layout.memories[j].dir));
    }
  }
  assert.ok(closest > 0.03, 'no two neurons share a spot: ' + closest);
});

test('a fibre lies on the cortex from end to end, and is not a perfect circle', async () => {
  const { fibrePath, brainRadius, pathPoint } = await loadLayout();
  const unit = (v) => ({ x: v.x / length(v), y: v.y / length(v), z: v.z / length(v) });
  const on = (dir, lift) => ({ x: dir.x * brainRadius(dir) * lift, y: dir.y * brainRadius(dir) * lift, z: dir.z * brainRadius(dir) * lift });
  const a = on(unit({ x: 1, y: 0.1, z: 0.2 }), 1.02);
  const b = on(unit({ x: -0.4, y: 0.6, z: 0.5 }), 1.02);
  const path = fibrePath(a, b, 0.012, 24, 'f1');
  assert.equal(path.length, 25 * 3);
  // The buffer is float32; the bodies are float64.
  const near = (got, want, what) => assert.ok(Math.hypot(got.x - want.x, got.y - want.y, got.z - want.z) < 1e-6, what);
  near({ x: path[0], y: path[1], z: path[2] }, a, 'starts on the first body');
  near({ x: path[72], y: path[73], z: path[74] }, b, 'ends on the second');

  let offPlane = 0;
  const axis = unit({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  });
  for (let index = 1; index < 24; index++) {
    const p = { x: path[index * 3], y: path[index * 3 + 1], z: path[index * 3 + 2] };
    const dir = unit(p);
    const height = length(p) / brainRadius(dir);
    assert.ok(height > 1.0 && height < 1.08, 'point ' + index + ' hugs the surface: ' + height);
    offPlane = Math.max(offPlane, Math.abs(dir.x * axis.x + dir.y * axis.y + dir.z * axis.z));
  }
  assert.ok(offPlane > 0.005, 'the fibre wanders off the great circle: ' + offPlane);

  // Sampling the path lands on its vertices and between them.
  const out = { x: 0, y: 0, z: 0 };
  near(pathPoint(path, 0, out), a, 'sampling at 0 is the start');
  near(pathPoint(path, 1, out), b, 'sampling at 1 is the end');
});

test('topics go to the region their memories belong to', async () => {
  const { layoutCortex } = await loadLayout();
  const kinds = { likes: 'preference', knows: 'fact', happened: 'event', plans: 'project' };
  const memories = Object.entries(kinds).map(([topic, kind]) => memory('m-' + topic, { kind }));
  const graph = graphOf({
    entities: [...Object.keys(kinds).map((id) => entity(id, 1)), entity('jonas-person', 1)],
    memories: [...memories, memory('m-person', { kind: 'fact' })],
    links: [
      ...Object.keys(kinds).map((topic) => ({ memoryId: 'm-' + topic, entityId: topic })),
      { memoryId: 'm-person', entityId: 'jonas-person' },
    ],
  });
  graph.entities[4].kind = 'person';
  const layout = layoutCortex(graph);
  const by = Object.fromEntries(layout.entities.map((item) => [item.id, item]));

  assert.equal(by.likes.region, 'prefrontal');
  assert.ok(by.likes.dir.z > 0.5, 'a topic of preferences sits at the forehead: z=' + by.likes.dir.z);
  assert.equal(by.knows.region, 'lateral-temporal');
  assert.ok(Math.abs(by.knows.dir.x) > 0.6, 'a topic of facts sits on the side of the temporal lobe');
  assert.equal(by.happened.region, 'medial-temporal');
  assert.ok(by.happened.dir.y < -0.2, 'a topic of events sits on the underside');
  assert.equal(by.plans.region, 'parietal');
  assert.ok(by.plans.dir.y > 0.4, 'a topic of projects sits up on the crown');
  assert.equal(by['jonas-person'].region, 'fusiform', 'a person has a place of their own whatever the memories say');

  // The memories follow: the event sits below the fact even though both
  // have a topic of their own.
  const mem = Object.fromEntries(layout.memories.map((item) => [item.id, item]));
  assert.equal(mem['m-happened'].region, 'medial-temporal');
  assert.ok(mem['m-happened'].dir.y < mem['m-knows'].dir.y);
});

test('a fibre from a deep memory dives into the interior at that end only', async () => {
  const { fibrePath, brainRadius } = await loadLayout();
  const unit = (v) => ({ x: v.x / length(v), y: v.y / length(v), z: v.z / length(v) });
  const dirA = unit({ x: 0.2, y: 0.5, z: 0.8 });
  const dirB = unit({ x: 0.6, y: 0.4, z: 0.3 });
  const deep = { x: dirA.x * 0.6, y: dirA.y * 0.6, z: dirA.z * 0.6 };
  const surface = { x: dirB.x * brainRadius(dirB) * 1.02, y: dirB.y * brainRadius(dirB) * 1.02, z: dirB.z * brainRadius(dirB) * 1.02 };
  const path = fibrePath(deep, surface, 0.012, 20, 'f2');
  const heightAt = (index) => {
    const p = { x: path[index * 3], y: path[index * 3 + 1], z: path[index * 3 + 2] };
    return length(p) / brainRadius(unit(p));
  };
  assert.ok(heightAt(2) < 0.95, 'near the deep end it is still inside');
  assert.ok(heightAt(12) > 1.0, 'by the middle it has surfaced');
  assert.ok(heightAt(19) > 1.0, 'and it stays on the surface to the far end');
});


test('camera fit contains the brain in portrait, landscape and ultrawide viewports', async () => {
  const { cortexCameraDistance } = await loadLayout();
  const radius = 1.45, fov = 38;
  for (const [width, height] of [[2560, 900], [1920, 840], [1100, 540], [700, 180], [360, 500], [280, 650]]) {
    const aspect = width / height;
    const distance = cortexCameraDistance(radius, aspect, fov);
    const halfAngle = Math.asin(radius / distance);
    assert.ok(halfAngle < fov * Math.PI / 360, 'vertical fit: ' + width + 'x' + height);
    assert.ok(halfAngle < Math.atan(Math.tan(fov * Math.PI / 360) * aspect), 'horizontal fit: ' + width + 'x' + height);
  }
});

test('the surface atlas covers triangle interiors, both poles and the longitude seam', async () => {
  const { BoxGeometry, SphereGeometry, Vector3 } = await import('three');
  const { surfaceFromGeometry } = await loadLayout('scene.ts');
  for (const geometry of [new BoxGeometry(2, 2, 2), new SphereGeometry(1, 64, 32)]) {
    const surface = surfaceFromGeometry(geometry);
    const directions = [new Vector3(0, 1, 0), new Vector3(0, -1, 0), new Vector3(-1, 0, 1e-8), new Vector3(-1, 0, -1e-8)];
    for (let i = 0; i < 500; i++) {
      const y = 1 - 2 * (i + 0.5) / 500, phi = i * 2.39996323;
      directions.push(new Vector3(Math.sqrt(1 - y * y) * Math.cos(phi), y, Math.sqrt(1 - y * y) * Math.sin(phi)));
    }
    for (const dir of directions) {
      const expected = geometry.type === 'BoxGeometry' ? 1 / Math.max(Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)) : 1;
      const radius = surface(dir);
      assert.ok(radius >= expected - 0.007, geometry.type + ' ' + dir.toArray() + ': ' + radius + ' < ' + expected);
      assert.ok(radius <= expected + 0.13, 'surface stays close to the model: ' + radius + ' > ' + expected);
    }
    geometry.dispose();
  }
});
