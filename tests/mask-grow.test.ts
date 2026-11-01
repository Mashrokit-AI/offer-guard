import { describe, expect, it } from 'vitest';
import { growLogoMask } from '../src/server/repair/masks.js';
import type { RgbaImage } from '../src/server/repair/composite.js';

/**
 * Synthetic lockup on light bg: dark mark (x2-9) + 3 dark letters
 * (x12-19, x22-29, x32-39) + a far dark blob (x50-57) + a light-gray smudge
 * next to the second letter. SAM core covers the mark + first letter only.
 */
function lockup(): { rgba: RgbaImage; core: Uint8Array } {
  const w = 64;
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
  paint(50, 58, ink); // far blob
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
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 64, h: 20 });
    expect(countIn(grown, 64, 22, 30)).toBe(6 * 12); // second letter, minus smudge cols
    expect(countIn(grown, 64, 32, 40)).toBe(8 * 12); // third letter fully added
  });

  it('ignores near-background smudges and far blobs', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 64, h: 20 });
    expect(countIn(grown, 64, 22, 24)).toBe(0); // smudge: below threshold
    expect(countIn(grown, 64, 50, 58)).toBe(0); // far blob: beyond dilate range
  });

  it('stays inside the given box', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 30, h: 20 });
    expect(countIn(grown, 64, 32, 40)).toBe(0);
    expect(countIn(grown, 64, 24, 30)).toBeGreaterThan(0);
  });
});
