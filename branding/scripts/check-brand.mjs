import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = JSON.parse(await fs.readFile(path.join(root, 'source/atrium.json'), 'utf8'));
const svgNames = (await fs.readdir(root)).filter(name => name.endsWith('.svg'));
for (const name of svgNames) {
  const data = await fs.readFile(path.join(root, name));
  assert.doesNotMatch(data.toString(), /<(?:image|text|script|filter|linearGradient|radialGradient)\b/, name);
  assert.deepEqual(data, await fs.readFile(path.join(root, '../packages/web/public', name)), `${name}: public copy`);
  const pixels = await sharp(data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.ok(pixels.info.width > 0 && pixels.info.height > 0, `${name}: renders`);
  if (/^(logo|wordmark)/.test(name)) {
    const { width, height } = pixels.info;
    const alpha = (x, y) => pixels.data[(y * width + x) * 4 + 3];
    for (let x = 0; x < width; x++) {
      assert.equal(alpha(x, 0) + alpha(x, height - 1), 0, `${name}: unclipped ascenders and descenders`);
    }
    for (let y = 0; y < height; y++) {
      assert.equal(alpha(0, y) + alpha(width - 1, y), 0, `${name}: unclipped wordmark edges`);
    }
  }
}
const approved = await fs.readFile(path.join(root, 'source/atrium-approved.svg'));
for (const name of ['mark.svg', 'mark-small.svg']) {
  const svg = await fs.readFile(path.join(root, name), 'utf8');
  assert.equal((svg.match(/<path /g) ?? []).length, 2);
  for (const size of [16, 24, 32, 48, 256]) {
    const actual = await sharp(Buffer.from(svg)).resize(size, size).ensureAlpha().raw().toBuffer();
    const expected = await sharp(approved).resize(size, size).ensureAlpha().raw().toBuffer();
    assert.deepEqual(actual, expected, `${name}: approved Atrium silhouette at ${size}px`);
  }
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) {
        assert.equal(data[(y * info.width + x) * 4 + 3], 0, `${name}: no clipping`);
      }
    }
  }
}
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  const data = await fs.readFile(path.join(root, name));
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.width, size);
  assert.equal(metadata.height, size);
  assert.deepEqual(data, await fs.readFile(path.join(root, '../packages/web/public', name)));
}
const ico = await fs.readFile(path.join(root, 'favicon.ico'));
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), 4);
for (let index = 0; index < 4; index++) {
  const entry = 6 + index * 16;
  const size = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  const metadata = await sharp(ico.subarray(offset, offset + size)).metadata();
  assert.equal(metadata.width, [16, 32, 48, 256][index]);
}
for (const name of ['Manrope-Variable.ttf', 'Manrope-OFL.txt']) {
  assert.deepEqual(await fs.readFile(path.join(root, 'source', name)),
    await fs.readFile(path.join(root, '../packages/web/public/fonts', name)), `${name}: bundled typeface`);
}

// Check actual theme pairs, so future palette edits cannot quietly lose contrast.
const css = await fs.readFile(path.join(root, '../packages/web/src/styles/index.css'), 'utf8');
const declarations = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
const shared = Object.fromEntries(Object.entries(source.colors).map(([key, value]) => [`--rookery-${key}`, value]));
const light = { ...shared, ...declarations(css.match(/\n:root \{([^}]+)\}/)[1]) };
const dark = { ...light, ...declarations(css.match(/\n\.dark \{([^}]+)\}/)[1]) };
function luminance(theme, token) {
  const seen = new Set();
  let value = theme[token];
  while (value?.startsWith('var(')) {
    assert.ok(!seen.has(value), `${token}: circular colour token`);
    seen.add(value);
    value = theme[value.slice(4, -1)];
  }
  assert.match(value, /^#[0-9a-f]{6}$/i, token);
  const channels = value.slice(1).match(/../g).map(hex => parseInt(hex, 16) / 255)
    .map(s => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
for (const [name, theme] of [['light', light], ['dark', dark]]) {
  for (const [foreground, background, minimum] of [
    ['foreground', 'background', 4.5], ['card-foreground', 'card', 4.5],
    ['muted-foreground', 'background', 4.5], ['muted-foreground', 'muted', 4.5],
    ['primary-foreground', 'primary', 4.5], ['accent-foreground', 'accent', 4.5],
    ['sidebar-foreground', 'sidebar', 4.5], ['input', 'background', 3], ['input', 'card', 3],
    ['ring', 'background', 3],
  ]) {
    const a = luminance(theme, `--${foreground}`), b = luminance(theme, `--${background}`);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= minimum, `${name} ${foreground}/${background}: ${ratio.toFixed(2)} < ${minimum}`);
  }
}
console.log(`Brand checks passed: ${svgNames.length} SVGs, approved Atrium silhouette, bundled font, theme contrast, public copies and platform icons.`);
