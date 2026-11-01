import type OpenAI from 'openai';
import { buildBoxPromptText, segment } from '../models/sam.js';
import { maskArea, maskBoundingBox, unionMasks, type PixelBox } from '../../shared/geometry.js';
import type { RgbaImage } from './composite.js';

export const DILATE_PX = 4;
/** A mask whose fill inside its own bbox is below this is unusable. */
export const TINY_MASK_FILL = 0.2;

export interface MaskTarget {
  /** Stable id, e.g. "product-0" or "logo". */
  id: string;
  /** Noun phrase for the SAM phrase prompt, e.g. "bottle". */
  phrase: string;
  /** Spark box for the box prompt, or null for phrase-only. */
  box: PixelBox | null;
}

export interface MasksInput {
  imageBytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  targets: MaskTarget[];
}

export interface MasksResult {
  masks: Map<string, Uint8Array>;
  blockers: string[];
  labels: Record<string, string>;
  latencyMs: number;
  calls: number;
}

function usableBox(b: PixelBox | null): b is PixelBox {
  return !!b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.w > 0 && b.h > 0;
}

/**
 * Segment one target: the union of the phrase mask with a box prompt on
 * Spark's box (the phrase alone misses parts — e.g. "logo" sees the circle
 * mark but not the wordmark). Phrase-only when no box is known.
 */
export async function segmentTarget(
  client: OpenAI,
  input: MasksInput,
  target: MaskTarget,
): Promise<{ mask: Uint8Array; labels: string[]; calls: number; latencyMs: number }> {
  const base = {
    imageBytes: input.imageBytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    model: input.model,
  };
  const phrase = await segment(client, { ...base, inputText: target.phrase });
  let mask = phrase.mask;
  let calls = 1;
  let latencyMs = phrase.latencyMs;
  const labels = [`phrase "${target.phrase}"`];
  if (usableBox(target.box)) {
    const boxed = await segment(client, { ...base, inputText: buildBoxPromptText(target.box, input.width, input.height) });
    calls++;
    latencyMs += boxed.latencyMs;
    mask = unionMasks(mask, boxed.mask);
    labels.push(`box ${JSON.stringify(target.box)}`);
  }
  return { mask, labels, calls, latencyMs };
}

/**
 * Quality gates per target. Each target is judged on its OWN bbox fill —
 * never on a union bbox, which is inherently sparse when elements sit far
 * apart. Empty/tiny results are blockers, never silent.
 */
export function maskBlockers(masks: Map<string, Uint8Array>, width: number, height: number): string[] {
  const blockers: string[] = [];
  for (const [id, mask] of masks) {
    if (maskArea(mask) === 0) {
      blockers.push(`mask_empty:${id}`);
      continue;
    }
    const box = maskBoundingBox(mask, width, height);
    const fill = box ? maskArea(mask) / (box.w * box.h) : 0;
    if (fill < TINY_MASK_FILL) blockers.push(`mask_tiny:${id}`);
  }
  return blockers;
}

/**
 * Complete a logo mask by contrast. SAM sometimes returns only part of a
 * lockup (the mark but half the wordmark). Logos are high-contrast graphics,
 * so within Spark's logo box we add every pixel that differs strongly from
 * the box background — but only within `dilatePx` of the SAM core, so far
 * background texture can never join. Returns the grown mask.
 */
export function growLogoMask(rgba: RgbaImage, mask: Uint8Array, box: PixelBox, dilatePx = 25, threshold = 48): Uint8Array {
  const { width: W, height: H } = rgba;
  const x1 = Math.max(0, Math.min(W - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(H - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(W, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(H, Math.round(box.y + box.h)));
  // Background = median of the box border pixels (the lockup never touches all four borders).
  const border: Array<[number, number]> = [];
  for (let x = x1; x < x2; x++) {
    border.push([x, y1], [x, y2 - 1]);
  }
  for (let y = y1 + 1; y < y2 - 1; y++) {
    border.push([x1, y], [x2 - 1, y]);
  }
  const chan = (c: number): number => {
    const vals = border.map(([x, y]) => rgba.data[(y * W + x) * 4 + c] as number).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] ?? 255;
  };
  const bg: [number, number, number] = [chan(0), chan(1), chan(2)];
  const isInk = (x: number, y: number): boolean => {
    const o = (y * W + x) * 4;
    return (
      Math.abs((rgba.data[o] as number) - bg[0]) > threshold ||
      Math.abs((rgba.data[o + 1] as number) - bg[1]) > threshold ||
      Math.abs((rgba.data[o + 2] as number) - bg[2]) > threshold
    );
  };
  // BFS outward from SAM core pixels, bounded by dilatePx and the box.
  const out = Uint8Array.from(mask);
  const depth = new Int16Array(W * H).fill(-1);
  const queue: number[] = [];
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (mask[y * W + x]) {
        depth[y * W + x] = 0;
        queue.push(y * W + x);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++] as number;
    const d = depth[i] as number;
    if (d >= dilatePx) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < x1 || nx >= x2 || ny < y1 || ny >= y2) continue;
      const ni = ny * W + nx;
      if (depth[ni] !== -1) continue;
      depth[ni] = d + 1;
      if (!out[ni] && isInk(nx, ny)) {
        out[ni] = 1;
        queue.push(ni);
      } else if (out[ni]) {
        queue.push(ni);
      }
      // Non-ink pixels are traversed (depth recorded) but never added, so
      // the grow can cross small gaps between letters.
      if (!out[ni] && !isInk(nx, ny)) queue.push(ni);
    }
  }
  return out;
}

/** Segment every target; see segmentTarget for the phrase+box union rule. */
export async function segmentTargets(client: OpenAI, input: MasksInput): Promise<MasksResult> {
  const masks = new Map<string, Uint8Array>();
  const labels: Record<string, string> = {};
  let calls = 0;
  let latencyMs = 0;
  for (const target of input.targets) {
    const r = await segmentTarget(client, input, target);
    masks.set(target.id, r.mask);
    labels[target.id] = r.labels.join(' + ');
    calls += r.calls;
    latencyMs += r.latencyMs;
  }
  return { masks, blockers: maskBlockers(masks, input.width, input.height), labels, latencyMs, calls };
}
