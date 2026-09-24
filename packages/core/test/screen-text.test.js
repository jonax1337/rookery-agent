import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeScreen, findText, pickMatch } from '../dist/computer/screen-text.js';

// Words as [text, x, y, width, height] in physical pixels; the active window is the left half.
const screen = (lines) => ({ lines, left: 0, top: 0, width: 2000, height: 1000, foreground: 1, window: [0, 0, 1000, 1000] });
const word = (text, x, y) => [text, x, y, text.length * 10, 20];

test('a phrase spanning words is found with the box of exactly those words', () => {
  const [match] = findText(screen([[word('File', 0, 0), word('Save', 60, 0), word('as', 120, 0), word('PDF', 160, 0)]]), 'save AS');
  assert.deepEqual([match.text, match.x, match.width, match.whole], ['Save as', 60, 80, true]);
});

test('whole words beat substrings, and a click refuses to guess between equals', () => {
  const matches = findText(screen([[word('Saved', 0, 0)], [word('Save', 0, 100)]]), 'Save');
  assert.equal(matches[0].text, 'Save', 'the whole word ranks first even though it is lower on screen');
  assert.equal(pickMatch(matches, 'Save').text, 'Save', 'a lone whole-word match is taken without an index');
  const twice = findText(screen([[word('OK', 100, 100)], [word('OK', 100, 300)]]), 'OK');
  assert.match(pickMatch(twice, 'OK'), /2 places/);
  assert.equal(pickMatch(twice, 'OK', 2).y, 300);
});

test('the active window decides between equal matches', () => {
  const matches = findText(screen([[word('Apply', 1500, 50)], [word('Apply', 300, 400)]]), 'apply');
  assert.equal(pickMatch(matches, 'apply').x, 300);
});

test('OCR near-misses are found only when nothing matches exactly', () => {
  const [near] = findText(screen([[word('Speichem', 0, 0)]]), 'Speichern');
  assert.equal(near?.approximate, true, 'rn read as m');
  assert.deepEqual(findText(screen([[word('Speichem', 0, 0)], [word('Speichern', 0, 50)]]), 'Speichern').map((m) => m.approximate), [false]);
  assert.deepEqual(findText(screen([[word('Drucken', 0, 0)]]), 'Speichern'), [], 'a different word is not a near-miss');
});

test('screen text lists line centres in screenshot pixels, top to bottom', () => {
  const text = describeScreen(screen([[word('Below', 100, 500)], [word('Top', 200, 100)]]), 0.5);
  assert.equal(text, '108,55 Top\n63,255 Below');
});
