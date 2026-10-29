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
