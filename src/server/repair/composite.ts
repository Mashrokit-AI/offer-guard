import sharp from 'sharp';
import type { PixelBox } from '../../shared/geometry.js';

export interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Decode any image to a canonical RGBA buffer (the proof's pixel space). */
export async function decodeRgba(bytes: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Composite the rendered panel PNG at the edit rectangle onto the source.
 * Output is a lossless PNG with the same dimensions as the source. The panel
 * PNG is exactly rect-sized with transparency outside the rounded corners,
 * so only rect pixels can change.
 */
export async function compositePanel(
  beforeBytes: Buffer,
  panelPng: Buffer,
  rect: PixelBox,
): Promise<Buffer> {
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  return sharp(beforeBytes)
    .composite([{ input: panelPng, left, top }])
    .png()
    .toBuffer();
}

export interface CompositeLayer {
  input: Buffer;
  left: number;
  top: number;
}

/** Composite layers in order onto a base image; output is a lossless PNG. */
export async function compositeLayers(base: Buffer, layers: CompositeLayer[]): Promise<Buffer> {
  return sharp(base)
    .composite(layers.map((l) => ({ input: l.input, left: Math.round(l.left), top: Math.round(l.top) })))
    .png()
    .toBuffer();
}

/**
 * Cut the masked element out of an RGBA image: tight crop + alpha from the
 * mask (255 inside, 0 outside). Returns the crop PNG and its source offset.
 */
export async function cutMaskedPng(
  rgba: RgbaImage,
  mask: Uint8Array,
): Promise<{ png: Buffer; x: number; y: number; w: number; h: number }> {
  const { width, height } = rgba;
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) throw new Error('cutMaskedPng: empty mask');
  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y1 + y) * width + (x1 + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = rgba.data[si] as number;
      out[di + 1] = rgba.data[si + 1] as number;
      out[di + 2] = rgba.data[si + 2] as number;
      out[di + 3] = mask[(y1 + y) * width + (x1 + x)] ? 255 : 0;
    }
  }
  const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { png, x: x1, y: y1, w, h };
}

/**
 * Resize/crop ANY input to the exact WxH with cover semantics (uniform scale,
 * center crop, no stretch), then verify the result is exactly WxH.
 * Muse Image returns the aspect ratio only — this is what makes it exact.
 */
export async function exactSize(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const out = await sharp(bytes).resize(width, height, { fit: 'cover', position: 'center' }).png().toBuffer();
  const meta = await sharp(out).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(`exactSize: expected ${width}x${height}, got ${meta.width}x${meta.height}`);
  }
  return out;
}

/**
 * Uniform-scale an RGBA cutout by `scale` with nearest-neighbor sampling, so
 * pasted pixels equal the source pixels after the recorded transform.
 */
export function scaleRgbaNearest(src: RgbaImage, scale: number): RgbaImage {
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = src.data[si] as number;
      data[di + 1] = src.data[si + 1] as number;
      data[di + 2] = src.data[si + 2] as number;
      data[di + 3] = src.data[si + 3] as number;
    }
  }
  return { data, width, height };
}

/**
 * Defringe a mask cutout's edge band (1-2 px): SAM masks often include a dark
 * halo of background pixels along the edge (seen as the stair-stepped dark
 * left edge of the GALI bottle). Every opaque pixel within `edgePx` of the
 * mask boundary gets its RGB replaced by the nearest interior opaque pixel
 * (search radius edgePx+4); alpha is untouched.
 *
 * Honesty note: the pixel proof erodes the core by `featherPx` before
 * comparing, so with featherPx >= edgePx the proof core is byte-identical to
 * the source and only the (reported, non-gated) feather ring is cleaned.
 */
export function defringeCut(src: RgbaImage, edgePx = 2): RgbaImage {
  const { width: w, height: h } = src;
  const opa = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) opa[i] = (src.data[i * 4 + 3] as number) > 0 ? 1 : 0;
  const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && opa[y * w + x] === 1;
  // Edge map, computed once: opaque within edgePx of a transparent pixel.
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      outer: for (let dy = -edgePx; dy <= edgePx; dy++) {
        for (let dx = -edgePx; dx <= edgePx; dx++) {
          if (!opaque(x + dx, y + dy)) {
            edge[y * w + x] = 1;
            break outer;
          }
        }
      }
    }
  }
  const data = Buffer.from(src.data);
  const R = edgePx + 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      // Nearest interior (non-edge) opaque pixel.
      let best = -1;
      let bestD = Infinity;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!opaque(nx, ny) || edge[ny * w + nx]) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = (ny * w + nx) * 4;
          }
        }
      }
      if (best >= 0) {
        const di = (y * w + x) * 4;
        data[di] = src.data[best] as number;
        data[di + 1] = src.data[best + 1] as number;
        data[di + 2] = src.data[best + 2] as number;
      }
    }
  }
  return { data, width: w, height: h };
}

