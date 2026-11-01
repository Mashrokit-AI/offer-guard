import { describe, expect, it } from 'vitest';
import { clipMaskToPaddedBox, completeLogoMask, fillMaskHoles, growLogoMask, maskFillInBox } from '../src/server/repair/masks.js';
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

describe('clipMaskToPaddedBox', () => {
  it('drops a sibling product matched by the unbounded phrase mask', () => {
    // Two blobs 40px apart; the target box covers only the left one.
    const W = 96;
    const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 2; x < 20; x++) mask[y * W + x] = 1;
      for (let x = 60; x < 78; x++) mask[y * W + x] = 1;
    }
    const { kept, dropped } = clipMaskToPaddedBox(mask, W, H, { x: 0, y: 0, w: 24, h: 20 }, 4);
    expect(kept).toBe(18 * 12);
    expect(dropped).toBe(18 * 12);
    expect(countIn(mask, 96, 60, 78)).toBe(0);
    expect(countIn(mask, 96, 2, 20)).toBe(18 * 12);
  });
});

describe('fillMaskHoles', () => {
  it('fills enclosed holes but keeps border-connected background', () => {
    const W = 20;
    const H = 10;
    const mask = new Uint8Array(W * H).fill(1);
    // Enclosed 2x2 hole.
    mask[4 * W + 5] = 0; mask[4 * W + 6] = 0; mask[5 * W + 5] = 0; mask[5 * W + 6] = 0;
    // Border-connected notch (top edge).
    mask[0 * W + 10] = 0; mask[0 * W + 11] = 0; mask[1 * W + 10] = 0; mask[1 * W + 11] = 0;
    const filled = fillMaskHoles(mask, W, H);
    expect(filled).toBe(4);
    expect(mask[4 * W + 5]).toBe(1);
    expect(mask[0 * W + 10]).toBe(0);
  });

  it('scores sparse masks low', () => {
    const W = 10;
    const H = 10;
    const solid = new Uint8Array(W * H).fill(1);
    expect(maskFillInBox(solid, W, H)).toBe(1);
    const sparse = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 2) sparse[i] = 1;
    expect(maskFillInBox(sparse, W, H)).toBeLessThan(0.7);
    expect(maskFillInBox(new Uint8Array(W * H), W, H)).toBe(0);
  });
});

describe('padBox', () => {
  it('expands on all sides and clamps to the frame', () => {
    expect(padBox({ x: 100, y: 50, w: 200, h: 80 }, 15, 1080, 1080)).toEqual({ x: 85, y: 35, w: 230, h: 110 });
    expect(padBox({ x: 5, y: 5, w: 100, h: 100 }, 15, 1080, 1080)).toEqual({ x: 0, y: 0, w: 120, h: 120 });
    expect(padBox({ x: 1000, y: 1000, w: 70, h: 70 }, 15, 1080, 1080)).toEqual({ x: 985, y: 985, w: 95, h: 95 });
  });
});
