/**
 * SVG line art to pen strokes, for the draw tool.
 *
 * A model sketches far better in SVG than in hand-computed coordinates:
 * curves, arcs and transforms are its native vocabulary. This turns the
 * geometry of such a document into polylines in output (screen) space:
 * every shape is outlined unless its stroke is "none", filled shapes can be
 * shaded with hatching, and clipStrokes cuts everything to the drawing area
 * so a stroke can never wander onto the app's toolbar. Colours, gradients, text
 * and effects are ignored; the pen colour is whatever the app has selected.
 */

/** Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Hatch {
  /** Distance between hatch lines, in output units. */
  spacing: number;
  /** Degrees; 0 is horizontal. */
  angle: number;
  /** A second pass at right angles. */
  cross: boolean;
}

export interface SketchOptions {
  /** Viewport space to output space. */
  transform: Matrix;
  /** Maximum distance between a curve and its polyline, in output units. */
  tolerance: number;
  /** Shade filled shapes; without it fills are ignored. */
  hatch?: Hatch;
}

/** A polyline as flat x, y pairs. */
export type Stroke = number[];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m after n: apply n first, then m. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function numbers(text: string): number[] {
  return (text.match(NUMBER) ?? []).map(Number);
}

export function parseTransform(text: string): Matrix {
  let result = IDENTITY;
  for (const [, name, args] of text.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g)) {
    const v = numbers(args!);
    let m: Matrix;
    switch (name) {
      case 'matrix':
        m = v.length >= 6 ? [v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!] : IDENTITY;
        break;
      case 'translate':
        m = [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0];
        break;
      case 'scale':
        m = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const a = ((v[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [v[1] ?? 0, v[2] ?? 0];
        const cos = Math.cos(a), sin = Math.sin(a);
        m = [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
        break;
      }
      case 'skewX':
        m = [1, 0, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      default:
        m = [1, Math.tan(((v[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    result = multiply(result, m);
  }
  return result;
}

/* ---------------------------------- paths --------------------------------- */

/** A straight segment to [x, y], or a cubic [x1, y1, x2, y2, x, y]. */
type Segment = [number, number] | [number, number, number, number, number, number];

interface Subpath {
  start: [number, number];
  segments: Segment[];
  closed: boolean;
}

/** Character scanner, because arc flags may be written without separators ("a1 1 0 011 1"). */
class Scanner {
  #at = 0;
  constructor(readonly text: string) {}

  #skip(): void {
    while (this.#at < this.text.length && /[\s,]/.test(this.text[this.#at]!)) this.#at++;
  }

  command(): string | null {
    this.#skip();
    const c = this.text[this.#at];
    if (c && /[MmLlHhVvCcSsQqTtAaZz]/.test(c)) {
      this.#at++;
      return c;
    }
    return null;
  }

  hasNumber(): boolean {
    this.#skip();
    return /[+\-.\d]/.test(this.text[this.#at] ?? '');
  }

  number(): number {
    this.#skip();
    const pattern = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
    pattern.lastIndex = this.#at;
    const match = pattern.exec(this.text);
    if (!match) throw new Error('Bad number in path data near "' + this.text.slice(this.#at, this.#at + 12) + '".');
    this.#at = pattern.lastIndex;
    return Number(match[0]);
  }

  flag(): boolean {
    this.#skip();
    const c = this.text[this.#at++];
    if (c !== '0' && c !== '1') throw new Error('Bad arc flag in path data.');
    return c === '1';
  }

  get done(): boolean {
    this.#skip();
    return this.#at >= this.text.length;
  }
}

/** Endpoint arc (SVG F.6.5) as cubic segments, each spanning at most 90 degrees. */
function arcToCubics(x0: number, y0: number, rx: number, ry: number, rotation: number, large: boolean, sweep: boolean, x: number, y: number): Segment[] {
  if (rx === 0 || ry === 0) return [[x, y]];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry, cy1 = (-k * ry * x1) / rx;
  const cx = cos * cx1 - sin * cy1 + (x0 + x) / 2, cy = sin * cx1 + cos * cy1 + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const pieces = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / pieces;
  const t = (4 / 3) * Math.tan(step / 4);
  const point = (a: number): [number, number] => [
    cx + rx * Math.cos(a) * cos - ry * Math.sin(a) * sin,
    cy + rx * Math.cos(a) * sin + ry * Math.sin(a) * cos,
  ];
  const derivative = (a: number): [number, number] => [
    -rx * Math.sin(a) * cos - ry * Math.cos(a) * sin,
    -rx * Math.sin(a) * sin + ry * Math.cos(a) * cos,
  ];
  const segments: [number, number, number, number, number, number][] = [];
  for (let i = 0; i < pieces; i++) {
    const a0 = theta + i * step, a1 = a0 + step;
    const [px0, py0] = point(a0), [px1, py1] = point(a1);
    const [dx0, dy0] = derivative(a0), [dx1, dy1] = derivative(a1);
    segments.push([px0 + t * dx0, py0 + t * dy0, px1 - t * dx1, py1 - t * dy1, px1, py1]);
  }
  // Land exactly on the requested endpoint, whatever the rounding.
  const last = segments[segments.length - 1]!;
  last[4] = x;
  last[5] = y;
  return segments;
}

export function parsePath(d: string): Subpath[] {
  const scan = new Scanner(d);
  const paths: Subpath[] = [];
  let current: Subpath | null = null;
  let x = 0, y = 0, startX = 0, startY = 0;
  // The last cubic's second / the last quadratic's control point, for S and T reflection.
  let lastC: [number, number] | null = null;
  let lastQ: [number, number] | null = null;
  let command: string | null = null;
  const begin = (): Subpath => {
    if (!current) {
      current = { start: [x, y], segments: [], closed: false };
      paths.push(current);
    }
    return current;
  };
  while (!scan.done) {
    const next = scan.command();
    if (next) command = next;
    else if (!command || !scan.hasNumber()) throw new Error('Path data must start with a command.');
    const relative: boolean = command === command.toLowerCase();
    const ox = relative ? x : 0, oy = relative ? y : 0;
    const upper: string = command.toUpperCase();
    let c: [number, number] | null = null;
    let q: [number, number] | null = null;
    switch (upper) {
      case 'M':
        x = ox + scan.number();
        y = oy + scan.number();
        startX = x;
        startY = y;
        current = null;
        begin();
        // Further pairs after a moveto are implicit linetos.
        command = relative ? 'l' : 'L';
        break;
      case 'L':
        x = ox + scan.number();
        y = oy + scan.number();
        begin().segments.push([x, y]);
        break;
      case 'H':
        x = ox + scan.number();
        begin().segments.push([x, y]);
        break;
      case 'V':
        y = oy + scan.number();
        begin().segments.push([x, y]);
        break;
      case 'C':
      case 'S': {
        const x1: number = upper === 'C' ? ox + scan.number() : lastC ? 2 * x - lastC[0] : x;
        const y1: number = upper === 'C' ? oy + scan.number() : lastC ? 2 * y - lastC[1] : y;
        const x2 = ox + scan.number(), y2 = oy + scan.number();
        const ex = ox + scan.number(), ey = oy + scan.number();
        begin().segments.push([x1, y1, x2, y2, ex, ey]);
        c = [x2, y2];
        x = ex;
        y = ey;
        break;
      }
      case 'Q':
      case 'T': {
        const qx: number = upper === 'Q' ? ox + scan.number() : lastQ ? 2 * x - lastQ[0] : x;
        const qy: number = upper === 'Q' ? oy + scan.number() : lastQ ? 2 * y - lastQ[1] : y;
        const ex = ox + scan.number(), ey = oy + scan.number();
        // A quadratic is the cubic with controls two thirds of the way to its one control point.
        begin().segments.push([x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey]);
        q = [qx, qy];
        x = ex;
        y = ey;
        break;
      }
      case 'A': {
        const rx = scan.number(), ry = scan.number(), rotation = scan.number();
        const large = scan.flag(), sweep = scan.flag();
        const ex = ox + scan.number(), ey = oy + scan.number();
        begin().segments.push(...arcToCubics(x, y, rx, ry, rotation, large, sweep, ex, ey));
        x = ex;
        y = ey;
        break;
      }
      case 'Z': {
        // begin() assigns current through a closure, which narrowing cannot see.
        const open = current as Subpath | null;
        if (open) open.closed = true;
        x = startX;
        y = startY;
        current = null;
        break;
      }
    }
    lastC = c;
    lastQ = q;
  }
  return paths.filter((path) => path.segments.length > 0);
}

/* ------------------------------ basic shapes ------------------------------ */

function attribute(attrs: Record<string, string>, name: string, fallback = 0): number {
  const value = parseFloat(attrs[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

/** Every basic shape as path data, so one flattener serves all. */
function shapePath(tag: string, attrs: Record<string, string>): string | null {
  const n = (name: string, fallback = 0): number => attribute(attrs, name, fallback);
  switch (tag) {
    case 'path':
      return attrs.d ?? null;
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const v = numbers(attrs.points ?? '');
      if (v.length < 4) return null;
      let d = `M${v[0]} ${v[1]}`;
      for (let i = 2; i + 1 < v.length; i += 2) d += `L${v[i]} ${v[i + 1]}`;
      return tag === 'polygon' ? d + 'Z' : d;
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy');
      const rx = tag === 'circle' ? n('r') : n('rx', n('ry'));
      const ry = tag === 'circle' ? rx : n('ry', rx);
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
    }
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height');
      if (w <= 0 || h <= 0) return null;
      const rx = Math.min(w / 2, attrs.rx !== undefined ? n('rx') : n('ry'));
      const ry = Math.min(h / 2, attrs.ry !== undefined ? n('ry') : n('rx'));
      if (rx <= 0 || ry <= 0) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
        `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
        `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    default:
      return null;
  }
}

/* ------------------------------- flattening ------------------------------- */

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Subdivide until both controls lie within tolerance of the chord. */
function flattenCubic(out: Stroke, p: number[], tolerance: number, depth: number): void {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = p as [number, number, number, number, number, number, number, number];
  const dx = x3 - x0, dy = y3 - y0;
  const length = Math.hypot(dx, dy);
  const d1 = length > 1e-9 ? Math.abs((x1 - x3) * dy - (y1 - y3) * dx) / length : Math.hypot(x1 - x0, y1 - y0);
  const d2 = length > 1e-9 ? Math.abs((x2 - x3) * dy - (y2 - y3) * dx) / length : Math.hypot(x2 - x0, y2 - y0);
  if (depth >= 16 || Math.max(d1, d2) <= tolerance) {
    out.push(x3, y3);
    return;
  }
  // de Casteljau at t = 0.5.
  const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2, bx = (x1 + x2) / 2, by = (y1 + y2) / 2, cx = (x2 + x3) / 2, cy = (y2 + y3) / 2;
  const abx = (ax + bx) / 2, aby = (ay + by) / 2, bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
  const mx = (abx + bcx) / 2, my = (aby + bcy) / 2;
  flattenCubic(out, [x0, y0, ax, ay, abx, aby, mx, my], tolerance, depth + 1);
  flattenCubic(out, [mx, my, bcx, bcy, cx, cy, x3, y3], tolerance, depth + 1);
}

/** A subpath in output space; closed ones end on their start. Affine maps keep cubics cubic. */
function flatten(path: Subpath, m: Matrix, tolerance: number): Stroke {
  const [sx, sy] = apply(m, path.start[0], path.start[1]);
  const out: Stroke = [sx, sy];
  for (const segment of path.segments) {
    if (segment.length === 2) {
      out.push(...apply(m, segment[0], segment[1]));
    } else {
      const [x1, y1] = apply(m, segment[0], segment[1]);
      const [x2, y2] = apply(m, segment[2], segment[3]);
      const [x3, y3] = apply(m, segment[4], segment[5]);
      flattenCubic(out, [out[out.length - 2]!, out[out.length - 1]!, x1, y1, x2, y2, x3, y3], tolerance, 0);
    }
  }
  if (path.closed && (out[out.length - 2] !== sx || out[out.length - 1] !== sy)) out.push(sx, sy);
  return out;
}

/* -------------------------------- hatching -------------------------------- */

/**
 * Even-odd scanline hatching of closed polylines. Consecutive lines that each
 * cross the shape once are joined into a zigzag, so shading costs few pen
 * lifts, but only up to a length of 50 line spacings: short strokes shade like
 * a hand does, and stamp brushes (Paint's watercolour keeps only the tail of a
 * very long stroke) render them whole.
 */
export function hatchPolygons(polygons: Stroke[], spacing: number, degrees: number): Stroke[] {
  const budget = Math.max(300, 50 * spacing);
  const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  // Rotate into a frame where hatch lines are horizontal.
  const rotated = polygons.map((p) => {
    const r: number[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) r.push(p[i]! * cos + p[i + 1]! * sin, -p[i]! * sin + p[i + 1]! * cos);
    return r;
  });
  let minV = Infinity, maxV = -Infinity;
  for (const p of rotated) for (let i = 1; i < p.length; i += 2) { minV = Math.min(minV, p[i]!); maxV = Math.max(maxV, p[i]!); }
  const back = (u: number, v: number): [number, number] => [u * cos - v * sin, u * sin + v * cos];
  const strokes: Stroke[] = [];
  let zigzag: Stroke | null = null;
  // Where the zigzag ends along the hatch direction, whether the next pass runs backwards, and its length.
  let lastU = 0;
  let flip = false;
  let length = 0;
  for (let v = minV + spacing / 2; v < maxV; v += spacing) {
    const xs: number[] = [];
    for (const p of rotated) {
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const ax = p[2 * i]!, ay = p[2 * i + 1]!;
        const bx = p[(2 * i + 2) % p.length]!, by = p[(2 * i + 3) % p.length]!;
        // Half-open rule: a vertex on the line counts once.
        if ((ay <= v && by > v) || (by <= v && ay > v)) xs.push(ax + ((v - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((m, n) => m - n);
    if (xs.length === 2 && zigzag) {
      const [from, to] = flip ? [xs[1]!, xs[0]!] : [xs[0]!, xs[1]!];
      // Only join when the connector hugs the edge; a far jump would cross open space.
      if (Math.abs(lastU - from) <= spacing * 3 && length + Math.abs(to - from) <= budget) {
        zigzag.push(...back(from, v), ...back(to, v));
        length += Math.abs(to - from) + spacing;
        lastU = to;
        flip = !flip;
        continue;
      }
    }
    zigzag = null;
    for (let i = 0; i + 1 < xs.length; i += 2) strokes.push([...back(xs[i]!, v), ...back(xs[i + 1]!, v)]);
    if (xs.length === 2) {
      zigzag = strokes[strokes.length - 1]!;
      length = xs[1]! - xs[0]!;
      lastU = xs[1]!;
      flip = true;
    }
  }
  return strokes;
}

/* -------------------------------- clipping -------------------------------- */

/** Cut polylines at the rectangle's edge (Liang-Barsky per segment); dots inside survive. */
export function clipStrokes(strokes: Stroke[], clip: Rect): Stroke[] {
  const x0 = clip.x, y0 = clip.y, x1 = clip.x + clip.width, y1 = clip.y + clip.height;
  const inside = (x: number, y: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const out: Stroke[] = [];
  for (const stroke of strokes) {
    if (stroke.length === 2) {
      if (inside(stroke[0]!, stroke[1]!)) out.push(stroke);
      continue;
    }
    let current: Stroke | null = null;
    for (let i = 0; i + 3 < stroke.length; i += 2) {
      const ax = stroke[i]!, ay = stroke[i + 1]!, bx = stroke[i + 2]!, by = stroke[i + 3]!;
      const dx = bx - ax, dy = by - ay;
      let t0 = 0, t1 = 1;
      let visible = true;
      for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]] as [number, number][]) {
        if (p === 0) {
          if (q < 0) visible = false;
        } else {
          const r = q / p;
          if (p < 0) t0 = Math.max(t0, r);
          else t1 = Math.min(t1, r);
        }
      }
      if (!visible || t0 > t1) {
        current = null;
        continue;
      }
      const sx = ax + t0 * dx, sy = ay + t0 * dy, ex = ax + t1 * dx, ey = ay + t1 * dy;
      if (!current || t0 > 0) {
        current = [sx, sy];
        out.push(current);
      }
      current.push(ex, ey);
      if (t1 < 1) current = null;
    }
  }
  return out;
}

/* ---------------------------------- SVG ----------------------------------- */

const SKIPPED = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker', 'style', 'script', 'text', 'title', 'desc', 'metadata', 'lineargradient', 'radialgradient', 'filter', 'foreignobject']);

interface Scope {
  matrix: Matrix;
  fill: string;
  stroke: string;
  skip: boolean;
}

function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, double, single] of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[name!] = double ?? single ?? '';
  // Inline style wins over presentation attributes, as in SVG.
  for (const rule of (attrs.style ?? '').split(';')) {
    const [key, value] = rule.split(':').map((part) => part.trim());
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

/** The root viewBox as [minX, minY, width, height], from viewBox or width/height. */
export function svgViewBox(svg: string): [number, number, number, number] {
  const root = /<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/i.exec(svg);
  if (!root) throw new Error('No <svg> element found.');
  const attrs = attributes(root[1]!);
  const box = numbers(attrs.viewBox ?? '');
  if (box.length === 4 && box[2]! > 0 && box[3]! > 0) return box as [number, number, number, number];
  const width = attribute(attrs, 'width'), height = attribute(attrs, 'height');
  if (width > 0 && height > 0) return [0, 0, width, height];
  throw new Error('The <svg> element needs a viewBox (or width and height).');
}

/** The strokes an SVG document draws, in output space, in document order (hatching before outline). */
export function svgStrokes(svg: string, options: SketchOptions): Stroke[] {
  const text = svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const stack: Scope[] = [{ matrix: options.transform, fill: 'black', stroke: 'currentColor', skip: false }];
  const strokes: Stroke[] = [];
  let rootSeen = false;
  for (const [, closing, rawTag, body, selfClosing] of text.matchAll(/<\s*(\/)?\s*([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?\s*>/g)) {
    const tag = rawTag!.toLowerCase().replace(/^svg:/, '');
    const scope = stack[stack.length - 1]!;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = attributes(body!);
    let matrix = scope.matrix;
    if (tag === 'svg' && rootSeen) matrix = multiply(matrix, [1, 0, 0, 1, attribute(attrs, 'x'), attribute(attrs, 'y')]);
    if (tag === 'svg') rootSeen = true;
    if (attrs.transform) matrix = multiply(matrix, parseTransform(attrs.transform));
    const next: Scope = {
      matrix,
      fill: attrs.fill ?? scope.fill,
      stroke: attrs.stroke ?? scope.stroke,
      skip: scope.skip || SKIPPED.has(tag) || attrs.display === 'none' || attrs.visibility === 'hidden',
    };
    if (!selfClosing) stack.push(next);
    if (next.skip) continue;
    const d = shapePath(tag, attrs);
    if (!d) continue;
    // A line or polyline has no interior to shade.
    const paths = parsePath(d).map((path) => flatten(path, matrix, options.tolerance));
    if (options.hatch && next.fill !== 'none' && tag !== 'line' && tag !== 'polyline') {
      const polygons = paths.filter((p) => p.length >= 6);
      strokes.push(...hatchPolygons(polygons, options.hatch.spacing, options.hatch.angle));
      if (options.hatch.cross) strokes.push(...hatchPolygons(polygons, options.hatch.spacing, options.hatch.angle + 90));
    }
    if (next.stroke !== 'none') strokes.push(...paths);
  }
  return strokes;
}

/** Map a viewBox into an area, preserving aspect ratio and centring (SVG's xMidYMid meet). */
export function fitViewBox(box: [number, number, number, number], area: Rect): Matrix {
  const scale = Math.min(area.width / box[2], area.height / box[3]);
  const ox = area.x + (area.width - box[2] * scale) / 2 - box[0] * scale;
  const oy = area.y + (area.height - box[3] * scale) / 2 - box[1] * scale;
  return [scale, 0, 0, scale, ox, oy];
}
