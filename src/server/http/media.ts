import { mkdir, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Store } from '../store/db.js';

/**
 * Media by record id: the client never sends a file path. Every resolved
 * path goes through a realpath containment check (fixtures/ or data/ under
 * the repo root) so `..`, encoded traversal and stray symlinks all 404.
 * Thumbnails are generated once and cached under artifacts/web-cache/.
 */

export type MediaKind = 'output' | 'thumb' | 'source' | 'template' | 'logo' | 'frame';

export const MEDIA_KINDS: MediaKind[] = ['output', 'thumb', 'source', 'template', 'logo', 'frame'];

export interface MediaDeps {
  repoRoot: string;
  dbPath: string;
}

export interface MediaFile {
  file: string;
  contentType: string;
}

const rootRealCache = new Map<string, string>();

async function repoReal(repoRoot: string): Promise<string> {
  const hit = rootRealCache.get(repoRoot);
  if (hit) return hit;
  const real = await realpath(repoRoot);
  rootRealCache.set(repoRoot, real);
  return real;
}

/** Realpath + containment: null when missing, escaping, or outside allowlist. */
async function contained(repoRoot: string, abs: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return null;
  }
  const root = await repoReal(repoRoot);
  const rel = relative(root, real);
  if (!rel || rel.startsWith('..')) return null;
  const top = rel.split('/')[0];
  if (top !== 'fixtures' && top !== 'artifacts' && top !== 'data') return null;
  return real;
}

function contentTypeFor(path: string): string | null {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return null;
}

async function cacheDir(repoRoot: string): Promise<string> {
  const d = join(repoRoot, 'artifacts', 'web-cache');
  await mkdir(d, { recursive: true });
  return d;
}

async function ensureThumb(repoRoot: string, key: string, srcFile: string): Promise<string> {
  const dir = await cacheDir(repoRoot);
  const safe = key.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const out = join(dir, `thumb-${safe}.png`);
  if (!existsSync(out)) {
    await sharp(srcFile).resize({ width: 480, withoutEnlargement: true }).png().toFile(out);
  }
  return out;
}

/** Numeric ids address outputs; string ids address sources/templates/brands. */
export async function resolveMedia(deps: MediaDeps, kind: MediaKind, idRaw: string): Promise<MediaFile | null> {
  const store = Store.open(deps.dbPath);
  try {
    if (kind === 'output' || kind === 'thumb') {
      if (!/^\d+$/.test(idRaw)) return null;
      const output = store.getOutput(Number(idRaw));
      if (!output) return null;
      const file = await contained(deps.repoRoot, resolve(deps.repoRoot, output.image_path));
      if (!file) return null;
      if (kind === 'output') {
        const ct = contentTypeFor(file);
        return ct ? { file, contentType: ct } : null;
      }
      try {
        const thumb = await ensureThumb(deps.repoRoot, `o${idRaw}`, file);
        return { file: thumb, contentType: 'image/png' };
      } catch {
        return null;
      }
    }

    if (!/^[A-Za-z0-9_-]+$/.test(idRaw)) return null;
    let rel: string | null = null;
    if (kind === 'source') {
      rel = store.getSource(idRaw)?.image_path ?? null;
    } else if (kind === 'template') {
      rel = store.getTemplate(idRaw)?.image_path ?? null;
    } else if (kind === 'logo') {
      rel = store.getBrand(idRaw)?.logo_path ?? null;
    } else if (kind === 'frame') {
      rel = store.getTemplate(idRaw)?.frame_path ?? null;
    }
    if (!rel) return null;
    const file = await contained(deps.repoRoot, resolve(deps.repoRoot, rel));
    if (!file) return null;
    const ct = contentTypeFor(file);
    return ct ? { file, contentType: ct } : null;
  } finally {
    store.close();
  }
}

/** Source element masks (grayscale PNGs written by the pipeline). */
export async function resolveMask(deps: MediaDeps, sourceId: string, maskId: string): Promise<MediaFile | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(sourceId) || !/^[A-Za-z0-9_-]+$/.test(maskId)) return null;
  const store = Store.open(deps.dbPath);
  try {
    const source = store.getSource(sourceId);
    if (!source?.masks_json) return null;
    let map: Record<string, string>;
    try {
      map = JSON.parse(source.masks_json) as Record<string, string>;
    } catch {
      return null;
    }
    const rel = map[maskId];
    if (!rel) return null;
    const file = await contained(deps.repoRoot, resolve(deps.repoRoot, rel));
    if (!file) return null;
    return { file, contentType: 'image/png' };
  } finally {
    store.close();
  }
}

export async function readContainedFile(repoRoot: string, relPath: string): Promise<Buffer | null> {
  const file = await contained(repoRoot, resolve(repoRoot, relPath));
  if (!file) return null;
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}
