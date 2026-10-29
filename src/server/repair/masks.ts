import type OpenAI from 'openai';
import { buildBoxPromptText, segment } from '../models/sam.js';
import {
  countMaskInRect,
  dilateMask,
  maskArea,
  maskBoundingBox,
  unionMasks,
  type PixelBox,
} from '../../shared/geometry.js';

export interface ProtectionInput {
  imageBytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  sparkProductBox: PixelBox | null;
  sparkLogoBox: PixelBox | null;
  /**
   * Kill-test-only fallback geometry (labeled as "fixture geometry" when used).
   * Production callers omit this: with no Spark box and no phrase hit, the
   * mask stays empty and the repair is refused.
   */
  fallbackProductBox?: PixelBox;
  fallbackLogoBox?: PixelBox;
}

export interface ProtectionResult {
  product: Uint8Array;
  logo: Uint8Array;
  /** dilate(union(product, logo), 4) */
  protected: Uint8Array;
  blockers: string[];
  labels: { product: string; logo: string[] };
  latencyMs: number;
  calls: number;
}

export const PRODUCT_PHRASE = 'bottle';
export const LOGO_PHRASE = 'logo';
export const DILATE_PX = 4;
/** A protected mask whose fill inside its own bbox is below this is unusable. */
export const TINY_MASK_FILL = 0.2;

function usableBox(b: PixelBox | null | undefined): b is PixelBox {
  return !!b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.w > 0 && b.h > 0;
}

interface MaskCall {
  mask: Uint8Array;
  latencyMs: number;
}

async function phraseMask(
  client: OpenAI,
  input: ProtectionInput,
  phrase: string,
): Promise<MaskCall> {
  const seg = await segment(client, {
    imageBytes: input.imageBytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    model: input.model,
    inputText: phrase,
  });
  return { mask: seg.mask, latencyMs: seg.latencyMs };
}

async function boxMask(
  client: OpenAI,
  input: ProtectionInput,
  box: PixelBox,
): Promise<MaskCall> {
  const seg = await segment(client, {
    imageBytes: input.imageBytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    model: input.model,
    inputText: buildBoxPromptText(box, input.width, input.height),
  });
  return { mask: seg.mask, latencyMs: seg.latencyMs };
}

/**
 * Build the protected mask: SAM "bottle" for the product, and for the logo
 * the union of the "logo" phrase mask (circle mark) with a box prompt on
 * Spark's logo_bbox (the wordmark the phrase misses). `protected` is the
 * union dilated by 4 px. Empty/tiny results are blockers, never silent.
 */
export async function buildProtectedMask(
  client: OpenAI,
  input: ProtectionInput,
): Promise<ProtectionResult> {
  const { width, height } = input;
  let calls = 0;
  let latencyMs = 0;

  // Product: phrase first, box prompt when the phrase finds nothing.
  const productCall = await phraseMask(client, input, PRODUCT_PHRASE);
  calls++;
  latencyMs += productCall.latencyMs;
  let product = productCall.mask;
  let productLabel = `phrase "${PRODUCT_PHRASE}"`;
  const productBox = usableBox(input.sparkProductBox)
    ? { box: input.sparkProductBox, source: 'spark' as const }
    : usableBox(input.fallbackProductBox)
      ? { box: input.fallbackProductBox, source: 'fixture geometry' as const }
      : null;
  if (maskArea(product) === 0 && productBox) {
    const boxCall = await boxMask(client, input, productBox.box);
    calls++;
    latencyMs += boxCall.latencyMs;
    product = boxCall.mask;
    productLabel = `box from ${productBox.source} ${JSON.stringify(productBox.box)} (phrase empty)`;
  }

  // Logo: ALWAYS the union of phrase + box prompt (phrase sees the circle
  // mark only, not the wordmark).
  const logoCall = await phraseMask(client, input, LOGO_PHRASE);
  calls++;
  latencyMs += logoCall.latencyMs;
  let logo = logoCall.mask;
  const logoLabels = [`phrase "${LOGO_PHRASE}"`];
  const logoBox = usableBox(input.sparkLogoBox)
    ? { box: input.sparkLogoBox, source: 'spark' as const }
    : usableBox(input.fallbackLogoBox)
      ? { box: input.fallbackLogoBox, source: 'fixture geometry' as const }
      : null;
  if (logoBox) {
    const boxCall = await boxMask(client, input, logoBox.box);
    calls++;
    latencyMs += boxCall.latencyMs;
    logo = unionMasks(logo, boxCall.mask);
    logoLabels.push(`box from ${logoBox.source} ${JSON.stringify(logoBox.box)}`);
  }

  const prot = dilateMask(unionMasks(product, logo), width, height, DILATE_PX);
  const blockers = protectionBlockers(product, logo, width, height);

  return {
    product,
    logo,
    protected: prot,
    blockers,
    labels: { product: productLabel, logo: logoLabels },
    latencyMs,
    calls,
  };
}

/**
 * Quality gates for the two protection targets. Each target is judged on its
 * OWN bbox fill — never on the union bbox, which is inherently sparse when
 * product and logo sit far apart (the wordmark widens the logo bbox without
 * adding much area, and must not read as "tiny").
 */
export function protectionBlockers(
  product: Uint8Array,
  logo: Uint8Array,
  width: number,
  height: number,
): string[] {
  const blockers: string[] = [];
  if (maskArea(product) === 0 || maskArea(logo) === 0) {
    blockers.push('protected_mask_empty');
    return blockers;
  }
  for (const mask of [product, logo]) {
    const box = maskBoundingBox(mask, width, height);
    const fill = box ? maskArea(mask) / (box.w * box.h) : 0;
    if (fill < TINY_MASK_FILL) {
      blockers.push('protected_mask_tiny');
      return blockers;
    }
  }
  return blockers;
}

/** Pixels of the protected mask inside the edit rectangle (must be 0). */
export function protectedOverlapPx(
  prot: Uint8Array,
  width: number,
  height: number,
  rect: PixelBox,
): number {
  return countMaskInRect(prot, width, height, rect);
}
