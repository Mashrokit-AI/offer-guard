import { randomBytes } from 'node:crypto';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * Uploads: JPEG/PNG/WebP **by content** (sharp decode, not the extension),
 * bounded bytes and pixels, re-encoded to strip metadata. Stored under
 * data/uploads/<id>/ — never under tracked dirs — and deleted after 24 h.
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
  subdir = 'uploads',
  fileName = 'image.png',
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
  if (meta.format !== 'jpeg' && meta.format !== 'png' && meta.format !== 'webp') {
    throw new UploadError('err_bad_image');
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new UploadError('err_bad_image');
  if (width * height > maxPixels) throw new UploadError('err_too_many_pixels');
  // Re-encode: a fresh PNG carries no EXIF/XMP and neutralizes polyglots.
  // Downscale huge photos to 1600 px on the long edge (never upscale): the
  // stored file is the source of truth for both model calls and compositing,
  // and 1600 px covers every placement preset without giant payloads.
  let png: Buffer;
  let outW = width;
  let outH = height;
  try {
    const edge = Math.max(width, height);
    const pipe = edge > 1600 ? sharp(raw).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }) : sharp(raw);
    png = await pipe.ensureAlpha().png().toBuffer();
    if (edge > 1600) {
      const scale = 1600 / edge;
      outW = Math.round(width * scale);
      outH = Math.round(height * scale);
    }
  } catch {
    throw new UploadError('err_bad_image');
  }
  const id = `up-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const dir = join(repoRoot, 'data', subdir, id);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), png);
  return { id, relPath: `data/${subdir}/${id}/${fileName}`, bytes: png.length, width: outW, height: outH };
}

/**
 * Validate image bytes without storing anything: JPEG/PNG/WebP by content,
 * bounded bytes and pixels, re-encoded in memory (metadata stripped).
 */
export async function validateImageBytes(
  raw: Buffer,
  maxBytes: number,
  maxPixels: number,
): Promise<{ bytes: Buffer; width: number; height: number }> {
  if (raw.length === 0 || raw.length > maxBytes) {
    throw new UploadError(raw.length > maxBytes ? 'err_too_large' : 'err_bad_image');
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(raw).metadata();
  } catch {
    throw new UploadError('err_bad_image');
  }
  if (meta.format !== 'jpeg' && meta.format !== 'png' && meta.format !== 'webp') {
    throw new UploadError('err_bad_image');
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new UploadError('err_bad_image');
  if (width * height > maxPixels) throw new UploadError('err_too_many_pixels');
  try {
    const edge = Math.max(width, height);
    const pipe = edge > 1600 ? sharp(raw).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }) : sharp(raw);
    const bytes = await pipe.ensureAlpha().png().toBuffer();
    if (edge <= 1600) return { bytes, width, height };
    const scale = 1600 / edge;
    return { bytes, width: Math.round(width * scale), height: Math.round(height * scale) };
  } catch {
    throw new UploadError('err_bad_image');
  }
}

/** Delete upload dirs older than maxAgeMs. Returns the number removed. */
export async function cleanupUploads(repoRoot: string, maxAgeMs: number, subdir = 'uploads'): Promise<number> {
  const root = join(repoRoot, 'data', subdir);
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
