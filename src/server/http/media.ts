import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { Store, type SnapshotRow } from '../store/db.js';
import { decodeRgba } from '../repair/composite.js';

/**
 * Media by record id: the client never sends a file path. Every resolved
 * path goes through a realpath containment check (fixtures/, artifacts/ or
 * data/ under the repo root) so `..`, encoded traversal and stray symlinks
 * all 404. Thumbnails and diff heatmaps are generated once and cached under
 * artifacts/web-cache/ (gitignored).
 */

export type MediaKind =
  | 'ad'
  | 'thumb'
  | 'before'
  | 'after'
  | 'panel'
  | 'mask-product'
  | 'mask-logo'
  | 'mask-protected'
  | 'diff'
  | 'pagecap';

export const MEDIA_KINDS: MediaKind[] = [
  'ad', 'thumb', 'before', 'after', 'panel',
  'mask-product', 'mask-logo', 'mask-protected', 'diff', 'pagecap',
];

export interface MediaDeps {
  repoRoot: string;
  dbPath: string;
  /** Manifest image path for old snapshots that predate snapshot_source. */
  sourceFallback: (adKey: string) => string | null;
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

const REPAIR_FILES: Record<string, string> = {
  before: 'before.png',
  after: 'after.png',
  panel: 'panel.png',
  'mask-product': 'mask-product.png',
  'mask-logo': 'mask-logo.png',
  'mask-protected': 'mask-protected.png',
};

function safeKey(adKey: string): string {
  return adKey.replace(/[^a-zA-Z0-9_-]+/g, '-');
}

/** Repair dir: the DB artifact_dir, else the conventional run dir (refusals). */
function repairDir(repoRoot: string, snapshot: SnapshotRow, artifactDir: string | null): string | null {
  if (artifactDir) {
    const d = join(repoRoot, artifactDir);
    if (existsSync(d)) return d;
  }
  const d = join(repoRoot, 'artifacts', 'sweep', `run-${snapshot.run_id}`, safeKey(snapshot.ad_key), 'repair');
  return existsSync(d) ? d : null;
}

async function cacheDir(repoRoot: string): Promise<string> {
  const d = join(repoRoot, 'artifacts', 'web-cache');
  await mkdir(d, { recursive: true });
  return d;
}

async function ensureThumb(repoRoot: string, snapshotId: number, srcFile: string): Promise<string> {
  const dir = await cacheDir(repoRoot);
  const out = join(dir, `thumb-${snapshotId}.png`);
  if (!existsSync(out)) {
    await sharp(srcFile).resize({ width: 480, withoutEnlargement: true }).png().toFile(out);
  }
  return out;
}

interface DiffInputs {
  dir: string;
  rect: { x: number; y: number; w: number; h: number };
}

/**
 * Heatmap: dimmed repaired image + green protected mask + magenta changed
 * pixels. Pure function of the stored repair files.
 */
export async function buildDiffPng(repoRoot: string, snapshotId: number, inputs: DiffInputs): Promise<string | null> {
  const before = await decodeRgba(await readFile(join(inputs.dir, 'before.png')));
  const after = await decodeRgba(await readFile(join(inputs.dir, 'after.png')));
  const maskRaw = await sharp(join(inputs.dir, 'mask-protected.png')).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (before.width !== after.width || before.height !== after.height) return null;
  if (maskRaw.info.width !== before.width || maskRaw.info.height !== before.height) return null;
  const { width, height } = before;
  const out = Buffer.alloc(width * height * 4);
  const x1 = Math.round(inputs.rect.x);
  const y1 = Math.round(inputs.rect.y);
  const x2 = Math.round(inputs.rect.x + inputs.rect.w);
  const y2 = Math.round(inputs.rect.y + inputs.rect.h);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const o = i * 4;
      const changed =
        before.data[o] !== after.data[o] || before.data[o + 1] !== after.data[o + 1] || before.data[o + 2] !== after.data[o + 2];
      const inRect = x >= x1 && x < x2 && y >= y1 && y < y2;
      let r = Math.round((after.data[o] as number) * 0.45);
      let g = Math.round((after.data[o + 1] as number) * 0.45);
      let b = Math.round((after.data[o + 2] as number) * 0.45);
      if (maskRaw.data[i]) {
        r = Math.round(r * 0.45 + 0 * 0.55);
        g = Math.round(g * 0.45 + 200 * 0.55);
        b = Math.round(b * 0.45 + 110 * 0.55);
      }
      if (changed && inRect) {
        r = Math.round(r * 0.2 + 255 * 0.8);
        g = Math.round(g * 0.2 + 0 * 0.8);
        b = Math.round(b * 0.2 + 200 * 0.8);
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  const dir = await cacheDir(repoRoot);
  const dest = join(dir, `diff-${snapshotId}.png`);
  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(dest);
  return dest;
}

async function ensureDiff(repoRoot: string, snapshot: SnapshotRow, artifactDir: string | null): Promise<string | null> {
  const dir = await cacheDir(repoRoot);
  const dest = join(dir, `diff-${snapshot.id}.png`);
  if (existsSync(dest)) return dest;
  const rdir = repairDir(repoRoot, snapshot, artifactDir);
  if (!rdir) return null;
  let rect: DiffInputs['rect'] | null = null;
  try {
    const pj = JSON.parse(await readFile(join(rdir, 'proof.json'), 'utf8')) as { rect?: DiffInputs['rect'] };
    if (pj?.rect) rect = pj.rect;
  } catch {
    return null;
  }
  if (!rect) return null;
  for (const f of ['before.png', 'after.png', 'mask-protected.png']) {
    if (!existsSync(join(rdir, f))) return null;
  }
  try {
    return await buildDiffPng(repoRoot, snapshot.id, { dir: rdir, rect });
  } catch {
    return null;
  }
}

export async function resolveMedia(
  deps: MediaDeps,
  kind: MediaKind,
  idRaw: string,
  shotRaw: string | undefined,
): Promise<MediaFile | null> {
  if (!/^\d+$/.test(idRaw)) return null;
  const id = Number(idRaw);
  const store = Store.open(deps.dbPath);
  try {
    const snapshot = store.getSnapshot(id);
    if (!snapshot) return null;

    if (kind === 'pagecap') {
      const capture = store.getCapture(id);
      if (!capture) return null;
      let paths: string[];
      try {
        paths = JSON.parse(capture.screenshot_paths) as string[];
      } catch {
        return null;
      }
      if (!Array.isArray(paths) || paths.length === 0) return null;
      const shot = shotRaw === undefined ? 0 : /^\d+$/.test(shotRaw) ? Number(shotRaw) : -1;
      if (shot < 0 || shot >= paths.length) return null;
      const file = await contained(deps.repoRoot, resolve(deps.repoRoot, paths[shot] as string));
      if (!file) return null;
      const ct = contentTypeFor(file);
      return ct ? { file, contentType: ct } : null;
    }

    if (kind === 'ad' || kind === 'thumb') {
      const rel = store.getSource(id) ?? deps.sourceFallback(snapshot.ad_key);
      if (!rel) return null;
      const file = await contained(deps.repoRoot, resolve(deps.repoRoot, rel));
      if (!file) return null;
      if (kind === 'ad') {
        const ct = contentTypeFor(file);
        return ct ? { file, contentType: ct } : null;
      }
      try {
        const thumb = await ensureThumb(deps.repoRoot, id, file);
        return { file: thumb, contentType: 'image/png' };
      } catch {
        return null;
      }
    }

    if (kind === 'diff') {
      const repair = store.getRepair(id);
      const dest = await ensureDiff(deps.repoRoot, snapshot, repair?.artifact_dir ?? null);
      if (!dest) return null;
      return { file: dest, contentType: 'image/png' };
    }

    const name = REPAIR_FILES[kind];
    if (!name) return null;
    const repair = store.getRepair(id);
    const dir = repairDir(deps.repoRoot, snapshot, repair?.artifact_dir ?? null);
    if (!dir) return null;
    const file = await contained(deps.repoRoot, join(dir, name));
    if (!file) return null;
    return { file, contentType: 'image/png' };
  } finally {
    store.close();
  }
}
