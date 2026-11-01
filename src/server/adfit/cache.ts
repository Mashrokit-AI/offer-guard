import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { sourceAnalysisSchema, type SourceAnalysis } from '../../shared/schemas.js';

/**
 * Source layer cache, keyed by source digest (sha256 of the source bytes).
 * Analysis + full-frame SAM masks are reused across jobs/regenerations:
 * a cache hit skips every model call in prepareSource (trace cached:true).
 */

export function sourceDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Layer cache format version. Bump when mask semantics change (v2: product
 * masks are clipped to their own Spark box + margin, so one phrase match can
 * no longer merge two products into one cut; v3: enclosed holes filled +
 * sparse masks retried box-only). A mismatch re-segments.
 */
export const LAYERS_VERSION = 3;

export interface CachedLayers {
  digest: string;
  width: number;
  height: number;
  analysis: SourceAnalysis;
  masks: Map<string, Uint8Array>;
  maskLabels: Record<string, string>;
}

async function readMaskPng(abs: string, width: number, height: number): Promise<Uint8Array | null> {
  try {
    const { data, info } = await sharp(abs).raw().toBuffer({ resolveWithObject: true });
    if (info.width !== width || info.height !== height) return null;
    const out = new Uint8Array(width * height);
    const channels = info.channels;
    for (let i = 0; i < width * height; i++) out[i] = (data[i * channels] as number) > 0 ? 1 : 0;
    return out;
  } catch {
    return null;
  }
}

/** Load cached layers for a digest, or null on any miss/mismatch. Never throws. */
export async function loadCachedLayers(
  repoRoot: string,
  digest: string,
  width: number,
  height: number,
): Promise<CachedLayers | null> {
  try {
    const dir = join(repoRoot, 'data', 'layers', digest);
    const meta = JSON.parse(await readFile(join(dir, 'analysis.json'), 'utf8')) as {
      analysis: unknown;
      maskLabels: Record<string, string>;
      masks: string[];
      width: number;
      height: number;
      version?: number;
    };
    if (meta.width !== width || meta.height !== height) return null;
    if (meta.version !== LAYERS_VERSION) return null;
    const analysis = sourceAnalysisSchema.parse(meta.analysis);
    const masks = new Map<string, Uint8Array>();
    for (const id of meta.masks) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
      const mask = await readMaskPng(join(dir, `${id}.png`), width, height);
      if (!mask) return null;
      masks.set(id, mask);
    }
    return { digest, width, height, analysis, masks, maskLabels: meta.maskLabels ?? {} };
  } catch {
    return null;
  }
}

/** Persist layers for a digest. Never throws (cache is best-effort). */
export async function storeCachedLayers(
  repoRoot: string,
  layers: { digest: string; width: number; height: number; analysis: SourceAnalysis; masks: Map<string, Uint8Array>; maskLabels: Record<string, string> },
): Promise<void> {
  try {
    const dir = join(repoRoot, 'data', 'layers', layers.digest);
    await mkdir(dir, { recursive: true });
    for (const [id, mask] of layers.masks) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
      const px = Buffer.alloc(mask.length);
      for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
      await sharp(px, { raw: { width: layers.width, height: layers.height, channels: 1 } })
        .png()
        .toFile(join(dir, `${id}.png`));
    }
    await writeFile(
      join(dir, 'analysis.json'),
      JSON.stringify({ version: LAYERS_VERSION, analysis: layers.analysis, maskLabels: layers.maskLabels, masks: [...layers.masks.keys()], width: layers.width, height: layers.height }),
    );
  } catch {
    // Best-effort: a failed cache write never fails the job.
  }
}
