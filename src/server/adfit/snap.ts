import type { RgbaImage } from '../repair/composite.js';
import type { PixelBox } from '../../shared/geometry.js';

function hex(r: number, g: number, b: number): string {
  const h = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Pixel-sampled panel fill: median color of a grid over the panel bbox,
 * IGNORING dark/light text outliers by taking the median (text pixels are a
 * minority). This is the color a rebuilt panel is filled with.
 */
export function samplePanelColor(rgba: RgbaImage, box: PixelBox): string {
  const x1 = Math.max(0, Math.min(rgba.width - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(rgba.height - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(rgba.width, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(rgba.height, Math.round(box.y + box.h)));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(x2 - x1, y2 - y1) / 24));
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const o = (y * rgba.width + x) * 4;
      rs.push(rgba.data[o] as number);
      gs.push(rgba.data[o + 1] as number);
      bs.push(rgba.data[o + 2] as number);
    }
  }
  const med = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 255;
  };
  return hex(med(rs), med(gs), med(bs));
}

/**
 * Panel complexity: per-channel standard deviation over the panel's BORDER
 * ring only (outer 12% — background, not text). A flat or gradient panel
 * scores low (rebuild it); photo texture or illustration scores high (paste
 * it, flagged when too small). Sampling the full box would mistake text for
 * texture (seen live: white type on flat orange scored "complex").
 * Threshold tuned on flat panels (~2-8) vs photographic regions (>40).
 */
export function panelComplexity(rgba: RgbaImage, box: PixelBox): { stdev: number; complex: boolean } {
  const x1 = Math.max(0, Math.min(rgba.width - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(rgba.height - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(rgba.width, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(rgba.height, Math.round(box.y + box.h)));
  const ring = Math.max(2, Math.round(Math.min(x2 - x1, y2 - y1) * 0.12));
  const vals: Array<[number, number, number]> = [];
  const step = Math.max(1, Math.floor(Math.min(x2 - x1, y2 - y1) / 24));
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const border = x < x1 + ring || x >= x2 - ring || y < y1 + ring || y >= y2 - ring;
      if (!border) continue;
      const o = (y * rgba.width + x) * 4;
      vals.push([rgba.data[o] as number, rgba.data[o + 1] as number, rgba.data[o + 2] as number]);
    }
  }
  if (vals.length === 0) return { stdev: 0, complex: false };
  const mean = [0, 1, 2].map((c) => vals.reduce((s, v) => s + (v[c] as number), 0) / vals.length);
  const variance =
    vals.reduce((s, v) => s + [0, 1, 2].reduce((t, c) => t + ((v[c] as number) - (mean[c] as number)) ** 2, 0), 0) /
    (vals.length * 3);
  const stdev = Math.sqrt(variance);
  return { stdev, complex: stdev > 28 };
}

/**
 * Snap a Spark panel bbox out to the panel's visual edges. Spark tends to fit
 * the text block, clipping the panel's padding (and with it, sub-line
 * bottoms). Corner-seeded flood fill on quantized color recovers the full
 * uniform region: seeds whose region does not touch the box center (text
 * glyphs, background) are discarded, and the union bbox of the rest is the
 * panel. Text inside the panel is harmless (holes don't move the bbox).
 * Expansion-only in effect; garbage in → original box out.
 */
export function snapPanelRect(rgba: RgbaImage, box: PixelBox): PixelBox {
  const { width: W, height: H } = rgba;
  const x1 = Math.max(0, Math.min(W - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(H - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(W, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(H, Math.round(box.y + box.h)));
  const cx = Math.floor((x1 + x2) / 2);
  const cy = Math.floor((y1 + y2) / 2);

  const quant = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return (((rgba.data[o] as number) >> 3) << 10) | (((rgba.data[o + 1] as number) >> 3) << 5) | ((rgba.data[o + 2] as number) >> 3);
  };
  const cap = Math.floor(W * H * 0.5);

  const flood = (sx: number, sy: number): PixelBox | null => {
    const target = quant(sx, sy);
    const seen = new Uint8Array(W * H);
    const stack: number[] = [sy * W + sx];
    seen[sy * W + sx] = 1;
    let minX = sx;
    let minY = sy;
    let maxX = sx;
    let maxY = sy;
    let n = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      n++;
      if (n > cap) return null; // Ran into the background: discard this seed.
      const x = i % W;
      const y = Math.floor(i / W);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[i - 1] && quant(x - 1, y) === target) {
        seen[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < W - 1 && !seen[i + 1] && quant(x + 1, y) === target) {
        seen[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && !seen[i - W] && quant(x, y - 1) === target) {
        seen[i - W] = 1;
        stack.push(i - W);
      }
      if (y < H - 1 && !seen[i + W] && quant(x, y + 1) === target) {
        seen[i + W] = 1;
        stack.push(i + W);
      }
    }
    // Keep regions whose bbox contains the box center (a text glyph's own
    // bbox rarely does; the panel's always does).
    if (!(minX <= cx && cx <= maxX && minY <= cy && cy <= maxY)) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };

  // 15 seeds across the box, INCLUDING its edge rows/columns: on a tight
  // box the surviving padding rows are exactly at the edges. Seeds that hit
  // the background flood into the cap and are discarded.
  const clamp = (x: number, y: number): [number, number] => [
    Math.max(0, Math.min(W - 1, x)),
    Math.max(0, Math.min(H - 1, y)),
  ];
  const mx = Math.floor((x1 + x2) / 2);
  const my = Math.floor((y1 + y2) / 2);
  const rows = [y1, y1 + 2, my, y2 - 3, y2 - 1];
  const cols = [x1, mx, x2 - 1];
  const seeds = rows.flatMap((y) => cols.map((x) => clamp(x, y)));
  const regions: PixelBox[] = [];
  for (const [sx, sy] of seeds) {
    const r = flood(sx, sy);
    if (r) regions.push(r);
  }
  if (regions.length === 0) return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  const ux1 = Math.min(...regions.map((r) => r.x));
  const uy1 = Math.min(...regions.map((r) => r.y));
  const ux2 = Math.max(...regions.map((r) => r.x + r.w));
  const uy2 = Math.max(...regions.map((r) => r.y + r.h));
  const snapped = { x: ux1, y: uy1, w: ux2 - ux1, h: uy2 - uy1 };
  // Sanity: the snap must cover the original center, overlap at least 40% of
  // the original box, and stay within 12x its area. Otherwise the floods ran
  // somewhere unexpected and the original box is the honest answer.
  const origArea = (x2 - x1) * (y2 - y1);
  const coversCenter = ux1 <= cx && cx <= ux2 && uy1 <= cy && cy <= uy2;
  const ix1 = Math.max(ux1, x1);
  const iy1 = Math.max(uy1, y1);
  const ix2 = Math.min(ux2, x2);
  const iy2 = Math.min(uy2, y2);
  const overlap = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (!coversCenter || overlap < origArea * 0.4 || snapped.w * snapped.h > origArea * 12) {
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return snapped;
}
