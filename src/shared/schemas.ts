import { z } from 'zod';

/**
 * Bounding box in source pixels, half-open: covers [x, x+w) x [y, y+h).
 * Coordinates are rounded to integers after model output; the schema accepts
 * any finite numbers so a slightly floaty model response still validates.
 */
export const bboxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite(),
  h: z.number().finite(),
});

export type BBox = z.infer<typeof bboxSchema>;

/** One piece of promotional/offer text, transcribed verbatim. */
export const offerTextSchema = z.object({
  text: z.string(),
  bbox: bboxSchema,
  in_panel: z.boolean(),
});

export type OfferText = z.infer<typeof offerTextSchema>;

export const discountSchema = z.object({
  percent: z.number().finite().nullable(),
  scope: z.enum(['all', 'selected_models', 'unspecified']),
  verbatim: z.string(),
});

export type DiscountClaim = z.infer<typeof discountSchema>;

export const shippingSchema = z.object({
  terms: z.enum(['free', 'paid', 'unspecified']),
  verbatim: z.string(),
});

export type ShippingClaim = z.infer<typeof shippingSchema>;

export const validUntilSchema = z.object({
  day_month: z
    .string()
    .regex(/^\d{2}\.\d{2}$/, 'day_month must look like DD.MM')
    .nullable(),
  verbatim: z.string(),
});

export type ValidUntilClaim = z.infer<typeof validUntilSchema>;

export const panelSchema = z.object({
  bbox: bboxSchema,
  opaque: z.boolean(),
});

export type PanelClaim = z.infer<typeof panelSchema>;

export const unreadableSchema = z.string();

export type UnreadableRegion = z.infer<typeof unreadableSchema>;

/**
 * AdClaims: everything Spark extracts from one ad image.
 * Deliberately NO confidence fields (ARCHITECTURE.md decision 6):
 * gating is evidence coverage + deterministic rules, never self-reported scores.
 * Unknown extra keys are stripped, not rejected, so a chatty model still validates.
 */
export const languageSchema = z.enum(['he', 'en']);

export type AdLanguage = z.infer<typeof languageSchema>;

export const adClaimsSchema = z.object({
  /** Language of the printed offer text in the image. */
  language: languageSchema,
  offer_texts: z.array(offerTextSchema),
  discount: discountSchema,
  shipping: shippingSchema,
  valid_until: validUntilSchema,
  panel: panelSchema.nullable(),
  product_bbox: bboxSchema.nullable(),
  logo_bbox: bboxSchema.nullable(),
  unreadable: z.array(unreadableSchema),
});

export type AdClaims = z.infer<typeof adClaimsSchema>;

/** One verbatim quote from a landing page, tied to visible-text chunk ids. */
export const pageQuoteSchema = z.object({
  text: z.string(),
  chunk_ids: z.array(z.string()),
});

export type PageQuote = z.infer<typeof pageQuoteSchema>;

/**
 * PageClaims: the same offer fields as AdClaims (minus geometry) plus quotes.
 * Every quote must verify as a substring of the stored visible text —
 * unverifiable quotes are dropped, never trusted.
 */
export const pageClaimsSchema = z.object({
  discount: discountSchema,
  shipping: shippingSchema,
  valid_until: validUntilSchema,
  quotes: z.array(pageQuoteSchema),
});

export type PageClaims = z.infer<typeof pageClaimsSchema>;
