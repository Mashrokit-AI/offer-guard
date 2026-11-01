import { describe, expect, it } from 'vitest';
import { editImages, extractImageBytes } from '../src/server/models/muse-image.js';

const b64 = Buffer.alloc(200, 7).toString('base64');

describe('extractImageBytes', () => {
  it('accepts every response shape seen so far', async () => {
    const fetchUrl = async (): Promise<Buffer> => Buffer.alloc(150, 9);
    expect((await extractImageBytes({ data: [{ b64_json: b64 }] }, fetchUrl)).length).toBe(200);
    expect((await extractImageBytes({ images: [`data:image/png;base64,${b64}`] }, fetchUrl)).length).toBe(200);
    expect((await extractImageBytes({ output: [{ b64_json: b64 }] }, fetchUrl)).length).toBe(200);
    expect((await extractImageBytes({ b64_json: b64 }, fetchUrl)).length).toBe(200);
    expect((await extractImageBytes({ data: [{ url: 'https://example.com/x.png' }] }, fetchUrl)).length).toBe(150);
  });

  it('rejects empty and unrecognized payloads', async () => {
    const fetchUrl = async (): Promise<Buffer> => Buffer.alloc(0);
    await expect(extractImageBytes(null, fetchUrl)).rejects.toThrow();
    await expect(extractImageBytes({ hello: 'world' }, fetchUrl)).rejects.toThrow(/unrecognized/);
  });
});

describe('editImages', () => {
  it('validates the 1–10 image rule without touching the network', async () => {
    const cfg = { baseUrl: 'https://example.invalid', apiKey: 'x', model: 'muse-image-1.0' };
    await expect(editImages(cfg, { prompt: 'p', size: '1080x1080', images: [], reasoningStrength: 'low' })).rejects.toThrow(/1–10/);
    const eleven = new Array(11).fill({ bytes: Buffer.alloc(10), mimeType: 'image/png' });
    await expect(editImages(cfg, { prompt: 'p', size: '1080x1080', images: eleven, reasoningStrength: 'low' })).rejects.toThrow(/1–10/);
  });
});
