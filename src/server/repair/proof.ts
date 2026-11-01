import { sha256Hex } from '../models/client.js';
import type { PixelBox } from '../../shared/geometry.js';
import type { RgbaImage } from './composite.js';

export interface PixelProof {
  changed_outside_rect: number;
  changed_inside_protected: number;
  max_channel_diff_outside: number;
  width: number;
  height: number;
  pass: boolean;
}

/**
 * Pixel proof on raw RGBA of before vs after: nothing may change outside the
 * edit rectangle, nothing may change inside the protected mask, and the
 * dimensions must be identical. Any non-zero rejects the repair.
 */
export function pixelProof(
  before: RgbaImage,
  after: RgbaImage,
  rect: PixelBox,
  prot: Uint8Array,
): PixelProof {
  const width = before.width;
  const height = before.height;
  const sameDims = before.width === after.width && before.height === after.height;
  let changed_outside_rect = 0;
  let changed_inside_protected = 0;
  let max_channel_diff_outside = 0;
  if (sameDims && prot.length === width * height) {
    const x1 = Math.round(rect.x);
    const y1 = Math.round(rect.y);
    const x2 = Math.round(rect.x + rect.w);
    const y2 = Math.round(rect.y + rect.h);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const o = i * 4;
        const dr = Math.abs((before.data[o] as number) - (after.data[o] as number));
        const dg = Math.abs((before.data[o + 1] as number) - (after.data[o + 1] as number));
        const db = Math.abs((before.data[o + 2] as number) - (after.data[o + 2] as number));
        const changed = dr !== 0 || dg !== 0 || db !== 0;
        if (!changed) continue;
        const insideRect = x >= x1 && x < x2 && y >= y1 && y < y2;
        if (!insideRect) {
          changed_outside_rect++;
          const m = Math.max(dr, dg, db);
          if (m > max_channel_diff_outside) max_channel_diff_outside = m;
        }
        if (prot[i]) changed_inside_protected++;
      }
    }
  }
  const pass =
    sameDims &&
    prot.length === width * height &&
    changed_outside_rect === 0 &&
    changed_inside_protected === 0 &&
    max_channel_diff_outside === 0;
  return {
    changed_outside_rect,
    changed_inside_protected,
    max_channel_diff_outside,
    width,
    height,
    pass,
  };
}

export interface ArtifactDigest {
  sha256: string;
  tag: string;
  /** Approval binds to this later: image hash + tag. */
  digest: string;
}

/** `artifact_digest = sha256(png bytes) + tag` (e.g. the job/output id). */
export function artifactDigest(png: Buffer, tag: string): ArtifactDigest {
  const sha256 = sha256Hex(png);
  return { sha256, tag, digest: `${sha256}:${tag}` };
}

// --- MatchPic element proof ---

export interface ElementProofInput {
  /** Source cutout BEFORE scaling (RGBA, alpha = mask). */
  sourceCut: RgbaImage;
  /** Finished output (RGBA), same size as the composited canvas. */
  output: RgbaImage;
  /** Where the scaled cutout was pasted (top-left in output pixels). */
  left: number;
  top: number;
  /** Recorded uniform scale (never a stretch). */
  scale: number;
  /** Feather width used at paste time (proof erodes the core by this). */
  featherPx: number;
}

export interface ElementProof {
  scale: number;
  /** Pixels inside the eroded core that differ from the transformed source. Must be 0. */
  core_differ: number;
  core_total: number;
  /** Pixels in the feather ring (allowed to blend; reported, not gated). */
  feather_total: number;
  /** Compared-pixel coverage: core_total / (core_total + feather_total). */
  coverage: number;
  pass: boolean;
}

/**
 * Per-element proof: the pasted pixels equal the source pixels after the
 * recorded uniform scale — 0 differing pixels inside the mask core. The core
 * is the scaled mask eroded by `featherPx` (the soft 1-2 px edge feather is
 * allowed only outside it). Nearest-neighbor resampling mirrors the paste.
 */
export function elementProof(input: ElementProofInput): ElementProof {
  const { sourceCut, output, left, top, scale, featherPx } = input;
  const sw = Math.max(1, Math.round(sourceCut.width * scale));
  const sh = Math.max(1, Math.round(sourceCut.height * scale));
  const at = (img: RgbaImage, x: number, y: number, c: number): number => img.data[(y * img.width + x) * 4 + c] as number;
  const srcOpaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < sourceCut.width && y < sourceCut.height && at(sourceCut, x, y, 3) > 0;
  // Scaled opacity + core test (opaque in the scale-sized neighborhood eroded by featherPx).
  const scaledOpaque = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= sw || y >= sh) return false;
    return srcOpaque(Math.min(sourceCut.width - 1, Math.floor(x / scale)), Math.min(sourceCut.height - 1, Math.floor(y / scale)));
  };
  const inCore = (x: number, y: number): boolean => {
    if (!scaledOpaque(x, y)) return false;
    for (let dy = -featherPx; dy <= featherPx; dy++) {
      for (let dx = -featherPx; dx <= featherPx; dx++) {
        if (!scaledOpaque(x + dx, y + dy)) return false;
      }
    }
    return true;
  };
  let core_differ = 0;
  let core_total = 0;
  let feather_total = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (!scaledOpaque(x, y)) continue;
      const ox = left + x;
      const oy = top + y;
      if (ox < 0 || oy < 0 || ox >= output.width || oy >= output.height) continue;
      if (!inCore(x, y)) {
        feather_total++;
        continue;
      }
      core_total++;
      const sx = Math.min(sourceCut.width - 1, Math.floor(x / scale));
      const sy = Math.min(sourceCut.height - 1, Math.floor(y / scale));
      if (at(sourceCut, sx, sy, 0) !== at(output, ox, oy, 0) || at(sourceCut, sx, sy, 1) !== at(output, ox, oy, 1) || at(sourceCut, sx, sy, 2) !== at(output, ox, oy, 2)) {
        core_differ++;
      }
    }
  }
  const compared = core_total + feather_total;
  return {
    scale,
    core_differ,
    core_total,
    feather_total,
    coverage: compared > 0 ? core_total / compared : 0,
    pass: core_total > 0 && core_differ === 0,
  };
}
