import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipStrokes, fitViewBox, hatchPolygons, parseTransform, svgStrokes, svgViewBox } from '../dist/computer/sketch.js';

const IDENTITY = [1, 0, 0, 1, 0, 0];
const draw = (body, options = {}) => svgStrokes(`<svg viewBox="0 0 200 200">${body}</svg>`, { transform: IDENTITY, tolerance: 0.25, ...options });
const pairs = (stroke) => Array.from({ length: stroke.length / 2 }, (_, i) => [stroke[2 * i], stroke[2 * i + 1]]);
const near = (actual, expected) => assert.deepEqual(actual.map((v) => Math.round(v * 1000) / 1000 + 0), expected);

test('curves flatten within tolerance and closed shapes end where they start', () => {
  const [circle] = draw('<circle cx="100" cy="100" r="50"/>');
  for (const [x, y] of pairs(circle)) assert.ok(Math.abs(Math.hypot(x - 100, y - 100) - 50) < 0.3, `point ${x},${y} is off the circle`);
  assert.ok(circle.length / 2 > 40, 'a circle is smooth, not a polygon of a few corners');
  near(circle.slice(0, 2), circle.slice(-2));
  // A cubic's chord midpoint is not on the curve: with S the first control mirrors the last one.
  const [wave] = draw('<path d="M0 0 C 0 10 10 10 10 0 S 20 -10 20 0"/>');
  const second = pairs(wave).filter(([x]) => x > 10 && x < 20);
  assert.ok(Math.abs(Math.min(...second.map(([, y]) => y)) + 7.5) < 0.3, 'S reflects the previous control point');
});

test('path data: compact arc flags, implicit linetos, relative commands and close', () => {
  const [arc] = draw('<path d="M0 0a10 10 0 1110 0"/>');
  near(arc.slice(-2), [10, 0]);
  near(draw('<path d="M 0 0 10 0 10 10 z"/>')[0], [0, 0, 10, 0, 10, 10, 0, 0]);
  near(draw('<path d="m10 10 h5 v5 h-5 z"/>')[0], [10, 10, 15, 10, 15, 15, 10, 15, 10, 10]);
  assert.throws(() => draw('<path d="10 10"/>'), /start with a command/);
});

test('transforms nest, and hidden or unstroked elements draw nothing', () => {
  near(draw('<g transform="translate(10 20) scale(2)"><line x1="0" y1="0" x2="5" y2="0"/></g>')[0], [10, 20, 20, 20]);
  near(draw('<line x1="0" y1="0" x2="10" y2="0" transform="rotate(90)"/>')[0], [0, 0, 0, 10]);
  near(parseTransform('rotate(90 10 10)'), [0, 1, -1, 0, 20, 0]);
  assert.deepEqual(draw('<rect width="10" height="10" stroke="none"/><defs><circle r="5"/></defs><g style="display:none"><line x2="5"/></g>'), []);
  assert.equal(draw('<g stroke="none"><rect width="10" height="10" stroke="black"/></g>').length, 1, 'a child may turn its stroke back on');
});

test('hatching shades inside the shape and never bridges a gap', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  const zigzags = hatchPolygons([square], 10, 0);
  assert.equal(zigzags.reduce((sum, stroke) => sum + stroke.length / 4, 0), 10, 'one pass per spacing');
  assert.ok(zigzags.every((stroke) => stroke.length > 4), 'passes are joined into zigzags, not lifted one by one');
  for (const stroke of zigzags) for (const [x, y] of pairs(stroke)) assert.ok(x >= 0 && x <= 100 && y > 0 && y < 100);
  // A long zigzag is split: stamp brushes drop the start of very long strokes. Budget: 50 spacings.
  const tall = hatchPolygons([[0, 0, 100, 0, 100, 2000, 0, 2000]], 5, 0);
  const inked = (stroke) => pairs(stroke).reduce((sum, [x, y], i, all) => sum + (i ? Math.hypot(x - all[i - 1][0], y - all[i - 1][1]) : 0), 0);
  assert.ok(tall.length > 100 && tall.every((stroke) => stroke.length > 4), 'still zigzags, just shorter ones');
  assert.ok(tall.every((stroke) => inked(stroke) <= 50 * 5 + 100 + 5), 'no zigzag grows past its budget by more than one pass');
  const apart = hatchPolygons([[0, 0, 40, 0, 40, 100, 0, 100], [60, 0, 100, 0, 100, 100, 60, 100]], 10, 0);
  for (const stroke of apart) {
    const points = pairs(stroke);
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1][0], points[i][0]];
      assert.ok(!(Math.min(a, b) < 50 && Math.max(a, b) > 50), 'no stroke crosses the empty middle');
    }
  }
  // Fills are ignored unless hatching is asked for; then outline and shading both come out.
  assert.equal(draw('<rect width="50" height="50"/>').length, 1);
  assert.ok(draw('<rect width="50" height="50"/>', { hatch: { spacing: 5, angle: 45, cross: true } }).length > 2);
});

test('clipping cuts strokes at the area edge and keeps what re-enters separately', () => {
  near(clipStrokes([[-10, 5, 20, 5]], { x: 0, y: 0, width: 10, height: 10 })[0], [0, 5, 10, 5]);
  const clipped = clipStrokes([[2, 2, 20, 2, 20, 8, 2, 8], [50, 50]], { x: 0, y: 0, width: 10, height: 10 });
  assert.equal(clipped.length, 2, 'out and back in is two strokes; a dot outside is dropped');
  near(clipped[0], [2, 2, 10, 2]);
  near(clipped[1], [10, 8, 2, 8]);
});

test('the viewBox fits the area without distortion, centred', () => {
  assert.deepEqual(svgViewBox('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">'), [0, 0, 400, 200]);
  assert.deepEqual(svgViewBox('<svg width="30" height="40">'), [0, 0, 30, 40]);
  assert.throws(() => svgViewBox('<svg>'), /viewBox/);
  // 400x200 into 100x100: scale 0.25, centred vertically.
  assert.deepEqual(fitViewBox([0, 0, 400, 200], { x: 10, y: 10, width: 100, height: 100 }), [0.25, 0, 0, 0.25, 10, 35]);
});
