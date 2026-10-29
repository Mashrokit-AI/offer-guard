import { stat } from 'node:fs/promises';
import sharp from 'sharp';

export interface GeneratedTestImage {
  path: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Generate the probe's synthetic test image: a 1080x1080 PNG with a solid
 * background and a centered rectangular "offer panel". No text yet.
 */
export async function generateProbeTestImage(outputPath: string): Promise<GeneratedTestImage> {
  const size = 1080;
  const panelWidth = 840;
  const panelHeight = 420;
  const panel = await sharp({
    create: {
      width: panelWidth,
      height: panelHeight,
      channels: 3,
      background: { r: 245, g: 240, b: 230 },
    },
  })
    .png()
    .toBuffer();
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 18, g: 60, b: 120 },
    },
  })
    .composite([
      {
        input: panel,
        left: Math.round((size - panelWidth) / 2),
        top: Math.round((size - panelHeight) / 2),
      },
    ])
    .png()
    .toFile(outputPath);
  const { size: bytes } = await stat(outputPath);
  return { path: outputPath, width: size, height: size, bytes };
}
