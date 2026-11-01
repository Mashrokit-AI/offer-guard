import { describe, expect, it } from 'vitest';
import { panelComplexity, samplePanelColor, snapPanelRect } from '../src/server/adfit/snap.js';
import type { RgbaImage } from '../src/server/repair/composite.js';

/** Orange panel (10,20,60x30) with white text bars on a teal gradient. */
function panelImage(): RgbaImage {
  const w = 100;
  const h = 80;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inPanel = x >= 10 && x < 70 && y >= 20 && y < 50;
      const isText = inPanel && y >= 30 && y < 36 && x >= 20 && x < 60;
      data[o] = inPanel ? (isText ? 255 : 255) : 200;
      data[o + 1] = inPanel ? (isText ? 255 : 90) : 230;
      data[o + 2] = inPanel ? (isText ? 255 : 60) : 225;
      data[o + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

describe('panel sampling', () => {
  it('samples the fill as the median (text outliers ignored)', () => {
    expect(samplePanelColor(panelImage(), { x: 10, y: 20, w: 60, h: 30 })).toBe('#ff5a3c');
  });

  it('scores flat-with-text as simple, photo texture as complex', () => {
    // Flat orange + white center text: border ring is flat → rebuild.
    expect(panelComplexity(panelImage(), { x: 10, y: 20, w: 60, h: 30 }).complex).toBe(false);
    // Noisy border (photo texture at the edges) → paste.
    const noisy = panelImage();
    for (let y = 20; y < 50; y++) {
      for (let x = 10; x < 70; x++) {
        const border = x < 14 || x >= 66 || y < 24 || y >= 46;
        if (!border) continue;
        const o = (y * noisy.width + x) * 4;
        const v = ((x * 37 + y * 91) % 200) + 30;
        noisy.data[o] = v;
        noisy.data[o + 1] = 255 - v;
        noisy.data[o + 2] = (v * 2) % 255;
      }
    }
    expect(panelComplexity(noisy, { x: 10, y: 20, w: 60, h: 30 }).complex).toBe(true);
  });
});

describe('snapPanelRect', () => {
  it('expands a tight text-fitted box out to the panel edges', () => {
    const snapped = snapPanelRect(panelImage(), { x: 18, y: 28, w: 44, h: 10 });
    expect(snapped.x).toBeLessThanOrEqual(10);
    expect(snapped.y).toBeLessThanOrEqual(20);
    expect(snapped.x + snapped.w).toBeGreaterThanOrEqual(70);
    expect(snapped.y + snapped.h).toBeGreaterThanOrEqual(50);
  });

  it('leaves an already-correct box unchanged', () => {
    const snapped = snapPanelRect(panelImage(), { x: 10, y: 20, w: 60, h: 30 });
    expect(snapped).toEqual({ x: 10, y: 20, w: 60, h: 30 });
  });

  it('never expands past the image or the cap', () => {
    const snapped = snapPanelRect(panelImage(), { x: 0, y: 0, w: 100, h: 80 });
    expect(snapped.x).toBe(0);
    expect(snapped.y).toBe(0);
    expect(snapped.x + snapped.w).toBeLessThanOrEqual(100);
    expect(snapped.y + snapped.h).toBeLessThanOrEqual(80);
  });
});
