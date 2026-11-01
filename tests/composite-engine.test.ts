import { describe, expect, it } from 'vitest';
import { defringeCut, drawContactShadow, pasteWithFeather, supportPoint, type RgbaImage } from '../src/server/repair/composite.js';
import { elementProof } from '../src/server/repair/proof.js';
import { buildRebuiltPanelHtml, minLegiblePx } from '../src/server/repair/render.js';

function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = a;
    }
  }
  return { data, width: w, height: h };
}

describe('defringe', () => {
  it('recolors only the edge band, never the core or alpha', () => {
    // 12x12 opaque teal square with a dark 1px halo column on the left edge.
    const cut = img(12, 12, (x) => (x === 0 ? [10, 10, 10, 255] : [20, 120, 130, 255]));
    const out = defringeCut(cut, 2);
    // Edge column recolored to the interior teal.
    expect([out.data[0], out.data[1], out.data[2], out.data[3]]).toEqual([20, 120, 130, 255]);
    // Deep interior untouched.
    const c = (6 * 12 + 6) * 4;
    expect([out.data[c], out.data[c + 1], out.data[c + 2], out.data[c + 3]]).toEqual([20, 120, 130, 255]);
    // Alpha identical everywhere.
    for (let i = 3; i < out.data.length; i += 4) expect(out.data[i]).toBe(cut.data[i]);
  });

  it('keeps the proof core byte-identical after defringe + feathered paste', () => {
    const cut = img(20, 20, (x) => (x < 2 ? [5, 5, 5, 255] : [200, 100, 50, 255]));
    const clean = defringeCut(cut, 2);
    // Paste the defringed cut at 1x onto a blank canvas with feather 2, then
    // prove the ORIGINAL cut against it: the eroded core must still match.
    const canvas = img(30, 30, () => [255, 255, 255, 255]);
    pasteWithFeather(canvas, clean, 5, 5, 2);
    const pr = elementProof({ sourceCut: cut, output: canvas, left: 5, top: 5, scale: 1, featherPx: 2 });
    expect(pr.core_differ).toBe(0);
    expect(pr.pass).toBe(true);
    expect(pr.coverage).toBeGreaterThan(0.5);
    expect(pr.coverage).toBeLessThanOrEqual(1);
  });
});

describe('contact shadow', () => {
  it('finds the lowest opaque row, not the bbox center', () => {
    // Mass at top, a wide foot row at the bottom right.
    const cut = img(20, 10, (x, y) => (y < 4 || (y === 9 && x >= 7) ? [1, 2, 3, 255] : [0, 0, 0, 0]));
    const sp = supportPoint(cut, 100, 200)!;
    expect(sp.y).toBe(209);
    expect(sp.cx).toBeCloseTo(113, 6);
    expect(sp.width).toBe(13);
  });

  it('skips narrow stray runs below the real footing', () => {
    // Wide bar at y=7, one stray pixel row at the very bottom.
    const cut = img(40, 10, (x, y) => (((y === 7 && x >= 5 && x < 35) || (y === 9 && x === 20)) ? [1, 2, 3, 255] : [0, 0, 0, 0]));
    const sp = supportPoint(cut, 0, 0)!;
    expect(sp.y).toBe(7);
    expect(sp.width).toBe(30);
  });

  it('darkens under the support point and skips floating products', () => {
    const canvas = img(60, 60, () => [255, 255, 255, 255]);
    const drew = drawContactShadow(canvas, { cx: 30, y: 30, width: 40 }, {});
    expect(drew).toBe(true);
    const under = (40 * 60 + 30) * 4;
    expect(canvas.data[under]).toBeLessThan(255);
    // Far away untouched.
    expect(canvas.data[0]).toBe(255);
    const canvas2 = img(60, 60, () => [255, 255, 255, 255]);
    expect(drawContactShadow(canvas2, { cx: 30, y: 30, width: 40 }, { floating: true })).toBe(false);
    expect(canvas2.data[under]).toBe(255);
  });
});

describe('rebuilt panel html', () => {
  it('keeps verbatim strings, gershayim intact, with sampled colors', () => {
    const html = buildRebuiltPanelHtml({
      width: 600, height: 120, radius: 24, fill: { r: 255, g: 90, b: 60 },
      lines: [
        { text: '20% הנחה', weight: 700, color: { r: 255, g: 255, b: 255 } },
        { text: 'עד 10.11 · משלוח בתשלום', weight: 400, color: { r: 255, g: 255, b: 255 } },
      ],
      lang: 'he', align: 'center', fontCss: '', sizes: [60, 30],
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('הנחה');
    expect(html).toContain('20%');
    expect(html).toContain('עד');
    expect(html).toContain('10.11');
    expect(html).toContain('rgb(255,90,60)');
    expect(html).toContain('border-radius:24px');
  });

  it('sets a legible floor that grows with the canvas', () => {
    expect(minLegiblePx(628)).toBe(18);
    expect(minLegiblePx(1080)).toBe(24);
    expect(minLegiblePx(1920)).toBe(42);
  });
});
