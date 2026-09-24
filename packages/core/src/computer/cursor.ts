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
 * Lucide's pointer, redrawn with round corners (tip, both wings and the inner
 * notch), shared by every renderer. hotspot is the tip in pixels at this size:
 * where the rounded tip's curve peaks, (4.72, 4.72) in the 24-unit path.
 */
export const CURSOR = {
  path: 'M4.85 6.03Q4 4 6.03 4.85L17.55 9.66Q20.5 10.9 17.48 11.96L15.66 12.6Q13.4 13.4 12.6 15.66L11.96 17.48Q10.9 20.5 9.66 17.55Z',
  size: 26,
  hotspot: (4.72 * 26) / 24,
  fill: '#f2fffc',
  outline: '#31534e',
  glow: '#83e3d1',
} as const;
