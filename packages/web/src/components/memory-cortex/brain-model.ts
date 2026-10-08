import * as THREE from 'three';

import type { Surface } from './layout';

/**
 * The loaded brain model, made ours (`prepareModel`), and the radial table
 * of its outer surface that everything is laid out on (`surfaceFromGeometry`).
 * Pure geometry: no renderer, no DOM.
 */

/** Which way the model's forehead points along z; flipped here if the file has it backwards. */
const MODEL_FRONT: 1 | -1 = 1;
/** Half the length the model is scaled to, front to back - the formula's `RZ`. */
const MODEL_LENGTH = 1.22;
/**
 * Below this height (in the scaled model) there is only brainstem: measured
 * on the model, the bands under it hold a few dozen vertices within 0.45 of
 * the axis, the band at it holds the cerebellum's whole width. Its axis
 * sits behind the centre.
 */
const BRAINSTEM_BELOW = -0.8;
const BRAINSTEM_AXIS_Z = -0.35;
/** How far the pressed brainstem is drawn in toward its axis. */
const BRAINSTEM_PINCH = 0.5;

/** A vertex colour is a sulcus when its red is this bright and this much above green and blue. */
const SULCUS_MIN_RED = 0.5;
const SULCUS_RED_DOMINANCE = 1.5;
const SULCUS_FOLD = -1;

const ATLAS_COLS = 256;
const ATLAS_ROWS = 128;
const HOLE_FILL_PASSES = 32;
/** Covers ridges between the samples of this grid; use an exact surface accelerator if much finer geometry is introduced. */
const ATLAS_MARGIN = 1.012;

const NORTH = new THREE.Vector3(0, 1, 0);
const SOUTH = new THREE.Vector3(0, -1, 0);

/**
 * The loaded model, made ours: centred, turned so the forehead points down
 * +z and the crown up +y like the formula's shape, and scaled so the brain
 * is as long as the formula's. Its vertex colours mark the sulci (that is
 * what the model's author painted red); they become the fold attribute the
 * tissue shader darkens, and the fissure attribute stays zero because the
 * real mesh has the real fissure.
 */
export function prepareModel(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.clone();
  centreAndScale(geometry);

  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  pressBrainstem(position);
  geometry.setAttribute('aFold', new THREE.BufferAttribute(foldFromColours(geometry, position.count), 1));
  geometry.setAttribute('aFissure', new THREE.BufferAttribute(new Float32Array(position.count), 1));
  // The pressed base needs normals of its own; the ones that came with the
  // stalk point sideways.
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function centreAndScale(geometry: THREE.BufferGeometry): void {
  if (MODEL_FRONT < 0) geometry.rotateY(Math.PI);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const centre = box.getCenter(new THREE.Vector3());
  geometry.translate(-centre.x, -centre.y, -centre.z);
  const halfLength = (box.max.z - box.min.z) / 2;
  const scale = MODEL_LENGTH / halfLength;
  geometry.scale(scale, scale, scale);
}

/**
 * The brainstem goes. Nothing is laid out on it, and as a thin stalk far
 * from the centre it was where every fibre passing its direction leapt.
 * It is not cut off - that would leave a hole to look into the brain
 * through - but pressed flat up to where the cerebellum begins and drawn
 * in toward its own axis, a small closed base tucked under the cerebellum.
 */
function pressBrainstem(position: THREE.BufferAttribute): void {
  for (let index = 0; index < position.count; index++) {
    if (position.getY(index) >= BRAINSTEM_BELOW) continue;
    position.setXYZ(
      index,
      position.getX(index) * BRAINSTEM_PINCH,
      BRAINSTEM_BELOW,
      BRAINSTEM_AXIS_Z + (position.getZ(index) - BRAINSTEM_AXIS_Z) * BRAINSTEM_PINCH,
    );
  }
  position.needsUpdate = true;
}

function foldFromColours(geometry: THREE.BufferGeometry, vertexCount: number): Float32Array {
  const fold = new Float32Array(vertexCount);
  const colour = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!colour) return fold;
  for (let index = 0; index < vertexCount; index++) {
    const r = colour.getX(index);
    const isSulcus =
      r > SULCUS_MIN_RED && r > colour.getY(index) * SULCUS_RED_DOMINANCE && r > colour.getZ(index) * SULCUS_RED_DOMINANCE;
    fold[index] = isSulcus ? SULCUS_FOLD : 0;
  }
  return fold;
}

