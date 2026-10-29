import type { PixelBox } from '../../shared/geometry.js';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PanelSnap {
  /** Exact edit rectangle: bbox of the connected fill region (half-open). */
  rect: PixelBox;
  /** Sampled panel fill color (mean of the dominant bucket). */
  fill: Rgb;
  /** Sampled text color (dominant non-fill color inside the rect). */
  textColor: Rgb;
  /** Estimated corner radius in px. */
  radius: number;
  /** Opaque gate: border band is uniform fill. False → blocker `panel_not_opaque`. */
  opaque: boolean;
  /** Fraction of border-band pixels matching the fill (gate needs ≥ 0.97). */
  matchFraction: number;
  /** Max per-channel stddev across the border band (gate needs low variance). */
  fillStddev: number;
}

export class PanelSnapError extends Error {
  readonly blocker = 'panel_not_found' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PanelSnapError';
  }
}

/** Per-channel tolerance for growing the fill region (ad-03 shades differ by ≤13). */
const REGION_TOL = 16;
/** Initial search margin beyond the rough box; grows while the region touches it. */
const SEARCH_MARGIN = 40;
/** Per-channel tolerance for the opaque border-band check. */
const OPAQUE_TOL = 8;
/** Border band width just inside the rect edges. */
const BAND = 6;
const OPAQUE_MIN_FRACTION = 0.97;
const OPAQUE_MAX_STDDEV = 6;

function pxAt(img: Uint8Array | Buffer, w: number, x: number, y: number): [number, number, number] {
  const o = (y * w + x) * 4;
  return [img[o] as number, img[o + 1] as number, img[o + 2] as number];
}

function matches(c: [number, number, number], fill: Rgb, tol: number): boolean {
  return (
    Math.abs(c[0] - fill.r) <= tol && Math.abs(c[1] - fill.g) <= tol && Math.abs(c[2] - fill.b) <= tol
  );
}

function clampBox(b: PixelBox, w: number, h: number): PixelBox {
  const x1 = Math.min(Math.max(0, Math.round(b.x)), w);
  const y1 = Math.min(Math.max(0, Math.round(b.y)), h);
  const x2 = Math.min(Math.max(x1, Math.round(b.x + b.w)), w);
  const y2 = Math.min(Math.max(y1, Math.round(b.y + b.h)), h);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * Dominant color inside a box: peak of a coarse histogram, refined to the
 * mean of its pixels. The panel fill always outnumbers the text, so the peak
 * is the fill, never the glyphs.
 */
function dominantColor(img: Uint8Array | Buffer, w: number, box: PixelBox): Rgb {
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = box.y; y < box.y + box.h; y += 2) {
    for (let x = box.x; x < box.x + box.w; x += 2) {
      const [r, g, b] = pxAt(img, w, x, y);
      const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3);
      let e = hist.get(key);
      if (!e) {
        e = { n: 0, r: 0, g: 0, b: 0 };
        hist.set(key, e);
      }
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of hist.values()) {
    if (!best || e.n > best.n) best = e;
  }
  if (!best) throw new PanelSnapError('empty rough box: cannot estimate the panel fill color');
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

/** Fill pixel nearest the box center — the flood seed (center itself may be text). */
function findSeed(
  img: Uint8Array | Buffer,
  w: number,
  box: PixelBox,
  fill: Rgb,
): { x: number; y: number } | null {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (!matches(pxAt(img, w, x, y), fill, REGION_TOL)) continue;
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (!best || d < best.d) best = { x, y, d };
    }
  }
  return best;
}

interface Flood {
  mask: Uint8Array;
  touchesEdge: boolean;
  area: number;
}

