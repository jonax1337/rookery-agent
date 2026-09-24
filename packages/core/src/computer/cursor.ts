/*!
 * Mouse Pointer 2, Lucide Icons — https://lucide.dev/icons/mouse-pointer-2
 * ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/**
 * Lucide's pointer, redrawn soft: the tip and both wings are cubic-rounded
 * (the wings strongest, reaching slightly past Lucide's corners so the
 * glyph keeps its size), the inner notch gently. Shared by every renderer.
 * hotspot is the tip in pixels at this size: where the rounded tip's curve
 * peaks, (4.83, 4.83) in the 24-unit path.
 */
export const CURSOR = {
  path: 'M7.54 5.23L15.63 8.7C20.12 10.62 20.46 11.6 16.93 12.43L16.02 12.65C14.34 13.05 13.05 14.34 12.65 16.02L12.43 16.93C11.6 20.46 10.62 20.12 8.7 15.63L5.23 7.54C3.99 4.63 4.63 3.99 7.54 5.23Z',
  size: 26,
  hotspot: (4.83 * 26) / 24,
  fill: '#f2fffc',
  outline: '#31534e',
  glow: '#83e3d1',
} as const;