export interface SupportPoint {
  /** Canvas-space center-x of the product's lowest opaque row. */
  cx: number;
  /** Canvas-space y of the lowest opaque row. */
  y: number;
  /** Width of the opaque run on that row (shadow width hint). */
  width: number;
}

/**
 * Lowest SUBSTANTIAL opaque row of a cutout in canvas space (the support
 * point). Rows narrower than ~8% of the cut width are stray mask pixels or
 * shadow remnants, never the product's footing — skipped (seen live as a
 * speck shadow under a stray pixel below the GALI bottle).
 */
export function supportPoint(cut: RgbaImage, left: number, top: number): SupportPoint | null {
  const minRun = Math.max(8, Math.round(cut.width * 0.08));
  for (let y = cut.height - 1; y >= 0; y--) {
    let x1 = -1;
    let x2 = -1;
    for (let x = 0; x < cut.width; x++) {
      if ((cut.data[(y * cut.width + x) * 4 + 3] as number) > 0) {
        if (x1 < 0) x1 = x;
        x2 = x;
      }
    }
    if (x1 >= 0 && x2 - x1 + 1 >= minRun) return { cx: left + (x1 + x2) / 2, y: top + y, width: x2 - x1 + 1 };
  }
  return null;
}

/**
 * Contact shadow in code: a soft dark ellipse under the product's actual
 * support point (lowest opaque pixels), drawn BEFORE the product is pasted.
 * Skipped for floating products (opts.floating) or implausible plate
 * lighting (opts.skip) — the caller decides, and the trace records it.
 */
export function drawContactShadow(
  canvas: RgbaImage,
  at: SupportPoint,
  opts: { liftPx?: number; strength?: number; floating?: boolean; skip?: boolean } = {},
): boolean {
  if (opts.floating || opts.skip) return false;
  const rx = Math.max(8, (at.width * 0.52) / 2);
  const ry = Math.max(5, Math.round(rx * 0.16));
  const cy = at.y + (opts.liftPx ?? 10);
  const strength = opts.strength ?? 0.28;
  const x0 = Math.max(0, Math.floor(at.cx - rx));
  const x1 = Math.min(canvas.width - 1, Math.ceil(at.cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(canvas.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - at.cx) / rx;
      const dy = (y - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const alpha = strength * (1 - d2) * (1 - d2);
      const di = (y * canvas.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        canvas.data[di + c] = Math.round((canvas.data[di + c] as number) * (1 - alpha));
      }
    }
  }
  return true;
}

/**
 * Paste an RGBA cutout onto an RGBA canvas at (left, top) with a soft 1-2 px
 * edge feather: alpha comes from the cutout, but the outermost 2 px ring of
 * the opaque core is feathered (linear ramp) to avoid hard seams. Pixels
 * strictly inside the eroded core are copied bit-identically.
 */
export function pasteWithFeather(canvas: RgbaImage, cut: RgbaImage, left: number, top: number, featherPx = 2): void {
  const { width: cw, height: ch } = canvas;
  const opaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < cut.width && y < cut.height && (cut.data[(y * cut.width + x) * 4 + 3] as number) > 0;
  for (let y = 0; y < cut.height; y++) {
    for (let x = 0; x < cut.width; x++) {
      if (!opaque(x, y)) continue;
      // Distance to the nearest transparent pixel (capped): the feather ramp.
      let d = featherPx + 1;
      for (let dy = -featherPx; dy <= featherPx && d > 1; dy++) {
        for (let dx = -featherPx; dx <= featherPx; dx++) {
          if (!opaque(x + dx, y + dy)) {
            d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
            if (d <= 1) break;
          }
        }
      }
      const alpha = d > featherPx ? 1 : d / (featherPx + 1);
      const cx = left + x;
      const cy = top + y;
      if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
      const si = (y * cut.width + x) * 4;
      const di = (cy * cw + cx) * 4;
      for (let c = 0; c < 3; c++) {
        canvas.data[di + c] = Math.round((cut.data[si + c] as number) * alpha + (canvas.data[di + c] as number) * (1 - alpha));
      }
      canvas.data[di + 3] = 255;
    }
  }
}