/** 4-connected flood fill of the fill-tolerance region, clipped to `win`. */
function flood(
  img: Uint8Array | Buffer,
  w: number,
  h: number,
  seed: { x: number; y: number },
  fill: Rgb,
  win: PixelBox,
): Flood {
  const mask = new Uint8Array(w * h);
  const stack: Array<[number, number]> = [[seed.x, seed.y]];
  mask[seed.y * w + seed.x] = 1;
  let touchesEdge = false;
  let area = 0;
  const x1 = win.x;
  const y1 = win.y;
  const x2 = win.x + win.w;
  const y2 = win.y + win.h;
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [number, number];
    area++;
    if (x === x1 || x === x2 - 1 || y === y1 || y === y2 - 1) touchesEdge = true;
    if (x > x1 && !mask[y * w + x - 1] && matches(pxAt(img, w, x - 1, y), fill, REGION_TOL)) {
      mask[y * w + x - 1] = 1;
      stack.push([x - 1, y]);
    }
    if (x < x2 - 1 && !mask[y * w + x + 1] && matches(pxAt(img, w, x + 1, y), fill, REGION_TOL)) {
      mask[y * w + x + 1] = 1;
      stack.push([x + 1, y]);
    }
    if (y > y1 && !mask[(y - 1) * w + x] && matches(pxAt(img, w, x, y - 1), fill, REGION_TOL)) {
      mask[(y - 1) * w + x] = 1;
      stack.push([x, y - 1]);
    }
    if (y < y2 - 1 && !mask[(y + 1) * w + x] && matches(pxAt(img, w, x, y + 1), fill, REGION_TOL)) {
      mask[(y + 1) * w + x] = 1;
      stack.push([x, y + 1]);
    }
  }
  return { mask, touchesEdge, area };
}

