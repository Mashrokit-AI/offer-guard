import type { BBox } from './schemas.js';

/** Half-open pixel box: covers [x, x+w) x [y, y+h). */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function asPixelBox(b: BBox): PixelBox {
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

export function boxArea(b: PixelBox): number {
  return Math.max(0, b.w) * Math.max(0, b.h);
}

export function boxIntersectionArea(a: PixelBox, b: PixelBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

/** Intersection-over-union of two half-open boxes; 0 when either is empty. */
export function boxIoU(a: PixelBox, b: PixelBox): number {
  const inter = boxIntersectionArea(a, b);
  const union = boxArea(a) + boxArea(b) - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/** Coordinate systems a model might return boxes in. */
export type CoordSystem = 'pixels' | '1000' | 'unit';

/**
 * Detect which coordinate system a set of boxes uses, WITHOUT ground truth.
 * - every value within [0, 1]              -> 'unit' (0-1, scale by frame size)
 * - any value above 1000 (or below 0)     -> 'pixels' (normalized never exceeds 1000)
 * - otherwise (all within [0, 1000])      -> ambiguous: a pixel reading on a
 *   1080 frame is often entirely <= 1000, so default to 'pixels' (the prompted
 *   system) unless fractional values betray a computed normalized scale.
 *
 * Empty input defaults to 'pixels' (nothing to convert). Callers must report
 * the detected system so a human can audit the choice.
 */
export function detectCoordinateSystem(boxes: readonly PixelBox[]): CoordSystem {
  const values: number[] = [];
  for (const b of boxes) values.push(b.x, b.y, b.w, b.h);
  if (values.length === 0) return 'pixels';
  if (values.every((v) => v >= 0 && v <= 1)) return 'unit';
  if (values.some((v) => v > 1000 || v < 0)) return 'pixels';
  return values.some((v) => !Number.isInteger(v)) ? '1000' : 'pixels';
}

/** Convert one box from the detected system into source pixels (rounded). */
export function convertBoxToPixels(box: PixelBox, system: CoordSystem, frameW: number, frameH: number): PixelBox {
  if (system === 'pixels') return roundBox(box);
  if (system === 'unit') {
    return roundBox({ x: box.x * frameW, y: box.y * frameH, w: box.w * frameW, h: box.h * frameH });
  }
  return roundBox({
    x: (box.x / 1000) * frameW,
    y: (box.y / 1000) * frameH,
    w: (box.w / 1000) * frameW,
    h: (box.h / 1000) * frameH,
  });
}

export function roundBox(b: PixelBox): PixelBox {
  return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
}

/** Half-open bounds as reported by the SAM parser ({left, top, right, bottom}). */
export interface MaskBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function boundsToBox(b: MaskBounds): PixelBox {
  return { x: b.left, y: b.top, w: Math.max(0, b.right - b.left), h: Math.max(0, b.bottom - b.top) };
}

/**
 * Place an HxW binary raster into a full-frame mask at the top-left of `bounds`,
 * clipped to the frame. (The SAM API emits rasters whose size matches their
 * bounds; top-left placement degrades gracefully if they ever differ.)
 */
export function placeRasterInFrame(
  raster: Uint8Array,
  rasterW: number,
  rasterH: number,
  bounds: MaskBounds,
  frameW: number,
  frameH: number,
): Uint8Array {
  const frame = new Uint8Array(frameW * frameH);
  for (let ry = 0; ry < rasterH; ry++) {
    const fy = bounds.top + ry;
    if (fy < 0 || fy >= frameH) continue;
    for (let rx = 0; rx < rasterW; rx++) {
      const fx = bounds.left + rx;
      if (fx < 0 || fx >= frameW) continue;
      if (raster[ry * rasterW + rx]) frame[fy * frameW + fx] = 1;
    }
  }
  return frame;
}

/** Pixel-wise OR of two same-size masks. */
export function unionMasks(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) throw new Error(`unionMasks: size mismatch ${a.length} vs ${b.length}`);
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] || b[i] ? 1 : 0;
  return out;
}

/**
 * Binary dilation with a square structuring element of Chebyshev radius `r`
 * (a pixel is set when any pixel within r steps in x and y is set).
 * Separable row/column passes, O(n*r).
 */
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return Uint8Array.from(mask);
  const row = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = false;
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (mask[y * w + xx]) {
          hit = true;
          break;
        }
      }
      row[y * w + x] = hit ? 1 : 0;
    }
  }
  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let hit = false;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        if (row[yy * w + x]) {
          hit = true;
          break;
        }
      }
      out[y * w + x] = hit ? 1 : 0;
    }
  }
  return out;
}

export function maskArea(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** Tight half-open bbox of the set pixels, or null when the mask is empty. */
export function maskBoundingBox(mask: Uint8Array, w: number, h: number): PixelBox | null {
  let x1 = w;
  let y1 = h;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) return null;
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

/** Count of set mask pixels inside a half-open rect (rect clipped to frame). */
export function countMaskInRect(mask: Uint8Array, w: number, h: number, rect: PixelBox): number {
  const x1 = Math.max(0, Math.round(rect.x));
  const y1 = Math.max(0, Math.round(rect.y));
  const x2 = Math.min(w, Math.round(rect.x + rect.w));
  const y2 = Math.min(h, Math.round(rect.y + rect.h));
  let n = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (mask[y * w + x]) n++;
    }
  }
  return n;
}
