// Re-cuts the wordmark in `source/atrium.json` from a real font file.
//
// The wordmark ships as outlines so no font is needed to render the logo, which
// means the letterforms can only be changed by running this: it lays the text
// out, converts every glyph to a path on the baseline, and writes the result
// back into the brand source. `build-brand.mjs` then regenerates the assets.
//
//   node scripts/outline-wordmark.mjs
//
// The settings live in the `wordmark` block of `source/atrium.json` (text,
// font, weight, size, tracking); `font` selects the @fontsource file below.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSync } from 'fontkit';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourcePath = path.join(root, 'source/atrium.json');
const reference = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const { text, font, weight, size, tracking } = reference.wordmark;

// The fonts come from @fontsource rather than a checked-in binary, so the
// licence and the updates travel with the package manager.
const families = {
  'Geist Mono': '@fontsource/geist-mono/files/geist-mono-latin-{weight}-normal.woff2',
};
const file = families[font]?.replace('{weight}', weight);
if (!file) throw new Error(`${font}: add the @fontsource path for this family`);
const face = openSync(path.join(root, 'node_modules', file));

// Font units are y-up with the origin on the baseline; SVG is y-down, so every
// coordinate is scaled and flipped in one step.
const scale = size / face.unitsPerEm;
const round = value => Number(value.toFixed(3));
const x = (value, offset) => round(offset + value * scale);
const y = value => round(-value * scale);

const run = face.layout(text);
let offset = 0;
const contours = [];
for (const glyph of run.glyphs) {
  for (const { command, args } of glyph.path.commands) {
    const points = [];
    for (let index = 0; index < args.length; index += 2) {
      points.push(x(args[index], offset), y(args[index + 1]));
    }
    contours.push({ moveTo: 'M', lineTo: 'L', quadraticCurveTo: 'Q', bezierCurveTo: 'C', closePath: 'Z' }[command]
      + points.join(' '));
  }
  offset += glyph.advanceWidth * scale + tracking;
}

reference.wordmark.width = round(offset - tracking);
reference.wordmark.path = contours.join('');
await fs.writeFile(sourcePath, JSON.stringify(reference, null, 2) + '\n');
console.log(JSON.stringify({
  status: 'ok', font: face.fullName, text, size, tracking,
  width: reference.wordmark.width, commands: contours.length,
}));
