import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cutMaskedPng, decodeRgba, exactSize, scaleRgbaNearest } from '../src/server/repair/composite.js';
import { applyFrameOverlay } from '../src/server/adfit/pipeline.js';

async function solidPng(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

describe('exactSize', () => {
  it('cover-fits any input to the exact preset and verifies', async () => {
    // Wire shape the model actually returns for 1080x1920 (aspect only).
    const wire = await solidPng(1152, 2048, 10, 20, 30);
    const out = await exactSize(wire, 1080, 1920);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
  });

  it('never stretches: square input to wide output keeps proportions', async () => {
    const wire = await solidPng(100, 100, 10, 20, 30);
    const out = await exactSize(wire, 1200, 628);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 628]);
  });
});

describe('cutMaskedPng', () => {
  it('cuts the tight masked crop with alpha from the mask', async () => {
    const rgba = await decodeRgba(await solidPng(10, 10, 200, 30, 30));
    const mask = new Uint8Array(100);
    for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) mask[y * 10 + x] = 1;
    const cut = await cutMaskedPng(rgba, mask);
    expect([cut.x, cut.y, cut.w, cut.h]).toEqual([3, 2, 5, 4]);
    const back = await decodeRgba(cut.png);
    expect([back.width, back.height]).toEqual([5, 4]);
  });

  it('throws on an empty mask', async () => {
    const rgba = await decodeRgba(await solidPng(4, 4, 1, 2, 3));
    await expect(cutMaskedPng(rgba, new Uint8Array(16))).rejects.toThrow(/empty mask/);
  });
});

describe('scaleRgbaNearest', () => {
  it('scales uniformly without blending colors', () => {
    const src = { data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]), width: 2, height: 2 };
    const out = scaleRgbaNearest(src, 2);
    expect([out.width, out.height]).toEqual([4, 4]);
    // Top-left 2x2 block repeats the first pixel exactly.
    expect([...out.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...out.data.slice(4, 8)]).toEqual([10, 20, 30, 255]);
  });
});

describe('frame overlay', () => {
  it('stamps an exact-size frame last and leaves transparent pixels alone', async () => {
    const canvas = await decodeRgba(await solidPng(8, 8, 50, 60, 70));
    // 8x8 frame: opaque red left column, transparent elsewhere.
    const frameRaw = Buffer.alloc(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      frameRaw[(y * 8) * 4] = 255;
      frameRaw[(y * 8) * 4 + 3] = 255;
    }
    const frame = await sharp(frameRaw, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
    const note = await applyFrameOverlay(canvas, frame, 8, 8);
    expect(note).toBe('frame overlay applied');
    expect([canvas.data[0], canvas.data[1], canvas.data[2]]).toEqual([255, 0, 0]);
    expect([canvas.data[4], canvas.data[5], canvas.data[6]]).toEqual([50, 60, 70]);
  });

  it('skips a frame whose size does not match, with an honest note', async () => {
    const canvas = await decodeRgba(await solidPng(8, 8, 50, 60, 70));
    const frame = await solidPng(10, 10, 255, 0, 0);
    const note = await applyFrameOverlay(canvas, frame, 8, 8);
    expect(note).toMatch(/skipped/);
    expect([canvas.data[0], canvas.data[1], canvas.data[2]]).toEqual([50, 60, 70]);
  });
});
