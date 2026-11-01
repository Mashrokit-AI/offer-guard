import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Own-ad uploads: JPEG/PNG only **by content** (sharp decode, not the
 * extension), bounded bytes and pixels, re-encoded to strip metadata.
 * Stored under data/uploads/<id>/ad.png — never under tracked dirs —
 * and deleted after 24 h.
 */

export interface StoredUpload {
  id: string;
  /** Repo-relative path of the normalized PNG. */
  relPath: string;
  bytes: number;
  width: number;
  height: number;
}

export class UploadError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(key);
    this.key = key;
  }
}

export async function validateAndStoreUpload(
  repoRoot: string,
  raw: Buffer,
  maxBytes: number,
  maxPixels: number,
): Promise<StoredUpload> {
  if (raw.length === 0 || raw.length > maxBytes) {
    throw new UploadError(raw.length > maxBytes ? 'err_too_large' : 'err_bad_image');
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(raw).metadata();
  } catch {
    throw new UploadError('err_bad_image');
  }
  if (meta.format !== 'jpeg' && meta.format !== 'png') throw new UploadError('err_bad_image');
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new UploadError('err_bad_image');
  if (width * height > maxPixels) throw new UploadError('err_too_many_pixels');
  // Re-encode: a fresh PNG carries no EXIF/XMP and neutralizes polyglots.
  let png: Buffer;
  try {
    png = await sharp(raw).png().toBuffer();
  } catch {
    throw new UploadError('err_bad_image');
  }
  const id = `own-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const dir = join(repoRoot, 'data', 'uploads', id);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ad.png'), png);
  return { id, relPath: `data/uploads/${id}/ad.png`, bytes: png.length, width, height };
}

/** Delete upload dirs older than maxAgeMs. Returns the number removed. */
export async function cleanupUploads(repoRoot: string, maxAgeMs: number): Promise<number> {
  const root = join(repoRoot, 'data', 'uploads');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  const now = Date.now();
  for (const e of entries) {
    if (e === '.' || e === '..') continue;
    const dir = join(root, e);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Best effort; a half-written dir is retried on the next pass.
    }
  }
  return removed;
}
