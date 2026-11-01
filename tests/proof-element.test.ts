import { describe, expect, it } from 'vitest';
import { pasteWithFeather, scaleRgbaNearest, type RgbaImage } from '../src/server/repair/composite.js';
import { elementProof } from '../src/server/repair/proof.js';

function solid(w: number, h: number, rgb: [number, number, number], opaque = true): RgbaImage {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = opaque ? 255 : 0;
  }
  return { data, width: w, height: h };
}

function donutCut(): RgbaImage {
  // 10x10, opaque core 2..7 with a transparent corner pixel inside.
  const cut = solid(10, 10, [200, 30, 30], false);
  for (let y = 2; y < 8; y++) {
    for (let x = 2; x < 8; x++) {
      cut.data[(y * 10 + x) * 4 + 3] = 255;
    }
  }
  return cut;
}

describe('element proof', () => {
  it('passes with 0 differing pixels on an identical paste', () => {
    const cut = solid(8, 8, [10, 20, 30]);
    const canvas = solid(20, 20, [200, 200, 200]);
    pasteWithFeather(canvas, cut, 5, 5, 0);
    const pr = elementProof({ sourceCut: cut, output: canvas, left: 5, top: 5, scale: 1, featherPx: 0 });
    expect(pr.pass).toBe(true);
    expect(pr.core_differ).toBe(0);
    expect(pr.core_total).toBe(64);
  });

  it('passes after a recorded uniform scale (nearest neighbor)', () => {
    const cut = solid(8, 8, [10, 20, 30]);
    const canvas = solid(40, 40, [200, 200, 200]);
    const scaled = scaleRgbaNearest(cut, 2);
    expect([scaled.width, scaled.height]).toEqual([16, 16]);
    pasteWithFeather(canvas, scaled, 4, 4, 0);
    const pr = elementProof({ sourceCut: cut, output: canvas, left: 4, top: 4, scale: 2, featherPx: 0 });
    expect(pr.pass).toBe(true);
    expect(pr.core_differ).toBe(0);
    expect(pr.core_total).toBe(256);
  });

  it('ignores the feather ring but gates the eroded core', () => {
    const cut = donutCut();
    const canvas = solid(20, 20, [200, 200, 200]);
    pasteWithFeather(canvas, cut, 5, 5, 2);
    const pr = elementProof({ sourceCut: cut, output: canvas, left: 5, top: 5, scale: 1, featherPx: 2 });
    expect(pr.pass).toBe(true);
    expect(pr.core_differ).toBe(0);
    expect(pr.feather_total).toBeGreaterThan(0);
    // Core is the 6x6 opaque block eroded by 2 → 2x2.
    expect(pr.core_total).toBe(4);
  });

  it('fails when a core pixel changed', () => {
    const cut = solid(8, 8, [10, 20, 30]);
    const canvas = solid(20, 20, [200, 200, 200]);
    pasteWithFeather(canvas, cut, 5, 5, 0);
    canvas.data[(8 * 20 + 8) * 4] = 99; // tamper one pasted pixel
    const pr = elementProof({ sourceCut: cut, output: canvas, left: 5, top: 5, scale: 1, featherPx: 0 });
    expect(pr.pass).toBe(false);
    expect(pr.core_differ).toBe(1);
  });

  it('fails on an empty core', () => {
    const cut = solid(4, 4, [10, 20, 30], false);
    const canvas = solid(20, 20, [200, 200, 200]);
    const pr = elementProof({ sourceCut: cut, output: canvas, left: 5, top: 5, scale: 1, featherPx: 0 });
    expect(pr.pass).toBe(false);
    expect(pr.core_total).toBe(0);
  });
});
