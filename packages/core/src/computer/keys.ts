/**
 * Key names the model may use, mapped to Windows virtual-key codes.
 *
 * A combo is written the way people write shortcuts: "ctrl+l", "alt+tab",
 * "win+r", "shift+enter". Modifiers are pressed in order and released in
 * reverse, so "ctrl+shift+t" behaves like a person holding the keys.
 */

const NAMED: Record<string, number> = {
  ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e,
  space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, insert: 0x2d, printscreen: 0x2c, capslock: 0x14, menu: 0x5d,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79,
  f11: 0x7a, f12: 0x7b,
  volumeup: 0xaf, volumedown: 0xae, volumemute: 0xad, mediaplaypause: 0xb3, medianext: 0xb0, mediaprev: 0xb1,
  // Punctuation on a US layout; letters and digits are handled below.
  '-': 0xbd, '=': 0xbb, '[': 0xdb, ']': 0xdd, ';': 0xba, "'": 0xde, ',': 0xbc, '.': 0xbe, '/': 0xbf, '`': 0xc0, '\\': 0xdc,
  plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, slash: 0xbf,
};

const MODIFIERS = new Set([0x11, 0x12, 0x10, 0x5b]);

/** Virtual-key codes for one combo, modifiers first. Throws on an unknown name. */
export function parseKeyCombo(combo: string): number[] {
  const parts = combo
    .trim()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  // "ctrl++" means ctrl and the plus key: the split eats the second plus.
  if (/\+\+$/.test(combo.trim())) parts.push('plus');
  if (!parts.length) throw new Error('Empty key combo.');

  const codes = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower in NAMED) return NAMED[lower] as number;
    if (/^[a-z]$/.test(lower)) return lower.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(lower)) return lower.charCodeAt(0);
    throw new Error('Unknown key "' + part + '". Use names like ctrl, alt, shift, win, enter, tab, esc, f5, or a letter.');
  });

  // Modifiers go down first whatever order they were written in.
  const modifiers = codes.filter((code) => MODIFIERS.has(code));
  const rest = codes.filter((code) => !MODIFIERS.has(code));
  return [...modifiers, ...rest];
}

/** Every combo in a space-separated sequence like "ctrl+l enter". */
export function parseKeySequence(sequence: string): number[][] {
  return sequence
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseKeyCombo);
}
