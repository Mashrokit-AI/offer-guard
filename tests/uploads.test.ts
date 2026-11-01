import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { UploadError, validateAndStoreUpload, validateImageBytes } from '../src/server/http/uploads.js';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

async function make(format: 'jpeg' | 'png' | 'webp' | 'gif', w = 32, h = 32): Promise<Buffer> {
  const base = sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 20, b: 30 } } });
  if (format === 'jpeg') return base.jpeg().toBuffer();
  if (format === 'png') return base.png().toBuffer();
  if (format === 'webp') return base.webp().toBuffer();
  return base.gif().toBuffer();
}

describe('upload validation', () => {
  it('accepts JPEG, PNG and WebP by content', async () => {
    for (const f of ['jpeg', 'png', 'webp'] as const) {
      const v = await validateImageBytes(await make(f), MAX_BYTES, MAX_PIXELS);
      expect([v.width, v.height]).toEqual([32, 32]);
    }
  });

  it('rejects GIF, text and empty buffers', async () => {
    await expect(validateImageBytes(await make('gif'), MAX_BYTES, MAX_PIXELS)).rejects.toMatchObject({ key: 'err_bad_image' });
    await expect(validateImageBytes(Buffer.from('not an image'), MAX_BYTES, MAX_PIXELS)).rejects.toMatchObject({ key: 'err_bad_image' });
    await expect(validateImageBytes(Buffer.alloc(0), MAX_BYTES, MAX_PIXELS)).rejects.toMatchObject({ key: 'err_bad_image' });
  });

  it('enforces the byte and megapixel caps', async () => {
    const png = await make('png');
    await expect(validateImageBytes(png, 10, MAX_PIXELS)).rejects.toMatchObject({ key: 'err_too_large' });
    await expect(validateImageBytes(png, MAX_BYTES, 100)).rejects.toMatchObject({ key: 'err_too_many_pixels' });
  });

  it('stores a re-encoded PNG under data/ (never the raw bytes)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adfit-up-'));
    const stored = await validateAndStoreUpload(root, await make('jpeg'), MAX_BYTES, MAX_PIXELS);
    expect(stored.relPath).toMatch(/^data\/uploads\/up-[a-z0-9-]+\/image\.png$/);
    const meta = await sharp(join(root, stored.relPath)).metadata();
    expect(meta.format).toBe('png');
  });

  it('downscales huge photos to 1600 px on the long edge, never upscales', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adfit-up-'));
    const big = await validateAndStoreUpload(root, await make('jpeg', 2000, 1000), MAX_BYTES, MAX_PIXELS);
    expect([big.width, big.height]).toEqual([1600, 800]);
    const small = await validateAndStoreUpload(root, await make('jpeg', 400, 300), MAX_BYTES, MAX_PIXELS);
    expect([small.width, small.height]).toEqual([400, 300]);
  });

  it('UploadError carries an i18n key', () => {
    expect(new UploadError('err_bad_image').key).toBe('err_bad_image');
  });
});