/**
 * Bake the outer triangle intersections into a radial atlas once at load.
 * Sampling vertices alone leaves holes over broad triangles and misses the base.
 * The grid is a conservative envelope, including the compressed brainstem.
 */
export function surfaceFromGeometry(geometry: THREE.BufferGeometry): Surface {
  const measured = fillHoles(bakeTriangles(geometry));
  return radialSampler(upperEnvelope(measured));
}

/** Every cell of the atlas as a unit direction, row by row from the north pole. */
function cellDirections(): THREE.Vector3[] {
  const directions: THREE.Vector3[] = [];
  for (let row = 0; row < ATLAS_ROWS; row++) {
    const phi = ((row + 0.5) / ATLAS_ROWS) * Math.PI;
    for (let col = 0; col < ATLAS_COLS; col++) {
      const theta = ((col + 0.5) / ATLAS_COLS - 0.5) * Math.PI * 2;
      directions.push(new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)));
    }
  }
  return directions;
}

/** The farthest hit of each cell's ray over all triangles; zero where nothing was hit. */
function bakeTriangles(geometry: THREE.BufferGeometry): Float32Array {
  const table = new Float32Array(ATLAS_COLS * ATLAS_ROWS);
  const directions = cellDirections();
  const position = geometry.getAttribute('position');
  const indices = geometry.index;
  const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const uv = vertices.map(() => new THREE.Vector2());
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const hitsTriangle = (direction: THREE.Vector3): boolean => {
    ray.direction.copy(direction);
    return ray.intersectTriangle(vertices[0]!, vertices[1]!, vertices[2]!, false, hit) !== null;
  };

  for (let i = 0, count = indices?.count ?? position.count; i < count; i += 3) {
    for (let j = 0; j < 3; j++) {
      const p = vertices[j]!.fromBufferAttribute(position, indices ? indices.getX(i + j) : i + j);
      uv[j]!.set(
        Math.atan2(p.z, p.x) / (2 * Math.PI) + 0.5,
        Math.acos(THREE.MathUtils.clamp(p.y / p.length(), -1, 1)) / Math.PI,
      );
      if (j > 0) uv[j]!.x -= Math.round(uv[j]!.x - uv[0]!.x);
    }
    const north = hitsTriangle(NORTH);
    const south = hitsTriangle(SOUTH);
    const [minU, maxU] = extent(uv, 'x');
    const [minV, maxV] = latitudeExtent(vertices, uv, hit);
    const minCol = north || south ? 0 : Math.floor(minU * ATLAS_COLS - 0.5);
    const maxCol = north || south ? ATLAS_COLS - 1 : Math.ceil(maxU * ATLAS_COLS - 0.5);
    const minRow = north ? 0 : Math.max(0, Math.floor(minV * ATLAS_ROWS - 0.5));
    const maxRow = south ? ATLAS_ROWS - 1 : Math.min(ATLAS_ROWS - 1, Math.ceil(maxV * ATLAS_ROWS - 0.5));
    for (let row = minRow; row <= maxRow; row++) {
      for (let col = minCol; col <= maxCol; col++) {
        const at = row * ATLAS_COLS + (((col % ATLAS_COLS) + ATLAS_COLS) % ATLAS_COLS);
        if (hitsTriangle(directions[at]!)) table[at] = Math.max(table[at]!, hit.length());
      }
    }
  }
  return table;
}

function extent(points: THREE.Vector2[], axis: 'x' | 'y'): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    min = Math.min(min, point[axis]);
    max = Math.max(max, point[axis]);
  }
  return [min, max];
}