function maskBBox(mask: Uint8Array, w: number, h: number): PixelBox {
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
  return { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

/**
 * Corner radius from the edge insets: on a rounded rect of radius r the top
 * row's fill starts ~r px right of the left edge (and mirrors on 8 corners).
 */
function estimateRadius(
  img: Uint8Array | Buffer,
  w: number,
  rect: PixelBox,
  fill: Rgb,
): number {
  const insets: number[] = [];
  const top = rect.y;
  const bottom = rect.y + rect.h - 1;
  const left = rect.x;
  const right = rect.x + rect.w - 1;
  for (let x = left; x <= right; x++) {
    if (matches(pxAt(img, w, x, top), fill, REGION_TOL)) {
      insets.push(x - left);
      break;
    }
  }
  for (let x = right; x >= left; x--) {
    if (matches(pxAt(img, w, x, top), fill, REGION_TOL)) {
      insets.push(right - x);
      break;
    }
  }
  for (let x = left; x <= right; x++) {
    if (matches(pxAt(img, w, x, bottom), fill, REGION_TOL)) {
      insets.push(x - left);
      break;
    }
  }
  for (let x = right; x >= left; x--) {
    if (matches(pxAt(img, w, x, bottom), fill, REGION_TOL)) {
      insets.push(right - x);
      break;
    }
  }
  for (let y = top; y <= bottom; y++) {
    if (matches(pxAt(img, w, left, y), fill, REGION_TOL)) {
      insets.push(y - top);
      break;
    }
  }
  for (let y = bottom; y >= top; y--) {
    if (matches(pxAt(img, w, left, y), fill, REGION_TOL)) {
      insets.push(bottom - y);
      break;
    }
  }
  for (let y = top; y <= bottom; y++) {
    if (matches(pxAt(img, w, right, y), fill, REGION_TOL)) {
      insets.push(y - top);
      break;
    }
  }
  for (let y = bottom; y >= top; y--) {
    if (matches(pxAt(img, w, right, y), fill, REGION_TOL)) {
      insets.push(bottom - y);
      break;
    }
  }
  if (insets.length === 0) return 0;
  const mean = insets.reduce((s, v) => s + v, 0) / insets.length;
  return Math.min(Math.max(0, Math.round(mean)), Math.floor(Math.min(rect.w, rect.h) / 2));
}

/** Dominant non-fill color inside the rect (the glyphs); white when all fill. */
function estimateTextColor(
  img: Uint8Array | Buffer,
  w: number,
  rect: PixelBox,
  fill: Rgb,
): Rgb {
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const [r, g, b] = pxAt(img, w, x, y);
      if (matches([r, g, b], fill, REGION_TOL)) continue;
      const key = (r >> 4) * 256 + (g >> 4) * 16 + (b >> 4);
      let e = hist.get(key);
      if (!e) {
        e = { n: 0, r: 0, g: 0, b: 0 };
        hist.set(key, e);
      }
      e.n++;
      e.r += r;
      e.g += g;
      e.b += b;
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const e of hist.values()) {
    if (!best || e.n > best.n) best = e;
  }
  if (!best) return { r: 255, g: 255, b: 255 };
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

interface OpaqueCheck {
  opaque: boolean;
  matchFraction: number;
  stddev: number;
}

/**
 * Opaque gate: on a band just inside the rect edges (rounded corners
 * excluded), ≥97% of pixels must match the fill with low variance. A
 * semi-transparent panel over the product fails both.
 */
function checkOpaque(
  img: Uint8Array | Buffer,
  w: number,
  rect: PixelBox,
  fill: Rgb,
  radius: number,
): OpaqueCheck {
  const skip = radius + 2;
  let n = 0;
  let match = 0;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let s2r = 0;
  let s2g = 0;
  let s2b = 0;
  const eat = (x: number, y: number) => {
    const [r, g, b] = pxAt(img, w, x, y);
    n++;
    if (matches([r, g, b], fill, OPAQUE_TOL)) match++;
    sr += r;
    sg += g;
    sb += b;
    s2r += r * r;
    s2g += g * g;
    s2b += b * b;
  };
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  for (let d = 0; d < BAND; d++) {
    for (let x = x1 + skip; x < x2 - skip; x++) {
      eat(x, y1 + d);
      eat(x, y2 - 1 - d);
    }
    for (let y = y1 + skip; y < y2 - skip; y++) {
      eat(x1 + d, y);
      eat(x2 - 1 - d, y);
    }
  }
  if (n === 0) return { opaque: false, matchFraction: 0, stddev: Number.POSITIVE_INFINITY };
  const variance = (s: number, s2: number) => Math.max(0, s2 / n - (s / n) * (s / n));
  const stddev = Math.sqrt(
    Math.max(variance(sr, s2r), variance(sg, s2g), variance(sb, s2b)),
  );
  const matchFraction = match / n;
  return {
    opaque: matchFraction >= OPAQUE_MIN_FRACTION && stddev <= OPAQUE_MAX_STDDEV,
    matchFraction,
    stddev,
  };
}

/**
 * Snap Spark's rough panel box to the exact edit rectangle. Never use the
 * rough box as the edit rectangle directly — it routinely misses the true
 * panel edges by tens of px.
 *
 * Takes the dominant color inside the rough box (the panel fill, not the
 * text), flood-fills the connected region of that color starting near the
 * box center, and returns its exact bounding rectangle. The search starts
 * SEARCH_MARGIN px beyond the rough box and widens while the region touches
 * the window edge, so a rough box that undershoots still snaps exactly.
 */
export function snapPanel(
  imageRGBA: Uint8Array | Buffer,
  w: number,
  h: number,
  roughBox: PixelBox,
): PanelSnap {
  const rough = clampBox(roughBox, w, h);
  if (rough.w <= 0 || rough.h <= 0) {
    throw new PanelSnapError(`rough box ${JSON.stringify(roughBox)} is empty after clamping to ${w}x${h}`);
  }
  const fill = dominantColor(imageRGBA, w, rough);
  const seed = findSeed(imageRGBA, w, rough, fill);
  if (!seed) throw new PanelSnapError('no fill-colored pixel inside the rough box');

  let margin = SEARCH_MARGIN;
  let result: Flood | null = null;
  for (;;) {
    const win = clampBox(
      { x: rough.x - margin, y: rough.y - margin, w: rough.w + 2 * margin, h: rough.h + 2 * margin },
      w,
      h,
    );
    result = flood(imageRGBA, w, h, seed, fill, win);
    const fullFrame = win.x === 0 && win.y === 0 && win.w === w && win.h === h;
    if (!result.touchesEdge || fullFrame) break;
    margin += SEARCH_MARGIN;
  }
  const flooded = result as Flood;
  if (flooded.area === 0) throw new PanelSnapError('fill region is empty');
  if (flooded.area > 0.6 * w * h) {
    throw new PanelSnapError(`fill region covers ${(100 * (flooded.area / (w * h))).toFixed(1)}% of the frame — leaked outside the panel`);
  }
  const rect = maskBBox(flooded.mask, w, h);
  const radius = estimateRadius(imageRGBA, w, rect, fill);
  const textColor = estimateTextColor(imageRGBA, w, rect, fill);
  const { opaque, matchFraction, stddev } = checkOpaque(imageRGBA, w, rect, fill, radius);
  return { rect, fill, textColor, radius, opaque, matchFraction, fillStddev: stddev };
}
