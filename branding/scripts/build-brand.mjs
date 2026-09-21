import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => fs.readFile(path.join(root, name), 'utf8');
const write = (name, data) => fs.writeFile(path.join(root, name), data);
const reference = JSON.parse(await read('source/atrium.json'));
const { wordmark: word, colors } = reference;
const svg = (width, height, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Rookery"><title>Rookery</title>${body}</svg>\n`;
const group = (body, transform) => `<g transform="${transform}">${body}</g>`;
const contour = (d, fill) => `<path fill="${fill}" d="${d}"/>`;
const mark = ink => reference.paths.map(d => contour(d, ink)).join('');
const wordmark = ink => contour(word.path, ink);
const lockup = ink => group(mark(ink), 'translate(8 7) scale(.53)') + group(wordmark(ink), 'translate(160 104)');
const stacked = ink => group(mark(ink), 'translate(90 12) scale(.859375)') + group(wordmark(ink), `translate(${(400 - word.width * .8) / 2} 290) scale(.8)`);
const assets = {};
for (const [suffix, ink] of [
  ['', colors.evergreen], ['-light', colors.frost],
  ['-mono', 'currentColor'], ['-white', colors.white],
]) {
  assets[`logo${suffix}.svg`] = svg(Math.round(word.width + 184), 150, lockup(ink));
  assets[`mark${suffix}.svg`] = svg(256, 256, mark(ink));
  if (suffix === '' || suffix === '-light') {
    assets[`mark-small${suffix}.svg`] = svg(256, 256, mark(ink));
    assets[`wordmark${suffix}.svg`] = svg(Math.ceil(word.width + 16), 112, group(wordmark(ink), 'translate(8 78)'));
    assets[`logo-stacked${suffix}.svg`] = svg(400, 360, stacked(ink));
  }
}
const icon = (compact, rounded) => svg(256, 256,
  `<rect width="256" height="256" rx="${rounded ? 12 : 0}" fill="${colors.evergreen}"/>`
  + (compact ? mark(colors.frost) : group(mark(colors.frost), 'translate(20 20) scale(.84375)')));
assets['app-icon.svg'] = icon(false, true);
assets['favicon.svg'] = icon(true, true);
for (const [name, data] of Object.entries(assets)) await write(name, data);
for (const suffix of ['', '-light']) {
  await sharp(Buffer.from(assets[`logo${suffix}.svg`])).resize(1600).png().toFile(path.join(root, `logo${suffix}.png`));
}
for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  await sharp(Buffer.from(icon(false, false))).resize(size, size).png().toFile(path.join(root, name));
}
const frames = [];
for (const size of [16, 32, 48, 256]) {
  const data = await sharp(Buffer.from(assets['favicon.svg'])).resize(size, size).png().toBuffer();
  frames.push({ size, data });
  if (size !== 256) await write(`favicon-${size}.png`, data);
}
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(frames.length, 4);
let offset = 6 + frames.length * 16;
const entries = frames.map(({ size, data }) => {
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = entry[0];
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += data.length;
  return entry;
});
await write('favicon.ico', Buffer.concat([head, ...entries, ...frames.map(frame => frame.data)]));
await write('colors.css', `:root {\n${Object.entries(colors).map(([name, value]) => `  --rookery-${name}: ${value};`).join('\n')}\n}\n`);
await write('colors.json', JSON.stringify(colors, null, 2) + '\n');
await write('site.webmanifest', JSON.stringify({
  name: 'Rookery', short_name: 'Rookery', start_url: '/', scope: '/', display: 'standalone',
  theme_color: colors.evergreen, background_color: colors.frost,
  icons: [192, 512].map(size => ({ src: `icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })),
}, null, 2) + '\n');
const preview = svg(1280, 600,
  `<rect width="1280" height="600" fill="${colors.frost}"/><rect x="768" width="512" height="600" fill="${colors.evergreen}"/>`
  + group(lockup(colors.evergreen), `translate(${(768 - Math.round(word.width + 196) * 1.1) / 2} 180) scale(1.1)`)
  + group(stacked(colors.frost), 'translate(824 88)')
  + [16, 24, 32, 48].map((size, index) => group(mark(colors.evergreen), `translate(${80 + index * 85} 430) scale(${size / 256})`)).join('')
  + Object.values(colors).map((color, index) => `<rect x="${80 + index * 96}" y="525" width="76" height="28" rx="2" fill="${color}"/>`).join(''));
await sharp(Buffer.from(preview)).png().toFile(path.join(root, 'preview.png'));
const publicFiles = [...Object.keys(assets), 'favicon.ico', 'favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest'];
const publicRoot = path.join(root, '../packages/web/public');
await fs.mkdir(publicRoot, { recursive: true });
for (const name of publicFiles) await fs.copyFile(path.join(root, name), path.join(publicRoot, name));
console.log(JSON.stringify({ status: 'ok', concept: reference.name, publicFiles: publicFiles.length }));