/** Latitude extrema can lie inside an edge, well beyond its endpoints. `scratch` is clobbered. */
function latitudeExtent(
  vertices: THREE.Vector3[],
  uv: THREE.Vector2[],
  scratch: THREE.Vector3,
): [number, number] {
  let [minV, maxV] = extent(uv, 'y');
  const edge = new THREE.Vector3();
  for (let j = 0; j < 3; j++) {
    const a = vertices[j]!;
    edge.subVectors(vertices[(j + 1) % 3]!, a);
    const ad = a.dot(edge);
    const t = (a.y * ad - edge.y * a.lengthSq()) / (edge.y * ad - a.y * edge.lengthSq());
    if (t > 0 && t < 1) {
      scratch.copy(a).addScaledVector(edge, t).normalize();
      const v = Math.acos(THREE.MathUtils.clamp(scratch.y, -1, 1)) / Math.PI;
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
  }
  return [minV, maxV];
}

/** Fill only holes, from their measured neighbours; keep the measured folds instead of blurring away every groove. */
function fillHoles(measured: Float32Array): Float32Array {
  const neighbours = [[-1, 0], [1, 0], [0, -1], [0, 1]] as const;
  let table = measured;
  for (let pass = 0; pass < HOLE_FILL_PASSES; pass++) {
    const filled = table.slice();
    let holes = 0;
    for (let row = 0; row < ATLAS_ROWS; row++) {
      for (let col = 0; col < ATLAS_COLS; col++) {
        const at = row * ATLAS_COLS + col;
        if (table[at]! > 0) continue;
        let sum = 0;
        let count = 0;
        for (const [dr, dc] of neighbours) {
          const r = row + dr;
          if (r < 0 || r >= ATLAS_ROWS) continue;
          const value = table[r * ATLAS_COLS + ((col + dc + ATLAS_COLS) % ATLAS_COLS)]!;
          if (value > 0) {
            sum += value;
            count++;
          }
        }
        if (count) filled[at] = sum / count;
        else holes++;
      }
    }
    table = filled;
    if (!holes) break;
  }
  return table;
}

/** A one-cell upper envelope protects silhouettes and the valleys between samples. */
function upperEnvelope(table: Float32Array): Float32Array {
  const envelope = table.slice();
  for (let row = 0; row < ATLAS_ROWS; row++) {
    for (let col = 0; col < ATLAS_COLS; col++) {
      for (let dr = -1; dr <= 1; dr++) {
        const r = THREE.MathUtils.clamp(row + dr, 0, ATLAS_ROWS - 1);
        for (let dc = -1; dc <= 1; dc++) {
          const at = row * ATLAS_COLS + col;
          envelope[at] = Math.max(envelope[at]!, table[r * ATLAS_COLS + ((col + dc + ATLAS_COLS) % ATLAS_COLS)]!);
        }
      }
    }
  }
  return envelope;
}

/** The surface radius in any direction, bilinearly interpolated from the atlas. */
function radialSampler(table: Float32Array): Surface {
  return (dir) => {
    const u = (Math.atan2(dir.z, dir.x) / (Math.PI * 2) + 0.5) * ATLAS_COLS - 0.5;
    const v = THREE.MathUtils.clamp(
      (Math.acos(THREE.MathUtils.clamp(dir.y, -1, 1)) / Math.PI) * ATLAS_ROWS - 0.5,
      0,
      ATLAS_ROWS - 1,
    );
    const c0 = ((Math.floor(u) % ATLAS_COLS) + ATLAS_COLS) % ATLAS_COLS;
    const c1 = (c0 + 1) % ATLAS_COLS;
    const r0 = Math.floor(v);
    const r1 = Math.min(ATLAS_ROWS - 1, r0 + 1);
    const tu = u - Math.floor(u);
    const tv = v - r0;
    const top = table[r0 * ATLAS_COLS + c0]! * (1 - tu) + table[r0 * ATLAS_COLS + c1]! * tu;
    const bottom = table[r1 * ATLAS_COLS + c0]! * (1 - tu) + table[r1 * ATLAS_COLS + c1]! * tu;
    return (top * (1 - tv) + bottom * tv) * ATLAS_MARGIN;
  };
}
