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
  specVersion: number;
  /** Approval binds to this later: image hash + spec version. */
  digest: string;
}

/** `artifact_digest = sha256(after.png bytes) + spec version`. */
export function artifactDigest(afterPng: Buffer, specVersion: number): ArtifactDigest {
  const sha256 = sha256Hex(afterPng);
  return { sha256, specVersion, digest: `${sha256}:spec-v${specVersion}` };
}
