import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Ground truth for the synthetic fixtures. Used ONLY by kill-test checks —
 * never sent to a model (checks run locally after the model responds).
 */
const boxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type GtBox = z.infer<typeof boxSchema>;

const adGroundTruthSchema = z.object({
  file: z.string(),
  language: z.enum(['he', 'en']),
  panel: z.object({
    bbox: boxSchema,
    opaque: z.boolean(),
    radius: z.number().optional(),
    alpha: z.number().optional(),
    note: z.string().optional(),
  }),
  offer_lines: z.array(z.string()),
  offer_must_contain: z.array(z.string()),
  discount: z.object({ percent: z.number(), scope: z.string() }),
  shipping: z.string(),
  valid_until: z.string(),
  product_bbox: boxSchema,
  logo_bbox: boxSchema,
  tagline: z.object({ text: z.string(), bbox: boxSchema }),
  tagline_forbidden_in_offers: z.array(z.string()),
});
export type AdGroundTruth = z.infer<typeof adGroundTruthSchema>;

const groundTruthSchema = z.object({
  frame: z.object({ width: z.number(), height: z.number() }),
  ads: z.record(adGroundTruthSchema),
});
export type GroundTruth = z.infer<typeof groundTruthSchema>;

export async function loadGroundTruth(repoRoot: string): Promise<GroundTruth> {
  const raw = await readFile(join(repoRoot, 'tests', 'fixtures', 'ground-truth.json'), 'utf8');
  return groundTruthSchema.parse(JSON.parse(raw));
}
