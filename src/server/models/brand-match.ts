import type OpenAI from 'openai';
import { z } from 'zod';
import { structuredCall } from './spark.js';

const matchSchema = z.object({
  /** Index into the candidate brand list, or null when none matches. */
  brand_index: z.number().int().nullable(),
  reason: z.string(),
});

export type BrandMatch = z.infer<typeof matchSchema>;

const MATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    brand_index: { type: ['number', 'null'] },
    reason: { type: 'string' },
  },
  required: ['brand_index', 'reason'],
  additionalProperties: false,
};

export interface MatchCandidate {
  name: string;
  colors: string[];
  logoBytes: Buffer | null;
  logoMime: string;
}

/**
 * Propose which stored brand a source creative belongs to by comparing its
 * logo and colors to the candidates. The user can always override.
 */
export async function matchBrand(
  client: OpenAI,
  input: { imageBytes: Buffer; mimeType: string; model: string; candidates: MatchCandidate[] },
): Promise<BrandMatch> {
  if (input.candidates.length === 0) return { brand_index: null, reason: 'no brands stored' };
  const images = [{ imageBytes: input.imageBytes, mimeType: input.mimeType }];
  const desc = input.candidates.map((c, i) => {
    if (c.logoBytes) images.push({ imageBytes: c.logoBytes, mimeType: c.logoMime });
    return `- brand ${i} (${c.name}), colors ${c.colors.join(', ') || 'unknown'}${c.logoBytes ? ' — logo attached' : ''}`;
  });
  const { parsed } = await structuredCall(
    client,
    {
      model: input.model,
      system: 'You match an ad creative to a brand by its logo and colors. Reply with a single JSON object.',
      userText: `First image: the source creative. Following images: candidate brand logos in order.\nCandidates:\n${desc.join('\n')}\nWhich brand does the creative belong to? brand_index or null when none matches, plus a one-line reason.`,
      images,
      jsonSchema: MATCH_JSON_SCHEMA,
      schemaName: 'BrandMatch',
    },
    matchSchema,
  );
  if (parsed.brand_index !== null && (parsed.brand_index < 0 || parsed.brand_index >= input.candidates.length)) {
    return { brand_index: null, reason: 'model returned an out-of-range brand index' };
  }
  return parsed;
}
