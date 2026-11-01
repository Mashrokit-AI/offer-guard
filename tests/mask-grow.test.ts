import { describe, expect, it } from 'vitest';
import { completeLogoMask, growLogoMask } from '../src/server/repair/masks.js';
import { padBox } from '../src/shared/geometry.js';
import type { RgbaImage } from '../src/server/repair/composite.js';

/**
 * Synthetic lockup on light bg: dark mark (x2-9) + 3 dark letters
 * (x12-19, x22-29, x32-39) + a far dark blob (x80-87) + a light-gray smudge
 * next to the second letter. SAM core covers the mark + first letter only.
 */
function lockup(): { rgba: RgbaImage; core: Uint8Array } {
  const w = 96;
  const h = 20;
  const data = Buffer.alloc(w * h * 4);
  const paint = (x0: number, x1: number, rgb: [number, number, number]): void => {
    for (let y = 4; y < 16; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
  };
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 220;
    data[i * 4 + 1] = 230;
    data[i * 4 + 2] = 228;
    data[i * 4 + 3] = 255;
  }
  const ink: [number, number, number] = [15, 76, 92];
  paint(2, 10, ink);
  paint(12, 20, ink);
  paint(22, 30, ink);
  paint(32, 40, ink);
  paint(80, 88, ink); // far blob: 40px past the lockup, beyond completion range
  paint(22, 24, [200, 214, 210]); // light smudge over the second letter's edge
  const core = new Uint8Array(w * h);
  for (let y = 4; y < 16; y++) {
    for (let x = 2; x < 20; x++) core[y * w + x] = 1;
  }
  return { rgba: { data, width: w, height: h }, core };
}

const countIn = (mask: Uint8Array, w: number, x0: number, x1: number): number => {
  let n = 0;
  for (let y = 4; y < 16; y++) for (let x = x0; x < x1; x++) if (mask[y * w + x]) n++;
  return n;
};

describe('growLogoMask', () => {
  it('completes the wordmark from a partial SAM core', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 96, h: 20 });
    expect(countIn(grown, 96, 22, 30)).toBe(6 * 12); // second letter, minus smudge cols
    expect(countIn(grown, 96, 32, 40)).toBe(8 * 12); // third letter fully added
  });

  it('ignores near-background smudges and far blobs', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 96, h: 20 });
    expect(countIn(grown, 96, 22, 24)).toBe(0); // smudge: below threshold
    expect(countIn(grown, 96, 80, 88)).toBe(0); // far blob: beyond dilate range
  });

  it('stays inside the given box', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 30, h: 20 });
    expect(countIn(grown, 96, 32, 40)).toBe(0);
    expect(countIn(grown, 96, 24, 30)).toBeGreaterThan(0);
  });

  it('recovers a letter clipped by a tight Spark box once the box is padded', () => {
    const { rgba, core } = lockup();
    // Spark's box ends at x=30, clipping the third letter (x32-39) — seen
    // live as a "GAL" logo with a damaged "I".
    const tight = { x: 0, y: 0, w: 30, h: 20 };
    expect(countIn(growLogoMask(rgba, core, tight), 96, 32, 40)).toBe(0);
    const padded = padBox(tight, 15, 96, 20);
    expect(padded).toEqual({ x: 0, y: 0, w: 45, h: 20 });
    expect(countIn(growLogoMask(rgba, core, padded), 96, 32, 40)).toBe(8 * 12);
  });
});

describe('completeLogoMask', () => {
  it('completes a wordmark far outside a short Spark box, ignoring far ink', () => {
    const { rgba, core } = lockup();
    // Spark's box ends at x=20; the third letter (x32-39) is well outside
    // it — completion must reach it anyway (padding alone does not).
    const done = completeLogoMask(rgba, core, { x: 0, y: 0, w: 20, h: 20 });
    expect(countIn(done, 96, 32, 40)).toBe(8 * 12); // third letter fully added
    expect(countIn(done, 96, 80, 88)).toBe(0); // far blob stays out
  });
});

describe('padBox', () => {
  it('expands on all sides and clamps to the frame', () => {
    expect(padBox({ x: 100, y: 50, w: 200, h: 80 }, 15, 1080, 1080)).toEqual({ x: 85, y: 35, w: 230, h: 110 });
    expect(padBox({ x: 5, y: 5, w: 100, h: 100 }, 15, 1080, 1080)).toEqual({ x: 0, y: 0, w: 120, h: 120 });
    expect(padBox({ x: 1000, y: 1000, w: 70, h: 70 }, 15, 1080, 1080)).toEqual({ x: 985, y: 985, w: 95, h: 95 });
  });
});
